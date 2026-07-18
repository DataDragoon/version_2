"""bladeRF hardware abstraction — TX1/RX1 only."""

import threading
import numpy as np
import bladerf
from bladerf._bladerf import ChannelLayout, Format

SCALE = 2047


class BladeRFDriver:
    def __init__(self):
        self.device = None
        self.tx_running = False
        self.rx_running = False
        self.center_freq = 915_000_000
        self.sample_rate = 2_000_000
        self.bandwidth = 1_500_000
        self.tx_gain = 47
        self.rx_gain = 30
        self.waveform_type = 'cw'
        self.cw_offset = 100_000
        self.tx_amplitude = 0.8
        self.chirp_bw = 500_000
        self.chirp_duration = 0.001
        self.serial = None
        self._tx_thread = None
        self._rx_thread = None
        self._tx_stop = threading.Event()
        self._rx_stop = threading.Event()
        self._lock = threading.Lock()
        self._tx_buffer = None

    def open(self):
        self.device = bladerf.BladeRF()
        self.serial = self.device.get_serial()
        self._configure_channels()

    def close(self):
        self.stop_tx()
        self.stop_rx()
        if self.device:
            self.device.close()
            self.device = None

    def _configure_channels(self):
        ch_tx = self.device.Channel(bladerf.CHANNEL_TX(0))
        ch_rx = self.device.Channel(bladerf.CHANNEL_RX(0))
        ch_tx.frequency = int(self.center_freq)
        ch_tx.sample_rate = int(self.sample_rate)
        ch_tx.bandwidth = int(self.bandwidth)
        ch_tx.gain = int(self.tx_gain)
        ch_rx.frequency = int(self.center_freq)
        ch_rx.sample_rate = int(self.sample_rate)
        ch_rx.bandwidth = int(self.bandwidth)
        ch_rx.gain = int(self.rx_gain)

    def set_frequency(self, freq_hz):
        with self._lock:
            self.center_freq = int(freq_hz)
            self.device.Channel(bladerf.CHANNEL_TX(0)).frequency = self.center_freq
            self.device.Channel(bladerf.CHANNEL_RX(0)).frequency = self.center_freq

    def set_tx_gain(self, gain_db):
        with self._lock:
            self.tx_gain = int(gain_db)
            self.device.Channel(bladerf.CHANNEL_TX(0)).gain = self.tx_gain

    def set_rx_gain(self, gain_db):
        with self._lock:
            self.rx_gain = int(gain_db)
            self.device.Channel(bladerf.CHANNEL_RX(0)).gain = self.rx_gain

    def set_sample_rate(self, rate):
        with self._lock:
            self.sample_rate = int(rate)
            self.bandwidth = int(rate * 0.75)
            ch_tx = self.device.Channel(bladerf.CHANNEL_TX(0))
            ch_rx = self.device.Channel(bladerf.CHANNEL_RX(0))
            ch_tx.sample_rate = self.sample_rate
            ch_tx.bandwidth = self.bandwidth
            ch_rx.sample_rate = self.sample_rate
            ch_rx.bandwidth = self.bandwidth
            self._tx_buffer = self._generate(int(self.sample_rate * 0.01))

    def set_waveform(self, waveform_type, **params):
        with self._lock:
            self.waveform_type = waveform_type
            if 'offset' in params:
                self.cw_offset = int(params['offset'])
            if 'amplitude' in params:
                self.tx_amplitude = float(params['amplitude'])
            if 'chirp_bw' in params:
                self.chirp_bw = int(params['chirp_bw'])
            if 'chirp_duration' in params:
                self.chirp_duration = float(params['chirp_duration'])
            self._tx_buffer = self._generate(int(self.sample_rate * 0.01))

    def _generate(self, num_samples):
        if self.waveform_type == 'chirp':
            return self._gen_chirp(num_samples)
        elif self.waveform_type == 'noise':
            return self._gen_noise(num_samples)
        return self._gen_cw(num_samples)

    def _gen_cw(self, n):
        t = np.arange(n, dtype=np.float64) / self.sample_rate
        phase = 2 * np.pi * self.cw_offset * t
        iq = np.empty(n * 2, dtype=np.int16)
        iq[0::2] = np.clip(np.cos(phase) * self.tx_amplitude * SCALE, -2048, 2047).astype(np.int16)
        iq[1::2] = np.clip(np.sin(phase) * self.tx_amplitude * SCALE, -2048, 2047).astype(np.int16)
        return iq

    def _gen_chirp(self, n):
        t = np.arange(n, dtype=np.float64) / self.sample_rate
        f0 = -self.chirp_bw / 2
        f1 = self.chirp_bw / 2
        t_mod = t % self.chirp_duration
        phase = 2 * np.pi * (f0 * t_mod + (f1 - f0) / (2 * self.chirp_duration) * t_mod ** 2)
        iq = np.empty(n * 2, dtype=np.int16)
        iq[0::2] = np.clip(np.cos(phase) * self.tx_amplitude * SCALE, -2048, 2047).astype(np.int16)
        iq[1::2] = np.clip(np.sin(phase) * self.tx_amplitude * SCALE, -2048, 2047).astype(np.int16)
        return iq

    def _gen_noise(self, n):
        noise = np.random.randn(n * 2) * self.tx_amplitude * SCALE * 0.5
        return np.clip(noise, -2048, 2047).astype(np.int16)

    def start_tx(self):
        if self.tx_running:
            return
        self._tx_buffer = self._generate(int(self.sample_rate * 0.01))
        self._tx_stop.clear()
        self.tx_running = True
        self.device.enable_module(bladerf.CHANNEL_TX(0), True)
        self.device.sync_config(
            layout=ChannelLayout.TX_X1,
            fmt=Format.SC16_Q11,
            num_buffers=16,
            buffer_size=4096,
            num_transfers=8,
            stream_timeout=3500
        )
        self._tx_thread = threading.Thread(target=self._tx_loop, daemon=True)
        self._tx_thread.start()

    def _tx_loop(self):
        try:
            while not self._tx_stop.is_set():
                with self._lock:
                    buf = self._tx_buffer
                self.device.sync_tx(buf.tobytes(), len(buf) // 2)
        except Exception as e:
            print(f"[bladerf] TX error: {e}")
        finally:
            try:
                self.device.enable_module(bladerf.CHANNEL_TX(0), False)
            except Exception:
                pass
            self.tx_running = False

    def stop_tx(self):
        if not self.tx_running:
            return
        self._tx_stop.set()
        if self._tx_thread:
            self._tx_thread.join(timeout=2)
            self._tx_thread = None
        self.tx_running = False

    def start_rx(self, callback, num_samples=16384):
        if self.rx_running:
            return
        self._rx_stop.clear()
        self.rx_running = True
        self.device.enable_module(bladerf.CHANNEL_RX(0), True)
        self.device.sync_config(
            layout=ChannelLayout.RX_X1,
            fmt=Format.SC16_Q11,
            num_buffers=16,
            buffer_size=4096,
            num_transfers=8,
            stream_timeout=3500
        )
        self._rx_thread = threading.Thread(target=self._rx_loop, args=(callback, num_samples), daemon=True)
        self._rx_thread.start()

    def _rx_loop(self, callback, num_samples):
        buf = bytearray(num_samples * 2 * 2)
        try:
            while not self._rx_stop.is_set():
                self.device.sync_rx(buf, num_samples)
                iq = np.frombuffer(buf, dtype=np.int16).copy()
                callback(iq)
        except Exception as e:
            print(f"[bladerf] RX error: {e}")
        finally:
            try:
                self.device.enable_module(bladerf.CHANNEL_RX(0), False)
            except Exception:
                pass
            self.rx_running = False

    def stop_rx(self):
        if not self.rx_running:
            return
        self._rx_stop.set()
        if self._rx_thread:
            self._rx_thread.join(timeout=2)
            self._rx_thread = None
        self.rx_running = False

    def get_status(self):
        return {
            'connected': self.device is not None,
            'serial': self.serial,
            'freq': self.center_freq,
            'sample_rate': self.sample_rate,
            'bandwidth': self.bandwidth,
            'tx_gain': self.tx_gain,
            'rx_gain': self.rx_gain,
            'tx_active': self.tx_running,
            'rx_active': self.rx_running,
            'waveform': self.waveform_type,
            'cw_offset': self.cw_offset,
            'tx_amplitude': self.tx_amplitude,
            'chirp_bw': self.chirp_bw,
            'chirp_duration': self.chirp_duration,
        }
