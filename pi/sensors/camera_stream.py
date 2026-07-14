"""OptiFlow — camera + sparse Lucas-Kanade optical flow with gyro compensation.

Serves:
  - MJPEG stream on HTTP port 8080 (/stream, /snapshot)
  - Flow vector data on WebSocket port 9002 (JSON)

Camera: Pi NoIR v3 (IMX708), standard lens (4.74mm f/1.8).
Mounted upside down (rotation handled on groundstation).
"""

import io
import os
import json
import time
import asyncio
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

import cv2
import numpy as np
from picamera2 import Picamera2
import websockets

from mpu6500 import MPU6500
from imu_calibration import CalibratedIMU

MJPEG_PORT = 8080
WS_PORT = 9002
RESOLUTION = (1536, 864)
FRAMERATE = 60
FOCAL_MM = 4.74

# Focal length in pixels (for gyro → pixel conversion)
# f_px = (diag_px / 2) / tan(dfov / 2), dfov=75deg
F_PX = 1148.0

LK_PARAMS = dict(
    winSize=(15, 15),
    maxLevel=2,
    criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.01),
)

FEATURE_PARAMS = dict(
    maxCorners=150,
    qualityLevel=0.1,
    minDistance=15,
    blockSize=7,
)

REDETECT_THRESHOLD = 50


class GyroAccumulator:
    """Reads IMU at high rate in a thread, accumulates rotation between consume() calls."""

    def __init__(self):
        self._lock = threading.Lock()
        self._accumulated = np.array([0.0, 0.0, 0.0])  # [roll, pitch, yaw] in degrees
        self._running = False
        self._thread = None
        self._imu = None

    def start(self):
        from imu_calibration import CONFIG_PATH
        # Wait for stream.py to finish calibration and write the config
        print("GyroAccumulator: waiting for IMU calibration file...")
        for _ in range(50):  # up to 5 seconds
            if os.path.exists(CONFIG_PATH):
                break
            time.sleep(0.1)
        raw_imu = MPU6500()
        self._imu = CalibratedIMU(raw_imu, auto_calibrate=False)
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        print("GyroAccumulator: running")

    def _loop(self):
        last_t = time.monotonic()
        while self._running:
            data = self._imu.read_body()
            now = time.monotonic()
            dt = now - last_t
            last_t = now
            if 0 < dt < 0.1:
                gyro = data['gyro']  # [roll, pitch, yaw] deg/s
                with self._lock:
                    self._accumulated += gyro * dt
            time.sleep(0.002)  # ~500Hz sampling

    def consume(self):
        """Return accumulated rotation since last consume() and reset."""
        with self._lock:
            val = self._accumulated.copy()
            self._accumulated[:] = 0.0
        return val  # [roll_deg, pitch_deg, yaw_deg]

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=1)
        if self._imu:
            self._imu.close()


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


