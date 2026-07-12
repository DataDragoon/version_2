"""Single entry point for all Pi services."""

import subprocess
import sys
import os
import signal

procs = []


def cleanup(sig, frame):
    for p in procs:
        p.terminate()
    for p in procs:
        p.wait()
    sys.exit(0)


signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

base = os.path.dirname(os.path.abspath(__file__))

services = [
    [sys.executable, os.path.join(base, 'sensors', 'imu_stream.py')],
]

print(f"Starting {len(services)} service(s)...")

for cmd in services:
    print(f"  → {os.path.basename(cmd[-1])}")
    procs.append(subprocess.Popen(cmd))

for p in procs:
    p.wait()
