"""Stepped-Frequency Continuous Wave (SFCW) radar engine.

Orchestrates the bladeRF to sweep through discrete frequency steps,
capture IQ at each, and compute range profiles via IFFT.
"""

import threading
import time
import numpy as np

from bladerf_driver import BladeRFDriver
import bladerf
from bladerf._bladerf import libbladeRF

SPEED_OF_LIGHT = 299_792_458


class SFCWEngine:
    def __init__(self, driver: BladeRFDriver):
        self.driver = driver
        self.start_freq = 1_000_000_000
        self.stop_freq = 5_000_000_000
        self.step_size = 10_000_000
        self.settle_time = 0.001
        self.num_buffers = 1
        self.running = False
        self._stop_event = threading.Event()
        self._thread = None
        self._callback = None
        self._lock = threading.Lock()

    @property
    def num_steps(self):
        return int((self.stop_freq - self.start_freq) / self.step_size) + 1

    @property
    def bandwidth(self):
        return self.stop_freq - self.start_freq

    @property
    def range_resolution(self):
        if self.bandwidth == 0:
            return float('inf')
        return SPEED_OF_LIGHT / (2 * self.bandwidth)

    @property
    def max_range(self):
        if self.step_size == 0:
            return float('inf')
        return SPEED_OF_LIGHT / (2 * self.step_size)

    def set_params(self, **kwargs):
        with self._lock:
            if 'start_freq' in kwargs:
                self.start_freq = int(kwargs['start_freq'])
            if 'stop_freq' in kwargs:
                self.stop_freq = int(kwargs['stop_freq'])
            if 'step_size' in kwargs:
                self.step_size = int(kwargs['step_size'])
            if 'settle_time' in kwargs:
                self.settle_time = float(kwargs['settle_time'])
            if 'num_buffers' in kwargs:
                self.num_buffers = max(1, int(kwargs['num_buffers']))

    def get_params(self):
        return {
            'start_freq': self.start_freq,
            'stop_freq': self.stop_freq,
            'step_size': self.step_size,
            'settle_time': self.settle_time,
            'num_buffers': self.num_buffers,
            'num_steps': self.num_steps,
            'bandwidth': self.bandwidth,
            'range_resolution': self.range_resolution,
            'max_range': self.max_range,
        }

    def start(self, callback):
        if self.running:
            return
        self._callback = callback
        self._stop_event.clear()
        self.running = True
        self._thread = threading.Thread(target=self._sweep_loop, daemon=True)
        self._thread.start()

    def stop(self):
        if not self.running:
            return
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        self.running = False

    def _sweep_loop(self):
        try:
            self._configure_hardware()
            self._start_tx_rx()

            while not self._stop_event.is_set():
                range_profile = self._perform_sweep()
                if range_profile is not None and self._callback:
                    self._callback(range_profile)

        except Exception as e:
            print(f"[sfcw] Sweep error: {e}")
            if self._callback:
                self._callback({'error': str(e)})
        finally:
            self._stop_tx_rx()
            self.running = False

    def _configure_hardware(self):
        self.driver.set_waveform('cw', offset=0, amplitude=0.9)
        self.driver.enable_single_synth()

    def _start_tx_rx(self):
        self._rx_buffer = None
        self._rx_event = threading.Event()
        self.driver.start_tx()
        self.driver.start_rx(self._rx_capture, num_samples=1024)

    def _stop_tx_rx(self):
        self.driver.stop_rx()
        self.driver.stop_tx()
        self.driver.disable_single_synth()

    def _rx_capture(self, iq_buffer):
        self._rx_buffer = iq_buffer
        self._rx_event.set()

    def _perform_sweep(self):
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step = self.step_size
            settle = self.settle_time
            num_buffers = self.num_buffers

        num_steps = int((stop - start) / step) + 1
        freqs = np.linspace(start, stop, num_steps).astype(np.int64)
        h_freq = np.zeros(num_steps, dtype=np.complex128)

        dev_ptr = self.driver.device.dev[0]
        tx_ch = bladerf.CHANNEL_TX(0)

        for i in range(num_steps):
            if self._stop_event.is_set():
                return None

            f = int(freqs[i])
            # Single-synth: TX PLL drives RX LO, only retune TX
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, f)
            time.sleep(settle)

            accumulator = 0j
            captured = 0
            for _ in range(num_buffers):
                self._rx_event.clear()
                if not self._rx_event.wait(timeout=1.0):
                    break

                iq = self._rx_buffer
                if iq is None:
                    continue

                i_samples = iq[0::2].astype(np.float64) / 2047.0
                q_samples = iq[1::2].astype(np.float64) / 2047.0
                accumulator += np.mean(i_samples + 1j * q_samples)
                captured += 1

            h_freq[i] = accumulator / max(captured, 1)

            if self._callback and i % 10 == 0:
                self._callback({
                    'type': 'progress',
                    'step': i,
                    'total': num_steps,
                    'freq_mhz': freqs[i] / 1e6,
                })

        # Phase coherence diagnostics (unwrapped phase slope)
        phase_raw = np.angle(h_freq)
        phase_unwrapped = np.unwrap(phase_raw)
        # Linear fit: slope should be -2π·τ (constant delay)
        coeffs = np.polyfit(np.arange(num_steps), phase_unwrapped, 1)
        residuals = phase_unwrapped - np.polyval(coeffs, np.arange(num_steps))
        phase_std = float(np.std(residuals))

        window = np.hanning(num_steps)
        h_windowed = h_freq * window
        range_profile = np.fft.ifft(h_windowed)
        magnitude_db = 20 * np.log10(np.abs(range_profile) + 1e-12)

        max_range = SPEED_OF_LIGHT / (2 * step)
        distances = np.linspace(0, max_range, num_steps)

        half = num_steps // 2
        magnitude_db = magnitude_db[:half]
        distances = distances[:half]

        return {
            'type': 'range_profile',
            'distances': distances.tolist(),
            'magnitudes': magnitude_db.tolist(),
            'range_resolution': SPEED_OF_LIGHT / (2 * (stop - start)),
            'max_range': max_range / 2,
            'num_steps': num_steps,
            'timestamp': time.time(),
            'phase_coherence': {
                'phase_std_rad': phase_std,
                'phase_std_deg': float(np.degrees(phase_std)),
                'coherent': phase_std < 0.3,
                'slope_rad_per_step': float(coeffs[0]),
            },
        }
