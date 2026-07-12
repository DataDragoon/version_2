"""Groundstation web application. Connects to Pi's WebSocket for data."""

import json
import threading
import argparse

import websocket
from flask import Flask, render_template
from flask_socketio import SocketIO

app = Flask(__name__, template_folder='ui/templates', static_folder='ui/static')
app.config['SECRET_KEY'] = 'dev'
socketio = SocketIO(app, cors_allowed_origins="*")

pi_host = None


def imu_bridge():
    """Connect to Pi's IMU WebSocket and forward to browser clients."""
    url = f"ws://{pi_host}:9001"
    print(f"Connecting to Pi IMU at {url}")

    def on_message(ws, msg):
        data = json.loads(msg)
        socketio.emit('imu_data', data)

    def on_error(ws, err):
        print(f"IMU bridge error: {err}")

    def on_close(ws, code, reason):
        print(f"IMU bridge disconnected, reconnecting in 2s...")
        import time
        time.sleep(2)
        start_ws()

    def start_ws():
        ws = websocket.WebSocketApp(url,
                                    on_message=on_message,
                                    on_error=on_error,
                                    on_close=on_close)
        ws.run_forever()

    start_ws()


@app.route('/')
def index():
    return render_template('index.html')


def main():
    global pi_host
    parser = argparse.ArgumentParser(description='Groundstation UI')
    parser.add_argument('--pi', required=True, help='Pi IP address or hostname')
    parser.add_argument('--port', type=int, default=5000, help='Web UI port (default: 5000)')
    args = parser.parse_args()

    pi_host = args.pi

    bridge_thread = threading.Thread(target=imu_bridge, daemon=True)
    bridge_thread.start()

    socketio.run(app, host='0.0.0.0', port=args.port, debug=True, allow_unsafe_werkzeug=True)


if __name__ == '__main__':
    main()
