"""Single entry point for all Pi services."""

import subprocess
import sys
import os
import signal

base = os.path.dirname(os.path.abspath(__file__))
requirements = os.path.join(base, 'requirements.txt')

print("Installing dependencies...")
subprocess.check_call(['sudo', 'apt-get', 'install', '-y', '-qq', 'python3-pip'],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q',
                       '--break-system-packages', '-r', requirements])

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
    [sys.executable, os.path.join(base, 'sensors', 'stream.py')],
]

print(f"Starting {len(services)} service(s)...")

for cmd in services:
    print(f"  → {os.path.basename(cmd[-1])}")
    procs.append(subprocess.Popen(cmd))

for p in procs:
    p.wait()
