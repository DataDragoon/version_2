"""bladeRF hardware abstraction — TX1/RX1 only."""

import threading
import numpy as np

try:
    import bladerf
    HAS_HARDWARE = True
except ImportError:
    HAS_HARDWARE = False

SCALE_SC16Q11 = 2047


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
        self.simulated = not HAS_HARDWARE
        self.serial = None
        self._tx_thread = None
        self._rx_thread = None
        self._tx_stop = threading.Event()
        self._rx_stop = threading.Event()
        self._lock = threading.Lock()
        self._tx_buffer = None

    def open(self):
        if self.simulated:
            self.serial = 'SIMULATED'
            return True
        try:
            self.device = bladerf.BladeRF()
            self.serial = self.device.get_serial()
            self._configure_channels()
            return True
        except Exception as e:
            print(f"[bladerf] Failed to open: {e}")
            self.simulated = True
            self.serial = 'SIMULATED'
            return True

    def close(self):
        self.stop_tx()
        self.stop_rx()
        if self.device:
            self.device.close()
            self.device = None

    def _configure_channels(self):
        if self.simulated or not self.device:
            return
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
            if not self.simulated and self.device:
                self.device.Channel(bladerf.CHANNEL_TX(0)).frequency = self.center_freq
                self.device.Channel(bladerf.CHANNEL_RX(0)).frequency = self.center_freq

    def set_tx_gain(self, gain_db):
        with self._lock:
            self.tx_gain = int(gain_db)
            if not self.simulated and self.device:
                self.device.Channel(bladerf.CHANNEL_TX(0)).gain = self.tx_gain

    def set_rx_gain(self, gain_db):
        with self._lock:
            self.rx_gain = int(gain_db)
            if not self.simulated and self.device:
                self.device.Channel(bladerf.CHANNEL_RX(0)).gain = self.rx_gain

    def set_sample_rate(self, rate):
        with self._lock:
            self.sample_rate = int(rate)
            self.bandwidth = int(rate * 0.75)
            if not self.simulated and self.device:
                ch_tx = self.device.Channel(bladerf.CHANNEL_TX(0))
                ch_rx = self.device.Channel(bladerf.CHANNEL_RX(0))
                ch_tx.sample_rate = self.sample_rate
                ch_tx.bandwidth = self.bandwidth
                ch_rx.sample_rate = self.sample_rate
                ch_rx.bandwidth = self.bandwidth

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
            self._tx_buffer = self.generate_waveform(num_samples=int(self.sample_rate * 0.01))

    def generate_waveform(self, num_samples=None):
        if num_samples is None:
            num_samples = int(self.sample_rate * 0.01)
        if self.waveform_type == 'cw':
            return self._generate_cw(num_samples)
        elif self.waveform_type == 'chirp':
            return self._generate_chirp(num_samples)
        elif self.waveform_type == 'noise':
            return self._generate_noise(num_samples)
        return self._generate_cw(num_samples)

    def _generate_cw(self, num_samples):
        t = np.arange(num_samples, dtype=np.float64) / self.sample_rate
        phase = 2 * np.pi * self.cw_offset * t
        i = np.cos(phase) * self.tx_amplitude * SCALE_SC16Q11
        q = np.sin(phase) * self.tx_amplitude * SCALE_SC16Q11
        iq = np.empty(num_samples * 2, dtype=np.int16)
        iq[0::2] = np.clip(i, -2048, 2047).astype(np.int16)
        iq[1::2] = np.clip(q, -2048, 2047).astype(np.int16)
        return iq

    def _generate_chirp(self, num_samples):
        t = np.arange(num_samples, dtype=np.float64) / self.sample_rate
        f0 = -self.chirp_bw / 2
        f1 = self.chirp_bw / 2
        t_mod = t % self.chirp_duration
        phase = 2 * np.pi * (f0 * t_mod + (f1 - f0) / (2 * self.chirp_duration) * t_mod ** 2)
        i = np.cos(phase) * self.tx_amplitude * SCALE_SC16Q11
        q = np.sin(phase) * self.tx_amplitude * SCALE_SC16Q11
        iq = np.empty(num_samples * 2, dtype=np.int16)
        iq[0::2] = np.clip(i, -2048, 2047).astype(np.int16)
        iq[1::2] = np.clip(q, -2048, 2047).astype(np.int16)
        return iq

    def _generate_noise(self, num_samples):
        noise = np.random.randn(num_samples * 2) * self.tx_amplitude * SCALE_SC16Q11 * 0.5
        return np.clip(noise, -2048, 2047).astype(np.int16)

    def get_tx_shape(self, num_samples=512):
        """Get one display-period of the TX waveform for visualization."""
        buf = self.generate_waveform(num_samples)
        i = buf[0::2].astype(np.float64) / SCALE_SC16Q11
        q = buf[1::2].astype(np.float64) / SCALE_SC16Q11
        return i.tolist(), q.tolist()

    def start_tx(self):
        if self.tx_running:
            return
        self._tx_buffer = self.generate_waveform(int(self.sample_rate * 0.01))
        self._tx_stop.clear()
        self.tx_running = True
        if self.simulated:
            return
        self._tx_thread = threading.Thread(target=self._tx_loop, daemon=True)
        self._tx_thread.start()

    def _tx_loop(self):
        try:
            ch = bladerf.CHANNEL_TX(0)
            self.device.sync_config(
                layout=bladerf.ChannelLayout.TX_X1,
                fmt=bladerf.Format.SC16_Q11,
                num_buffers=16,
                buffer_size=4096,
                num_transfers=8,
                stream_timeout=3500
            )
            self.device.enable_module(ch, True)
            while not self._tx_stop.is_set():
                with self._lock:
                    buf = self._tx_buffer
                self.device.sync_tx(buf.tobytes(), len(buf) // 2)
        except Exception as e:
            print(f"[bladerf] TX error: {e}")
        finally:
            try:
                self.device.enable_module(ch, False)
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

    def start_rx(self, callback):
        if self.rx_running:
            return
        self._rx_stop.clear()
        self.rx_running = True
        if self.simulated:
            self._rx_thread = threading.Thread(
                target=self._rx_sim_loop, args=(callback,), daemon=True
            )
        else:
            self._rx_thread = threading.Thread(
                target=self._rx_loop, args=(callback,), daemon=True
            )
        self._rx_thread.start()

    def _rx_loop(self, callback):
        try:
            ch = bladerf.CHANNEL_RX(0)
            self.device.sync_config(
                layout=bladerf.ChannelLayout.RX_X1,
                fmt=bladerf.Format.SC16_Q11,
                num_buffers=16,
                buffer_size=4096,
                num_transfers=8,
                stream_timeout=3500
            )
            self.device.enable_module(ch, True)
            buf = bytearray(4096 * 2 * 2)
            while not self._rx_stop.is_set():
                self.device.sync_rx(buf, 4096)
                iq = np.frombuffer(buf, dtype=np.int16).copy()
                callback(iq)
        except Exception as e:
            print(f"[bladerf] RX error: {e}")
        finally:
            try:
                self.device.enable_module(ch, False)
            except Exception:
                pass
            self.rx_running = False

    def _rx_sim_loop(self, callback):
        import time
        num_samples = 4096
        while not self._rx_stop.is_set():
            t = np.arange(num_samples, dtype=np.float64) / self.sample_rate
            phase = 2 * np.pi * self.cw_offset * t
            noise = np.random.randn(num_samples) * 100
            i = (np.cos(phase) * self.tx_amplitude * SCALE_SC16Q11 * 0.3 + noise)
            q = (np.sin(phase) * self.tx_amplitude * SCALE_SC16Q11 * 0.3 + noise)
            iq = np.empty(num_samples * 2, dtype=np.int16)
            iq[0::2] = np.clip(i, -2048, 2047).astype(np.int16)
            iq[1::2] = np.clip(q, -2048, 2047).astype(np.int16)
            callback(iq)
            time.sleep(num_samples / self.sample_rate)

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
            'connected': self.device is not None or self.simulated,
            'simulated': self.simulated,
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
