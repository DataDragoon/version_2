"""MPU-6500 IMU driver over I2C."""

import struct
import time

try:
    import smbus2 as smbus
except ImportError:
    import smbus

MPU6500_ADDR = 0x68

# Registers
REG_PWR_MGMT_1 = 0x6B
REG_PWR_MGMT_2 = 0x6C
REG_SMPLRT_DIV = 0x19
REG_CONFIG = 0x1A
REG_GYRO_CONFIG = 0x1B
REG_ACCEL_CONFIG = 0x1C
REG_ACCEL_CONFIG2 = 0x1D
REG_ACCEL_XOUT_H = 0x3B
REG_GYRO_XOUT_H = 0x43
REG_TEMP_OUT_H = 0x41
REG_WHO_AM_I = 0x75

# Scale factors
ACCEL_SCALE = {0: 16384.0, 1: 8192.0, 2: 4096.0, 3: 2048.0}  # ±2g, ±4g, ±8g, ±16g
GYRO_SCALE = {0: 131.0, 1: 65.5, 2: 32.8, 3: 16.4}  # ±250, ±500, ±1000, ±2000 deg/s


class MPU6500:
    def __init__(self, bus_num=1, addr=MPU6500_ADDR, accel_range=0, gyro_range=0):
        self.bus = smbus.SMBus(bus_num)
        self.addr = addr
        self.accel_scale = ACCEL_SCALE[accel_range]
        self.gyro_scale = GYRO_SCALE[gyro_range]
        self._init_device(accel_range, gyro_range)

    def _init_device(self, accel_range, gyro_range):
        # Wake up (clear sleep bit), use best clock source
        self.bus.write_byte_data(self.addr, REG_PWR_MGMT_1, 0x01)
        time.sleep(0.1)

        # Sample rate divider: 1kHz / (1 + 4) = 200Hz
        self.bus.write_byte_data(self.addr, REG_SMPLRT_DIV, 0x04)

        # DLPF config: 41Hz bandwidth
        self.bus.write_byte_data(self.addr, REG_CONFIG, 0x03)

        # Gyro range
        self.bus.write_byte_data(self.addr, REG_GYRO_CONFIG, gyro_range << 3)

        # Accel range
        self.bus.write_byte_data(self.addr, REG_ACCEL_CONFIG, accel_range << 3)

        # Accel DLPF: 45Hz bandwidth
        self.bus.write_byte_data(self.addr, REG_ACCEL_CONFIG2, 0x03)

    def who_am_i(self):
        return self.bus.read_byte_data(self.addr, REG_WHO_AM_I)

    def _read_raw(self, reg, count=6):
        data = self.bus.read_i2c_block_data(self.addr, reg, count)
        values = []
        for i in range(0, count, 2):
            val = struct.unpack('>h', bytes(data[i:i+2]))[0]
            values.append(val)
        return values

    def read_accel(self):
        """Returns (ax, ay, az) in g."""
        raw = self._read_raw(REG_ACCEL_XOUT_H, 6)
        return tuple(v / self.accel_scale for v in raw)

    def read_gyro(self):
        """Returns (gx, gy, gz) in deg/s."""
        raw = self._read_raw(REG_GYRO_XOUT_H, 6)
        return tuple(v / self.gyro_scale for v in raw)

    def read_temp(self):
        """Returns temperature in °C."""
        raw = self._read_raw(REG_TEMP_OUT_H, 2)
        return raw[0] / 333.87 + 21.0

    def read_all(self):
        """Read accel + temp + gyro in one burst (14 bytes from 0x3B)."""
        data = self.bus.read_i2c_block_data(self.addr, REG_ACCEL_XOUT_H, 14)
        vals = []
        for i in range(0, 14, 2):
            vals.append(struct.unpack('>h', bytes(data[i:i+2]))[0])

        ax, ay, az = [v / self.accel_scale for v in vals[0:3]]
        temp = vals[3] / 333.87 + 21.0
        gx, gy, gz = [v / self.gyro_scale for v in vals[4:7]]

        return {
            'accel': (ax, ay, az),
            'gyro': (gx, gy, gz),
            'temp': temp,
        }

    def close(self):
        self.bus.close()
