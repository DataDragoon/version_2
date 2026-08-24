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

    # An IMU that enumerates at startup can still drop off the I2C bus later
    # (loose wire, brownout) -- read_i2c_block_data then raises OSError 121 on
    # every iteration. Unguarded that kills sensor_loop and takes the LiDAR
    # stream down with it, which is exactly the failure mode the init-time
    # try/except above exists to prevent. Guard the read too, and stop touching
    # the bus once it is clearly gone (each failing read costs an I2C timeout,
    # which would otherwise throttle the LiDAR rate).
    imu_ok = imu is not None
    imu_fail_streak = 0
    IMU_FAIL_LIMIT = 20

    try:
        while True:
            t0 = time.monotonic()

            accel = gyro = temp = None
            if imu_ok:
                try:
                    body = imu.read_body()
                    accel, gyro, temp = body['accel'].tolist(), body['gyro'].tolist(), body['temp']
                    imu_fail_streak = 0
                except Exception as e:
                    imu_fail_streak += 1
                    if imu_fail_streak == 1:
                        print(f"WARNING: IMU read failed ({e!r}), streaming IMU as null")
                    if imu_fail_streak >= IMU_FAIL_LIMIT:
                        print(f"IMU failed {IMU_FAIL_LIMIT} reads in a row, giving up on it; LiDAR continues")
                        imu_ok = False

            try:
                dist = lidar.read_distance()
            except Exception as e:
                print(f"WARNING: LiDAR read failed ({e!r})")
                dist = None

            packet = {
                'accel': accel,
                'gyro': gyro,
                'temp': temp,
                'lidar': dist,
                'timestamp': time.time(),
            }

            await broadcast(json.dumps(packet))
            elapsed = time.monotonic() - t0
            await asyncio.sleep(max(0, interval - elapsed))
    finally:
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
