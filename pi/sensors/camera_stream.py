"""OptiFlow — camera + sparse Lucas-Kanade optical flow.

Serves:
  - MJPEG stream on HTTP port 8080 (/stream, /snapshot)
  - Flow vector data on WebSocket port 9002 (JSON)
  - FOV control via WebSocket command {"cmd": "set_fov", "fov": "standard"|"wide"}

Camera: Pi NoIR v3 (IMX708), mounted upside down (rotation handled on groundstation).
"""

import io
import json
import time
import asyncio
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

import cv2
import numpy as np
from picamera2 import Picamera2
import websockets

# --- Configuration ---
MJPEG_PORT = 8080
WS_PORT = 9002
FRAMERATE = 30

FOV_MODES = {
    "standard": {"size": (1920, 1080), "focal_mm": 4.74},
    "wide": {"size": (1920, 1080), "focal_mm": 2.75},
}

LK_PARAMS = dict(
    winSize=(21, 21),
    maxLevel=3,
    criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
)

FEATURE_PARAMS = dict(
    maxCorners=200,
    qualityLevel=0.05,
    minDistance=20,
    blockSize=7,
)

REDETECT_THRESHOLD = 50


# --- MJPEG streaming ---
class StreamingOutput(io.BufferedIOBase):
    def __init__(self):
        self.frame = None
        self.condition = threading.Condition()

    def write(self, buf):
        with self.condition:
            self.frame = buf
            self.condition.notify_all()
        return len(buf)


class MJPEGHandler(BaseHTTPRequestHandler):
    output = None

    def do_GET(self):
        if self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            try:
                while True:
                    with MJPEGHandler.output.condition:
                        MJPEGHandler.output.condition.wait()
                        frame = MJPEGHandler.output.frame
                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n')
                    self.wfile.write(f'Content-Length: {len(frame)}\r\n'.encode())
                    self.wfile.write(b'\r\n')
                    self.wfile.write(frame)
                    self.wfile.write(b'\r\n')
            except (BrokenPipeError, ConnectionResetError):
                pass

        elif self.path == '/snapshot':
            with MJPEGHandler.output.condition:
                MJPEGHandler.output.condition.wait()
                frame = MJPEGHandler.output.frame
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(frame)))
            self.end_headers()
            self.wfile.write(frame)

        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass


