"""IMU calibration: bias estimation and axis remapping.

Original calibration discovery results (measured on the MPU-6500):
  Gravity when level: accel +X = +1g  -> IMU +X = physical UP
  Roll right:  gyro +Z (+70.6 deg)    -> IMU Z = roll/forward axis
  Pitch down:  gyro -Y (-40.1 deg)    -> IMU Y = pitch/left axis
  Yaw right:   gyro -X (-84.7 deg)    -> IMU X = yaw/up axis

Body frame (right-hand):
  Body X = FORWARD, Body Y = LEFT, Body Z = UP

BNO085 remap (2026-08-24): the BNO085 sits rotated ~90 deg about the forward/roll
axis relative to how the MPU-6500 was mounted. Confirmed empirically: board flat on
the bench, BNO085 raw gravity lands on +Y (~0.98g), not +X like the MPU-6500 -- and
live rotation testing showed pitch motion reading out as yaw and vice versa. Forward
(Z) and roll are unaffected -- rotating a sensor about its own axis doesn't change
what that axis measures. So X and Y swap roles (left<->up, pitch<->yaw) below; Z
(forward/roll) is untouched. This was derived from the reported pitch/yaw mixup plus
the gravity measurement, not from live-verified sign/direction on every axis --
if pitch or yaw still reads backwards (e.g. nose-down showing as nose-up), that's a
single sign flip on the affected row below, not a re-derivation.

Accel mapping:  body = R_ACCEL @ imu
  forward = -imu_z, left = imu_x, up = imu_y

Gyro mapping:  body = R_GYRO @ imu
  roll_rate(+right) = +gyro_z, pitch_rate(+up) = -gyro_x, yaw_rate(+right) = +gyro_y
"""

import json
import os
import time
import numpy as np

CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'imu_cal.json')

R_ACCEL = np.array([
    [0,  0, -1],   # forward = -imu_z
    [1,  0,  0],   # left    =  imu_x
    [0,  1,  0],   # up      =  imu_y
], dtype=np.float64)

R_GYRO = np.array([
    [0,  0,  1],   # roll  = +gyro_z  (positive = right)
    [-1, 0,  0],   # pitch = -gyro_x  (positive = up)
    [0,  1,  0],   # yaw   = +gyro_y  (positive = right)
], dtype=np.float64)


def load_config():
    """Load calibration config from disk, or return defaults."""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    return {
        'gyro_bias': [0.0, 0.0, 0.0],
        'accel_bias': [0.0, 0.0, 0.0],
        'calibrated_at': None,
        'temperature_at_cal': None,
    }


def save_config(config):
    """Persist calibration config to disk."""
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)


def calibrate_gyro_bias(imu, duration=2.0, rate=200):
    """Capture stationary gyro samples and compute zero-rate bias.

    Args:
        imu: sensor driver instance (read_all() -> {accel, gyro, temp}, close())
        duration: seconds to sample
        rate: approximate sample rate (Hz)

    Returns:
        dict with gyro_bias, accel_bias, temperature, sample_count
    """
    samples_gyro = []
    samples_accel = []
    temps = []

    interval = 1.0 / rate
    n_samples = int(duration * rate)

    print(f"IMU calibration: collecting {n_samples} samples over {duration}s (hold still)...")

    for _ in range(n_samples):
        t0 = time.monotonic()
        data = imu.read_all()
        samples_gyro.append(data['gyro'])
        samples_accel.append(data['accel'])
        temps.append(data['temp'])
        elapsed = time.monotonic() - t0
        if elapsed < interval:
            time.sleep(interval - elapsed)

    gyro_arr = np.array(samples_gyro)
    accel_arr = np.array(samples_accel)

    gyro_bias = gyro_arr.mean(axis=0).tolist()
    accel_mean = accel_arr.mean(axis=0).tolist()

    # Accel bias: subtract expected gravity from the dominant axis.
    # Gravity should be +1g on IMU Y axis when level, for the BNO085's mounting
    # (was X for the MPU-6500 -- see the module docstring's remap note). Keep this
    # in sync with R_ACCEL above; they encode the same physical fact.
    accel_bias = [
        accel_mean[0] - 0.0,
        accel_mean[1] - 1.0,  # Y has gravity
        accel_mean[2] - 0.0,
    ]

    gyro_std = gyro_arr.std(axis=0).tolist()
    # Not every driver reports temperature (the BNO085's SH-2 report set has no plain
    # temperature report, so its read_all() always returns temp: None) -- skip rather
    # than feed None into np.mean, which raises.
    valid_temps = [t for t in temps if t is not None]
    temp_mean = float(np.mean(valid_temps)) if valid_temps else None

    print(f"  Gyro bias: [{gyro_bias[0]:.4f}, {gyro_bias[1]:.4f}, {gyro_bias[2]:.4f}] deg/s")
    print(f"  Gyro noise (std): [{gyro_std[0]:.4f}, {gyro_std[1]:.4f}, {gyro_std[2]:.4f}] deg/s")
    print(f"  Accel bias: [{accel_bias[0]:.4f}, {accel_bias[1]:.4f}, {accel_bias[2]:.4f}] g")
    print(f"  Temperature: {temp_mean:.1f} °C" if temp_mean is not None else "  Temperature: n/a")
    print(f"  Samples: {len(samples_gyro)}")

    config = {
        'gyro_bias': gyro_bias,
        'accel_bias': accel_bias,
        'calibrated_at': time.time(),
        'temperature_at_cal': temp_mean,
        'gyro_noise_std': gyro_std,
        'sample_count': len(samples_gyro),
    }

    save_config(config)
    print(f"  Saved to {CONFIG_PATH}")

    return config


class CalibratedIMU:
    """Wrapper around an IMU driver that applies bias correction and axis remapping."""

    def __init__(self, imu, auto_calibrate=True, cal_duration=2.0):
        """
        Args:
            imu: sensor driver instance (read_all() -> {accel, gyro, temp}, close())
            auto_calibrate: if True, run gyro bias calibration on init
            cal_duration: seconds for bias calibration
        """
        self.imu = imu
        self.config = load_config()

        if auto_calibrate or self.config['calibrated_at'] is None:
            self.config = calibrate_gyro_bias(imu, duration=cal_duration)
        else:
            print(f"IMU: using saved calibration from {self.config['calibrated_at']}")

        self.gyro_bias = np.array(self.config['gyro_bias'])
        self.accel_bias = np.array(self.config['accel_bias'])

    def read_raw(self):
        """Read bias-corrected values in IMU frame."""
        data = self.imu.read_all()

        accel = np.array(data['accel']) - self.accel_bias
        gyro = np.array(data['gyro']) - self.gyro_bias

        return {
            'accel': accel,
            'gyro': gyro,
            'temp': data['temp'],
        }

    def read_body(self):
        """Read bias-corrected, axis-remapped values in body frame.

        Body frame:
            accel: [forward, left, up] in g
            gyro: [roll_rate, pitch_rate, yaw_rate] in deg/s
                  roll right = +, pitch up = +, yaw right = +
        """
        raw = self.read_raw()

        accel_body = R_ACCEL @ raw['accel']
        gyro_body = R_GYRO @ raw['gyro']

        return {
            'accel': accel_body,
            'gyro': gyro_body,
            'temp': raw['temp'],
        }

    def close(self):
        self.imu.close()
