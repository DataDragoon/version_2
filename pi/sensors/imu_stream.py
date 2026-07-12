"""Hosts IMU data over WebSocket. Groundstation connects to Pi."""

import asyncio
import json
import time
import argparse
import signal

import websockets

from mpu6500 import MPU6500

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


async def imu_loop(rate):
    imu = MPU6500()

    who = imu.who_am_i()
    if who not in (0x70, 0x71, 0x73):
        print(f"WARNING: WHO_AM_I = 0x{who:02X}, expected 0x70/0x71 for MPU-6500")
    else:
        print(f"MPU-6500 detected (WHO_AM_I = 0x{who:02X})")

    interval = 1.0 / rate
    print(f"Serving IMU at {rate}Hz on ws://0.0.0.0:9001")

    try:
        while True:
            t0 = time.monotonic()
            data = imu.read_all()
            data['timestamp'] = time.time()
            await broadcast(json.dumps(data))
            elapsed = time.monotonic() - t0
            await asyncio.sleep(max(0, interval - elapsed))
    finally:
        imu.close()


async def main():
    parser = argparse.ArgumentParser(description='Host IMU data over WebSocket')
    parser.add_argument('--port', type=int, default=9001, help='WebSocket port (default: 9001)')
    parser.add_argument('--rate', type=int, default=50, help='Sample rate in Hz (default: 50)')
    args = parser.parse_args()

    stop = asyncio.get_event_loop().create_future()
    loop = asyncio.get_event_loop()
    loop.add_signal_handler(signal.SIGINT, stop.set_result, None)
    loop.add_signal_handler(signal.SIGTERM, stop.set_result, None)

    async with websockets.serve(register, '0.0.0.0', args.port):
        imu_task = asyncio.create_task(imu_loop(args.rate))
        await stop
        imu_task.cancel()

    print("\nStopped.")


if __name__ == '__main__':
    asyncio.run(main())
