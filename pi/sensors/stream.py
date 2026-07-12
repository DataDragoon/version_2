"""Hosts sensor data (IMU + LiDAR) over WebSocket."""

import asyncio
import json
import time
import argparse
import signal

import websockets

from mpu6500 import MPU6500
from tflc02 import TFLC02

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


async def sensor_loop(rate):
    imu = MPU6500()
    lidar = TFLC02()

    who = imu.who_am_i()
    if who not in (0x70, 0x71, 0x73):
        print(f"WARNING: IMU WHO_AM_I = 0x{who:02X}, expected 0x70/0x71")
    else:
        print(f"MPU-6500 detected (WHO_AM_I = 0x{who:02X})")

    print(f"TF-LC02 on {lidar.ser.port}")

    interval = 1.0 / rate
    print(f"Streaming sensors at {rate}Hz on ws://0.0.0.0:9001")

    try:
        while True:
            t0 = time.monotonic()

            imu_data = imu.read_all()

            dist = lidar.read_distance()

            packet = {
                'accel': imu_data['accel'],
                'gyro': imu_data['gyro'],
                'temp': imu_data['temp'],
                'lidar': dist,
                'timestamp': time.time(),
            }

            await broadcast(json.dumps(packet))
            elapsed = time.monotonic() - t0
            await asyncio.sleep(max(0, interval - elapsed))
    finally:
        imu.close()
        lidar.close()


async def main():
    parser = argparse.ArgumentParser(description='Host sensor data over WebSocket')
    parser.add_argument('--port', type=int, default=9001, help='WebSocket port (default: 9001)')
    parser.add_argument('--rate', type=int, default=50, help='Sample rate in Hz (default: 50)')
    args = parser.parse_args()

    stop = asyncio.get_event_loop().create_future()
    loop = asyncio.get_event_loop()
    loop.add_signal_handler(signal.SIGINT, stop.set_result, None)
    loop.add_signal_handler(signal.SIGTERM, stop.set_result, None)

    async with websockets.serve(register, '0.0.0.0', args.port):
        task = asyncio.create_task(sensor_loop(args.rate))
        await stop
        task.cancel()

    print("\nStopped.")


if __name__ == '__main__':
    asyncio.run(main())
