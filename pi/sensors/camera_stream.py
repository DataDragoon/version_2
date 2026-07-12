"""MJPEG stream server for Pi NoIR v3 camera.

Serves a standard MJPEG stream over HTTP on port 8080.
Browser connects with <img src="http://pi-ip:8080/stream">.
"""

import io
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

from picamera2 import Picamera2
from picamera2.encoders import MJPEGEncoder
from picamera2.outputs import FileOutput

STREAM_PORT = 8080
RESOLUTION = (1920, 1080)
FRAMERATE = 30


class StreamingOutput(io.BufferedIOBase):
    """Thread-safe buffer that holds the latest JPEG frame."""

    def __init__(self):
        self.frame = None
        self.condition = threading.Condition()

    def write(self, buf):
        with self.condition:
            self.frame = buf
            self.condition.notify_all()
        return len(buf)


class StreamHandler(BaseHTTPRequestHandler):
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
                    with StreamHandler.output.condition:
                        StreamHandler.output.condition.wait()
                        frame = StreamHandler.output.frame
                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n')
                    self.wfile.write(f'Content-Length: {len(frame)}\r\n'.encode())
                    self.wfile.write(b'\r\n')
                    self.wfile.write(frame)
                    self.wfile.write(b'\r\n')
            except (BrokenPipeError, ConnectionResetError):
                pass

        elif self.path == '/snapshot':
            with StreamHandler.output.condition:
                StreamHandler.output.condition.wait()
                frame = StreamHandler.output.frame
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(frame)))
            self.end_headers()
            self.wfile.write(frame)

        elif self.path == '/status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"camera":"running"}')

        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass


def main():
    picam2 = Picamera2()
    config = picam2.create_video_configuration(
        main={"size": RESOLUTION, "format": "RGB888"},
        controls={"FrameRate": FRAMERATE},
    )
    picam2.configure(config)

    output = StreamingOutput()
    StreamHandler.output = output

    encoder = MJPEGEncoder()
    picam2.start_recording(encoder, FileOutput(output))

    print(f"Camera stream on port {STREAM_PORT} ({RESOLUTION[0]}x{RESOLUTION[1]} @ {FRAMERATE}fps)")
    print(f"  Stream:   http://0.0.0.0:{STREAM_PORT}/stream")
    print(f"  Snapshot: http://0.0.0.0:{STREAM_PORT}/snapshot")

    server = HTTPServer(('0.0.0.0', STREAM_PORT), StreamHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        picam2.stop_recording()
        picam2.close()
        server.server_close()
        print("Camera stopped.")


if __name__ == '__main__':
    main()
