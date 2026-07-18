"""Stepped-Frequency Continuous Wave (SFCW) radar engine.

Orchestrates the bladeRF to sweep through discrete frequency steps,
capture IQ at each, and compute range profiles via IFFT.
"""

import json
import os
import threading
import time
import numpy as np

from bladerf_driver import BladeRFDriver
import bladerf

SPEED_OF_LIGHT = 299_792_458
TUNE_TABLE_PATH = os.path.join(os.path.dirname(__file__), '.sfcw_tune_table.json')


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
        self._tune_table = None
        self._tune_params = None
        self._load_tune_table()

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

    @property
    def tune_valid(self):
        if self._tune_params is None:
            return False
        return (
            self._tune_params['start_freq'] == self.start_freq and
            self._tune_params['stop_freq'] == self.stop_freq and
            self._tune_params['step_size'] == self.step_size
        )

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
            'tune_valid': self.tune_valid,
        }

    def initialize_tune_table(self, progress_callback=None):
        """Pre-compute quick-tune values for every frequency step."""
        with self._lock:
            start = self.start_freq
            stop = self.stop_freq
            step = self.step_size

        num_steps = int((stop - start) / step) + 1
        freqs = np.linspace(start, stop, num_steps).astype(np.int64)

        ch_tx = self.driver.device.Channel(bladerf.CHANNEL_TX(0))
        ch_rx = self.driver.device.Channel(bladerf.CHANNEL_RX(0))

        tx_tunes = []
        rx_tunes = []

        for i, freq in enumerate(freqs):
            f = int(freq)
            ch_tx.frequency = f
            ch_rx.frequency = f
            tx_tunes.append(ch_tx.get_quick_tune())
            rx_tunes.append(ch_rx.get_quick_tune())

            if progress_callback and i % 20 == 0:
                progress_callback(i, num_steps)

        self._tune_table = {
            'tx': tx_tunes,
            'rx': rx_tunes,
            'freqs': freqs.tolist(),
        }
        self._tune_params = {
            'start_freq': start,
            'stop_freq': stop,
            'step_size': step,
        }
        self._save_tune_table()

        if progress_callback:
            progress_callback(num_steps, num_steps)

    def _save_tune_table(self):
        data = {
            'params': self._tune_params,
            'freqs': self._tune_table['freqs'],
            'tx': [self._serialize_quick_tune(qt) for qt in self._tune_table['tx']],
            'rx': [self._serialize_quick_tune(qt) for qt in self._tune_table['rx']],
        }
        try:
            with open(TUNE_TABLE_PATH, 'w') as f:
                json.dump(data, f)
        except Exception as e:
            print(f"[sfcw] Warning: could not save tune table: {e}")

    def _load_tune_table(self):
        try:
            with open(TUNE_TABLE_PATH, 'r') as f:
                data = json.load(f)
            self._tune_params = data['params']
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            self._tune_params = None
            self._tune_table = None

    def _restore_tune_table(self):
        """Load the full tune table from disk and reconstruct quick-tune objects."""
        try:
            with open(TUNE_TABLE_PATH, 'r') as f:
                data = json.load(f)
            self._tune_params = data['params']
            self._tune_table = {
                'freqs': data['freqs'],
                'tx': [self._deserialize_quick_tune(qt) for qt in data['tx']],
                'rx': [self._deserialize_quick_tune(qt) for qt in data['rx']],
            }
        except Exception as e:
            print(f"[sfcw] Warning: could not restore tune table: {e}")
            self._tune_params = None
            self._tune_table = None

    def _serialize_quick_tune(self, qt):
        return {
            'freqsel': qt.freqsel,
            'vcocap': qt.vcocap,
            'nint': qt.nint,
            'nfrac': qt.nfrac,
            'flags': qt.flags,
            'xb_gpio': qt.xb_gpio if hasattr(qt, 'xb_gpio') else 0,
        }

    def _deserialize_quick_tune(self, data):
        qt = bladerf.QuickTune()
        qt.freqsel = data['freqsel']
        qt.vcocap = data['vcocap']
        qt.nint = data['nint']
        qt.nfrac = data['nfrac']
        qt.flags = data['flags']
        if hasattr(qt, 'xb_gpio'):
            qt.xb_gpio = data.get('xb_gpio', 0)
        return qt

    def start(self, callback):
        if self.running:
            return
        if not self.tune_valid:
            return
        if self._tune_table is None:
            self._restore_tune_table()
            if self._tune_table is None:
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

    def _start_tx_rx(self):
        self._rx_buffer = None
        self._rx_event = threading.Event()
        self.driver.start_tx()
        self.driver.start_rx(self._rx_capture, num_samples=1024)

    def _stop_tx_rx(self):
        self.driver.stop_rx()
        self.driver.stop_tx()

    def _rx_capture(self, iq_buffer):
        self._rx_buffer = iq_buffer
        self._rx_event.set()

    def _perform_sweep(self):
        with self._lock:
            settle = self.settle_time
            num_buffers = self.num_buffers

        tx_tunes = self._tune_table['tx']
        rx_tunes = self._tune_table['rx']
        num_steps = len(tx_tunes)
        h_freq = np.zeros(num_steps, dtype=np.complex128)

        ch_tx = self.driver.device.Channel(bladerf.CHANNEL_TX(0))
        ch_rx = self.driver.device.Channel(bladerf.CHANNEL_RX(0))

        for i in range(num_steps):
            if self._stop_event.is_set():
                return None

            ch_tx.set_quick_tune(tx_tunes[i])
            ch_rx.set_quick_tune(rx_tunes[i])
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
                    'freq_mhz': self._tune_table['freqs'][i] / 1e6,
                })

        window = np.hanning(num_steps)
        h_windowed = h_freq * window
        range_profile = np.fft.ifft(h_windowed)
        magnitude_db = 20 * np.log10(np.abs(range_profile) + 1e-12)

        step = self._tune_params['step_size']
        start = self._tune_params['start_freq']
        stop = self._tune_params['stop_freq']

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
        }