# --- OptiFlow engine ---
class OptiFlow:
    def __init__(self):
        self.prev_gray = None
        self.prev_pts = None
        self.position = np.array([0.0, 0.0])
        self.frame_count = 0
        self.keypoint_count = 0
        self.flow_vectors = []
        self.mean_flow = (0.0, 0.0)
        self.fov_mode = "standard"
        self.focal_mm = FOV_MODES["standard"]["focal_mm"]

    def process(self, frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        self.frame_count += 1

        if self.prev_gray is None:
            self.prev_gray = gray
            self.prev_pts = cv2.goodFeaturesToTrack(gray, **FEATURE_PARAMS)
            self.keypoint_count = len(self.prev_pts) if self.prev_pts is not None else 0
            return

        if self.prev_pts is None or len(self.prev_pts) < REDETECT_THRESHOLD:
            self.prev_pts = cv2.goodFeaturesToTrack(gray, **FEATURE_PARAMS)
            if self.prev_pts is None:
                self.prev_gray = gray
                self.keypoint_count = 0
                self.flow_vectors = []
                self.mean_flow = (0.0, 0.0)
                return

        next_pts, status, _ = cv2.calcOpticalFlowPyrLK(
            self.prev_gray, gray, self.prev_pts, None, **LK_PARAMS
        )

        if next_pts is None:
            self.prev_gray = gray
            self.prev_pts = cv2.goodFeaturesToTrack(gray, **FEATURE_PARAMS)
            return

        good_mask = status.flatten() == 1
        good_old = self.prev_pts[good_mask].reshape(-1, 2)
        good_new = next_pts[good_mask].reshape(-1, 2)

        self.keypoint_count = len(good_new)

        if self.keypoint_count > 0:
            flow = good_new - good_old
            self.mean_flow = (float(np.median(flow[:, 0])), float(np.median(flow[:, 1])))

            step = max(1, len(good_old) // 50)
            self.flow_vectors = [
                {
                    "x": float(good_old[i][0]),
                    "y": float(good_old[i][1]),
                    "dx": float(flow[i][0]),
                    "dy": float(flow[i][1]),
                }
                for i in range(0, len(good_old), step)
            ]

            self.position[0] += self.mean_flow[0]
            self.position[1] += self.mean_flow[1]
        else:
            self.mean_flow = (0.0, 0.0)
            self.flow_vectors = []

        self.prev_gray = gray
        self.prev_pts = good_new.reshape(-1, 1, 2) if self.keypoint_count > 0 else None

        if self.prev_pts is not None and len(self.prev_pts) < REDETECT_THRESHOLD:
            new_pts = cv2.goodFeaturesToTrack(gray, **FEATURE_PARAMS)
            if new_pts is not None:
                self.prev_pts = new_pts

    def get_state(self):
        return {
            "keypoints": self.keypoint_count,
            "mean_flow": self.mean_flow,
            "position": [float(self.position[0]), float(self.position[1])],
            "vectors": self.flow_vectors,
            "frame": self.frame_count,
            "fov": self.fov_mode,
            "timestamp": time.time(),
        }


# --- Globals ---
optiflow = OptiFlow()
latest_state = None
state_lock = threading.Lock()
fov_change_requested = None
fov_lock = threading.Lock()


# --- WebSocket server (runs in its own thread with its own event loop) ---
async def ws_handler(websocket):
    global fov_change_requested
    try:
        async for msg in websocket:
            try:
                cmd = json.loads(msg)
                if cmd.get("cmd") == "set_fov":
                    with fov_lock:
                        fov_change_requested = cmd.get("fov", "standard")
            except json.JSONDecodeError:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass


ws_clients = set()


async def register(websocket):
    ws_clients.add(websocket)
    try:
        await ws_handler(websocket)
    finally:
        ws_clients.discard(websocket)


async def broadcast_loop():
    while True:
        await asyncio.sleep(1 / FRAMERATE)
        with state_lock:
            state = latest_state
        if state is None or not ws_clients:
            continue
        msg = json.dumps(state)
        dead = set()
        for client in list(ws_clients):
            try:
                await client.send(msg)
            except websockets.exceptions.ConnectionClosed:
                dead.add(client)
        ws_clients -= dead


async def ws_main():
    async with websockets.serve(register, "0.0.0.0", WS_PORT):
        await broadcast_loop()


def run_ws_server():
    asyncio.run(ws_main())


# --- Main capture + processing loop ---
def main():
    global latest_state, fov_change_requested

    current_fov = "standard"
    mode = FOV_MODES[current_fov]

    picam2 = Picamera2()
    config = picam2.create_video_configuration(
        main={"size": mode["size"], "format": "RGB888"},
        controls={"FrameRate": FRAMERATE},
    )
    picam2.configure(config)
    picam2.start()

    mjpeg_output = StreamingOutput()
    MJPEGHandler.output = mjpeg_output

    http_server = HTTPServer(('0.0.0.0', MJPEG_PORT), MJPEGHandler)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    ws_thread = threading.Thread(target=run_ws_server, daemon=True)
    ws_thread.start()

    print(f"OptiFlow running:")
    print(f"  MJPEG:  http://0.0.0.0:{MJPEG_PORT}/stream")
    print(f"  WS:     ws://0.0.0.0:{WS_PORT}")
    print(f"  FOV:    {current_fov} ({mode['size'][0]}x{mode['size'][1]} @ {FRAMERATE}fps)")

    try:
        while True:
            with fov_lock:
                requested = fov_change_requested
                fov_change_requested = None

            if requested and requested != current_fov and requested in FOV_MODES:
                print(f"  Switching FOV: {current_fov} -> {requested}")
                picam2.stop()
                current_fov = requested
                mode = FOV_MODES[current_fov]
                config = picam2.create_video_configuration(
                    main={"size": mode["size"], "format": "RGB888"},
                    controls={"FrameRate": FRAMERATE},
                )
                picam2.configure(config)
                picam2.start()
                optiflow.fov_mode = current_fov
                optiflow.focal_mm = mode["focal_mm"]
                optiflow.prev_gray = None
                optiflow.prev_pts = None

            frame = picam2.capture_array()
            optiflow.process(frame)

            _, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            mjpeg_output.write(jpeg.tobytes())

            with state_lock:
                latest_state = optiflow.get_state()

    except KeyboardInterrupt:
        pass
    finally:
        picam2.stop()
        picam2.close()
        http_server.shutdown()
        print("OptiFlow stopped.")


if __name__ == '__main__':
    main()
