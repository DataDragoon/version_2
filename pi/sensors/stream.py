"""Hosts sensor data (IMU + LiDAR) over WebSocket."""

import asyncio
import json
import time
import argparse
import signal

import websockets

from bno085 import BNO085
from tflc02 import TFLC02
from imu_calibration import CalibratedIMU

clients = set()


async def register(ws):
    clients.add(ws)
    try:
        await ws.wait_closed()
    finally:
        clients.discard(ws)


async def broadcast(msg):
    if clients:
        await asyncio.gather(*(c.send(msg) for c in clients), return_exceptions=True)


async def imu_poll_loop(imu, state):
    """Reads the IMU in its own uncapped loop, publishing the latest reading into
    `state`. Runs via run_in_executor so the blocking driver call never stalls the
    event loop -- see lidar_poll_loop for why this matters."""
    loop = asyncio.get_running_loop()
    fail_streak = 0
    IMU_FAIL_LIMIT = 20
    while True:
        try:
            body = await loop.run_in_executor(None, imu.read_body)
            state['accel'] = body['accel'].tolist()
            state['gyro'] = body['gyro'].tolist()
            state['temp'] = body['temp']
            fail_streak = 0
        except Exception as e:
            fail_streak += 1
            if fail_streak == 1:
                print(f"WARNING: IMU read failed ({e!r}), streaming IMU as null")
            state['accel'] = state['gyro'] = state['temp'] = None
            if fail_streak >= IMU_FAIL_LIMIT:
                print(f"IMU failed {IMU_FAIL_LIMIT} reads in a row, giving up on it")
                return


async def lidar_poll_loop(lidar, state):
    """Reads the LiDAR in its own uncapped loop, publishing the latest reading into
    `state`. This is deliberately NOT awaited inline in sensor_loop's broadcast
    loop: TFLC02.read_distance() blocks on a 100ms UART timeout whenever the
    sensor doesn't answer, which happened to be true throughout the 2026-08-24
    debugging above. Awaiting it directly in the broadcast loop caps the whole
    stream (IMU included) at ~10Hz regardless of `rate` -- confirmed by timing
    read_distance() in isolation. Running it here, in its own task via
    run_in_executor, means a slow or dead LiDAR only slows *this* loop; the
    broadcast loop below keeps running at its full requested rate using
    whatever LiDAR reading was most recently published, stale or not."""
    loop = asyncio.get_running_loop()
    fail_streak = 0
    while True:
        try:
            state['dist'] = await loop.run_in_executor(None, lidar.read_distance)
            fail_streak = 0
        except Exception as e:
            fail_streak += 1
            if fail_streak == 1:
                print(f"WARNING: LiDAR read failed ({e!r})")
            state['dist'] = None


async def sensor_loop(rate, skip_cal=False):
    lidar = TFLC02()

    imu = None
    try:
        raw_imu = BNO085()
        print(f"BNO085 detected (part number {raw_imu.who_am_i()})")
        imu = CalibratedIMU(raw_imu, auto_calibrate=not skip_cal)
    except Exception as e:
        print(f"WARNING: IMU init failed ({e!r}), streaming without IMU")

    print(f"TF-LC02 on {lidar.ser.port}")

    interval = 1.0 / rate
    print(f"Streaming sensors at {rate}Hz on ws://0.0.0.0:9001")

    imu_state = {'accel': None, 'gyro': None, 'temp': None}
    lidar_state = {'dist': None}
    poll_tasks = [asyncio.create_task(lidar_poll_loop(lidar, lidar_state))]
    if imu is not None:
        poll_tasks.append(asyncio.create_task(imu_poll_loop(imu, imu_state)))

    try:
        while True:
            t0 = time.monotonic()

            packet = {
                'accel': imu_state['accel'],
                'gyro': imu_state['gyro'],
                'temp': imu_state['temp'],
                'lidar': lidar_state['dist'],
                'timestamp': time.time(),
            }

            await broadcast(json.dumps(packet))
            elapsed = time.monotonic() - t0
            await asyncio.sleep(max(0, interval - elapsed))
    finally:
        for t in poll_tasks:
            t.cancel()
        for t in poll_tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        if imu is not None:
            try:
                imu.close()
            except Exception:
                pass
        lidar.close()


async def main():
    parser = argparse.ArgumentParser(description='Host sensor data over WebSocket')
    parser.add_argument('--port', type=int, default=9001, help='WebSocket port (default: 9001)')
    parser.add_argument('--rate', type=int, default=50, help='Sample rate in Hz (default: 50)')
    parser.add_argument('--skip-cal', action='store_true', help='Skip gyro calibration (use saved)')
    args = parser.parse_args()

    stop = asyncio.get_event_loop().create_future()
    loop = asyncio.get_event_loop()

    def request_stop():
        # SIGINT (Ctrl-C, propagated to the whole process group) and SIGTERM
        # (start.py forwarding to this child) routinely both arrive — resolving
        # an already-done future raises InvalidStateError, so guard it.
        if not stop.done():
            stop.set_result(None)

    loop.add_signal_handler(signal.SIGINT, request_stop)
    loop.add_signal_handler(signal.SIGTERM, request_stop)

    def log_task_exception(t):
        if not t.cancelled() and t.exception() is not None:
            print(f"sensor_loop crashed: {t.exception()!r}")
            request_stop()

    async with websockets.serve(register, '0.0.0.0', args.port):
        task = asyncio.create_task(sensor_loop(args.rate, skip_cal=args.skip_cal))
        task.add_done_callback(log_task_exception)
        await stop
        task.cancel()

    print("\nStopped.")


if __name__ == '__main__':
    asyncio.run(main())