class OptiFlow:
    def __init__(self):
        self.prev_gray = None
        self.prev_pts = None
        self.position = np.array([0.0, 0.0])
        self.frame_count = 0
        self.keypoint_count = 0
        self.flow_vectors = []
        self.mean_flow = (0.0, 0.0)
        self.gyro_comp_px = (0.0, 0.0)
        self.gyro_comp_enabled = True
        self.fps = 0.0
        self._last_time = time.time()
        self._frame_times = []

    def process(self, gray, gyro_rotation_deg=None):
        """Process a frame. gyro_rotation_deg is [roll, pitch, yaw] accumulated since last frame."""
        now = time.time()
        self._frame_times.append(now)
        self._frame_times = self._frame_times[-30:]
        if len(self._frame_times) > 1:
            elapsed = self._frame_times[-1] - self._frame_times[0]
            self.fps = (len(self._frame_times) - 1) / elapsed if elapsed > 0 else 0

        self.frame_count += 1

        # Convert gyro rotation to expected pixel shift in the raw (upside-down) image.
        # Upside-down: image X = real-world left, image Y = real-world up.
        # Yaw right → scene shifts right in raw image → positive flow X
        # Pitch up → scene shifts up in raw image → negative flow Y
        gyro_px = np.array([0.0, 0.0])
        if gyro_rotation_deg is not None and self.gyro_comp_enabled:
            roll_deg, pitch_deg, yaw_deg = gyro_rotation_deg
            deg2rad = np.pi / 180.0
            gyro_px[0] = yaw_deg * F_PX * deg2rad
            gyro_px[1] = -pitch_deg * F_PX * deg2rad
        self.gyro_comp_px = (float(gyro_px[0]), float(gyro_px[1]))

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

            # Subtract gyro-predicted rotation from flow → residual is translation
            flow_compensated = flow - gyro_px

            # Outlier rejection on compensated flow
            mag = np.sqrt(flow_compensated[:, 0] ** 2 + flow_compensated[:, 1] ** 2)
            med_mag = np.median(mag)
            inlier_mask = mag < max(med_mag * 2.5, 1.0)

            good_old = good_old[inlier_mask]
            good_new = good_new[inlier_mask]
            flow = flow[inlier_mask]
            flow_compensated = flow_compensated[inlier_mask]
            self.keypoint_count = len(good_new)

            if self.keypoint_count > 0:
                self.mean_flow = (
                    float(np.median(flow_compensated[:, 0])),
                    float(np.median(flow_compensated[:, 1])),
                )

                step = max(1, len(good_old) // 50)
                self.flow_vectors = [
                    {
                        "x": float(good_old[i][0]),
                        "y": float(good_old[i][1]),
                        "dx": float(flow_compensated[i][0]),
                        "dy": float(flow_compensated[i][1]),
                    }
                    for i in range(0, len(good_old), step)
                ]

                self.position[0] += self.mean_flow[0]
                self.position[1] += self.mean_flow[1]
            else:
                self.mean_flow = (0.0, 0.0)
                self.flow_vectors = []
        else:
            self.mean_flow = (0.0, 0.0)
            self.flow_vectors = []

        self.prev_gray = gray
        self.prev_pts = good_new.reshape(-1, 1, 2) if len(good_new) > 0 else None

    def reset_position(self):
        self.position = np.array([0.0, 0.0])

    def get_state(self):
        return {
            "keypoints": self.keypoint_count,
            "mean_flow": self.mean_flow,
            "position": [float(self.position[0]), float(self.position[1])],
            "vectors": self.flow_vectors,
            "frame": self.frame_count,
            "fps": round(self.fps, 1),
            "gyro_comp": self.gyro_comp_enabled,
            "gyro_px": self.gyro_comp_px,
            "timestamp": time.time(),
        }


optiflow = OptiFlow()
latest_state = None
state_lock = threading.Lock()
ws_clients = set()


async def ws_handler(websocket):
    try:
        async for msg in websocket:
            try:
                cmd = json.loads(msg)
                if cmd.get("cmd") == "reset_origin":
                    optiflow.reset_position()
                elif cmd.get("cmd") == "gyro_comp":
                    optiflow.gyro_comp_enabled = bool(cmd.get("enabled", True))
            except (json.JSONDecodeError, AttributeError):
                pass
    except websockets.exceptions.ConnectionClosed:
        pass


async def register(websocket):
    global ws_clients
    ws_clients.add(websocket)
    try:
        await ws_handler(websocket)
    finally:
        ws_clients.discard(websocket)


async def broadcast_loop():
    global ws_clients
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


def main():
    global latest_state

    gyro = GyroAccumulator()
    gyro.start()

    picam2 = Picamera2()
    config = picam2.create_video_configuration(
        main={"size": RESOLUTION, "format": "YUV420"},
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
    print(f"  {RESOLUTION[0]}x{RESOLUTION[1]} @ {FRAMERATE}fps, focal {FOCAL_MM}mm")
    print(f"  Gyro compensation: enabled")

    try:
        while True:
            frame = picam2.capture_array()
            gray = frame[:RESOLUTION[1], :RESOLUTION[0]]

            rotation = gyro.consume()
            optiflow.process(gray, gyro_rotation_deg=rotation)

            _, jpeg = cv2.imencode('.jpg', gray, [cv2.IMWRITE_JPEG_QUALITY, 80])
            mjpeg_output.write(jpeg.tobytes())

            with state_lock:
                latest_state = optiflow.get_state()

    except KeyboardInterrupt:
        pass
    finally:
        gyro.stop()
        picam2.stop()
        picam2.close()
        http_server.shutdown()
        print("OptiFlow stopped.")


if __name__ == '__main__':
    main()
