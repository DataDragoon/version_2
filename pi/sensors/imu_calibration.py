"""IMU calibration: bias estimation and axis remapping.

Calibration discovery results:
  Gravity when level: accel +X = +1g  -> IMU +X = physical UP
  Roll right:  gyro +Z (+70.6 deg)    -> IMU Z = roll/forward axis
  Pitch down:  gyro -Y (-40.1 deg)    -> IMU Y = pitch/left axis
  Yaw right:   gyro -X (-84.7 deg)    -> IMU X = yaw/up axis

Body frame (right-hand, camera-centric):
  Body X = FORWARD, Body Y = LEFT, Body Z = UP

Accel mapping:  body = R_ACCEL @ imu
  forward = -imu_z, left = imu_y, up = imu_x

Gyro mapping:  body = R_GYRO @ imu
  roll_rate(+right) = +gyro_z, pitch_rate(+up) = +gyro_y, yaw_rate(+right) = -gyro_x
"""

import json
import os
import time
import numpy as np

CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'imu_cal.json')

# IMU → Body accel mapping
# Calibration facts: IMU +X = up (+1g), IMU Z = forward/back axis
# Roll right = +gyro_z → RHR: +Z rotation is CCW from +Z view = roll LEFT
# So forward = -Z (looking down -Z, +Z rotation is CW = roll right) ✓
# Pitch down = -gyro_y → RHR: -Y rotation is CW from +Y view = nose down
# So left = +Y (looking down +Y, -Y rotation tilts nose down) ✓
R_ACCEL = np.array([
    [0,  0, -1],   # body_x (forward) = -imu_z
    [0,  1,  0],   # body_y (left)    =  imu_y
    [1,  0,  0],   # body_z (up)      =  imu_x  (+1g when level)
], dtype=np.float64)

# IMU → Body gyro mapping
# Directly from calibration data:
#   roll right  → gyro +Z  → body_roll_right  = +gyro_z
#   pitch up    → gyro +Y  → body_pitch_up    = +gyro_y (pitch down was -Y)
#   yaw right   → gyro -X  → body_yaw_right   = -gyro_x
R_GYRO = np.array([
    [0,  0,  1],   # body roll_rate  = +gyro_z  (roll right = positive)
    [0,  1,  0],   # body pitch_rate = +gyro_y  (pitch up = positive)
    [-1, 0,  0],   # body yaw_rate   = -gyro_x  (yaw right = positive)
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
        imu: MPU6500 instance
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

    # Accel bias: subtract expected gravity from the dominant axis
    # Gravity should be +1g on IMU X axis when level
    accel_bias = [
        accel_mean[0] - 1.0,  # X has gravity
        accel_mean[1] - 0.0,
        accel_mean[2] - 0.0,
    ]

    gyro_std = gyro_arr.std(axis=0).tolist()
    temp_mean = np.mean(temps)

    print(f"  Gyro bias: [{gyro_bias[0]:.4f}, {gyro_bias[1]:.4f}, {gyro_bias[2]:.4f}] deg/s")
    print(f"  Gyro noise (std): [{gyro_std[0]:.4f}, {gyro_std[1]:.4f}, {gyro_std[2]:.4f}] deg/s")
    print(f"  Accel bias: [{accel_bias[0]:.4f}, {accel_bias[1]:.4f}, {accel_bias[2]:.4f}] g")
    print(f"  Temperature: {temp_mean:.1f} °C")
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
    """Wrapper around MPU6500 that applies bias correction and axis remapping."""

    def __init__(self, imu, auto_calibrate=True, cal_duration=2.0):
        """
        Args:
            imu: MPU6500 instance
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
