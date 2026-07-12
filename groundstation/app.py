"""Groundstation web application."""

import asyncio
import json
import socket
import threading

from flask import Flask, render_template
from flask_socketio import SocketIO

app = Flask(__name__, template_folder='ui/templates', static_folder='ui/static')
app.config['SECRET_KEY'] = 'dev'
socketio = SocketIO(app, cors_allowed_origins="*")

IMU_UDP_PORT = 9001


def imu_listener():
    """Listen for IMU UDP packets and forward to WebSocket clients."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('0.0.0.0', IMU_UDP_PORT))
    sock.settimeout(1.0)

    while True:
        try:
            data, addr = sock.recvfrom(1024)
            parsed = json.loads(data.decode())
            socketio.emit('imu_data', parsed)
        except socket.timeout:
            continue
        except Exception as e:
            print(f"IMU listener error: {e}")


@app.route('/')
def index():
    return render_template('index.html')


def main():
    listener_thread = threading.Thread(target=imu_listener, daemon=True)
    listener_thread.start()
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)


if __name__ == '__main__':
    main()
