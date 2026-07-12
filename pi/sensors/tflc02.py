"""TF-LC02 LiDAR driver over UART."""

import serial
import struct

FRAME_HEADER = 0x5A
FRAME_LENGTH = 6


class TFLC02:
    def __init__(self, port='/dev/serial0', baudrate=115200):
        self.ser = serial.Serial(port, baudrate=baudrate, timeout=0.1)
        self.ser.reset_input_buffer()

    def read_distance(self):
        """Read one distance measurement. Returns distance in mm, or None on error."""
        # Sync to frame header
        while True:
            b = self.ser.read(1)
            if not b:
                return None
            if b[0] == FRAME_HEADER:
                rest = self.ser.read(FRAME_LENGTH - 1)
                if len(rest) < FRAME_LENGTH - 1:
                    return None
                frame = bytes([FRAME_HEADER]) + rest
                return self._parse_frame(frame)

    def _parse_frame(self, frame):
        """Parse TF-LC02 frame: [0x5A, len, dist_lo, dist_hi, strength_lo, strength_hi]"""
        if len(frame) < FRAME_LENGTH:
            return None
        dist = frame[2] | (frame[3] << 8)
        return dist

    def read_strength(self):
        """Read distance + signal strength. Returns (distance_mm, strength) or None."""
        while True:
            b = self.ser.read(1)
            if not b:
                return None
            if b[0] == FRAME_HEADER:
                rest = self.ser.read(FRAME_LENGTH - 1)
                if len(rest) < FRAME_LENGTH - 1:
                    return None
                frame = bytes([FRAME_HEADER]) + rest
                dist = frame[2] | (frame[3] << 8)
                strength = frame[4] | (frame[5] << 8)
                return (dist, strength)

    def close(self):
        self.ser.close()
