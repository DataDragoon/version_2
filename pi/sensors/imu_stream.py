"""Streams MPU-6500 data to groundstation over UDP."""

import json
import socket
import time
import argparse

from mpu6500 import MPU6500


def main():
    parser = argparse.ArgumentParser(description='Stream IMU data to groundstation')
    parser.add_argument('--host', default='255.255.255.255', help='Groundstation IP (default: broadcast)')
    parser.add_argument('--port', type=int, default=9001, help='UDP port (default: 9001)')
    parser.add_argument('--rate', type=int, default=50, help='Sample rate in Hz (default: 50)')
    args = parser.parse_args()

    imu = MPU6500()

    who = imu.who_am_i()
    if who not in (0x70, 0x71, 0x73):
        print(f"WARNING: WHO_AM_I = 0x{who:02X}, expected 0x70/0x71 for MPU-6500")
    else:
        print(f"MPU-6500 detected (WHO_AM_I = 0x{who:02X})")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)

    interval = 1.0 / args.rate
    print(f"Streaming at {args.rate}Hz to {args.host}:{args.port}")

    try:
        while True:
            t0 = time.monotonic()
            data = imu.read_all()
            data['timestamp'] = time.time()

            packet = json.dumps(data).encode()
            sock.sendto(packet, (args.host, args.port))

            elapsed = time.monotonic() - t0
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        imu.close()
        sock.close()


if __name__ == '__main__':
    main()
