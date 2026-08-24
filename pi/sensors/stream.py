"""Hosts sensor data (IMU + LiDAR) over WebSocket."""

import asyncio
import json
import time
import argparse
import signal

import websockets

from mpu6500 import MPU6500
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
        raw_imu = MPU6500()
        who = raw_imu.who_am_i()
        if who not in (0x70, 0x71, 0x73):
            print(f"WARNING: IMU WHO_AM_I = 0x{who:02X}, expected 0x70/0x71")
        else:
            print(f"MPU-6500 detected (WHO_AM_I = 0x{who:02X})")
        imu = CalibratedIMU(raw_imu, auto_calibrate=not skip_cal)
    except Exception as e:
        print(f"WARNING: IMU init failed ({e!r}), streaming without IMU")

    print(f"TF-LC02 on {lidar.ser.port}")

    interval = 1.0 / rate
    print(f"Streaming sensors at {rate}Hz on ws://0.0.0.0:9001")

    try:
        while True:
            t0 = time.monotonic()

            if imu is not None:
                body = imu.read_body()
                accel, gyro, temp = body['accel'].tolist(), body['gyro'].tolist(), body['temp']
            else:
                accel = gyro = temp = None

            dist = lidar.read_distance()

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
            imu.close()
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
