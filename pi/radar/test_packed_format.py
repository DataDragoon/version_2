#!/usr/bin/env python3
"""Back-to-back check of SC16_Q11 vs SC16_Q11_PACKED on real hardware.

Packed mode has no version gate in libbladeRF and no error path: on an FPGA
older than v0.16.0 the device keeps sending 16-bit samples while the host
unpacks them as SC12, producing plausible-looking garbage. Sample values alone
cannot detect this -- the unpacker masks to 12 bits, so |I|,|Q| <= 2047 either
way. What does detect it is coherence.

TX2 loops into RX2 through a short cable carrying a CW tone at cw_offset. Mixing
that down with exp(-j2*pi*cw_offset*t) must give a phasor that barely moves from
buffer to buffer. Corrupted unpacking scrambles the bit boundaries, the mixed
phasor decorrelates, and the coherence ratio below collapses toward 0.

Run on the Pi:  python3 test_packed_format.py
"""

import sys
import threading
import time

import numpy as np

from bladerf._bladerf import Format
from bladerf_driver import BladeRFDriver

NUM_BUFFERS = 200
NUM_SAMPLES = 4096
SETTLE_BUFFERS = 20


def collect(driver, fmt, label):
    """Stream one format and return its quality metrics."""
    driver.sample_format = fmt

    bufs = []
    arrivals = []
    done = threading.Event()

    def on_rx(rx1_iq, rx2_iq):
        if done.is_set():
            return
        arrivals.append(time.perf_counter())
        bufs.append((rx1_iq.copy(), rx2_iq.copy()))
        if len(bufs) >= NUM_BUFFERS + SETTLE_BUFFERS:
            done.set()

    print(f"\n=== {label} ===")
    driver.start_tx_dual()
    driver.start_rx_dual(on_rx, num_samples=NUM_SAMPLES)
    if not done.wait(timeout=30.0):
        print(f"  TIMEOUT: only {len(bufs)} buffers in 30s")
    driver.stop_rx_dual()
    driver.stop_tx_dual()

    # Drop the settling buffers: the first few after sync_config carry the
    # transient, and their arrival times include stream startup.
    bufs = bufs[SETTLE_BUFFERS:]
    arrivals = arrivals[SETTLE_BUFFERS:]
    if len(bufs) < 2:
        print("  no usable buffers")
        return None

    n = len(bufs[0][0]) // 2
    t = np.arange(n, dtype=np.float64) / driver.sample_rate
    ref_tone = np.exp(-1j * 2 * np.pi * driver.cw_offset * t)

    sig_phasors = np.empty(len(bufs), dtype=np.complex128)
    ref_phasors = np.empty(len(bufs), dtype=np.complex128)
    peak = 0.0
    for k, (rx1, rx2) in enumerate(bufs):
        i1 = rx1[0::2].astype(np.float64)
        q1 = rx1[1::2].astype(np.float64)
        i2 = rx2[0::2].astype(np.float64)
        q2 = rx2[1::2].astype(np.float64)
        sig_phasors[k] = np.mean((i1 + 1j * q1) / 2047.0 * ref_tone)
        ref_phasors[k] = np.mean((i2 + 1j * q2) / 2047.0 * ref_tone)
        peak = max(peak, np.abs(i1).max(), np.abs(q1).max(),
                   np.abs(i2).max(), np.abs(q2).max())

    # Coherence: |mean of phasors| / mean of |phasors|. A steady tone gives ~1.0;
    # phasors with random phase average toward 0.
    def coherence(p):
        denom = np.mean(np.abs(p))
        return float(np.abs(np.mean(p)) / denom) if denom > 0 else 0.0

    dt = np.diff(arrivals)
    rate = 1.0 / np.median(dt) if len(dt) else 0.0

    m = {
        'buffers': len(bufs),
        'buf_rate_hz': rate,
        'eff_msps': rate * n / 1e6,
        'peak_adc': peak,
        'ref_mag': float(np.mean(np.abs(ref_phasors))),
        'ref_coherence': coherence(ref_phasors),
        'ref_phase_std_deg': float(np.degrees(np.std(np.angle(
            ref_phasors / np.mean(ref_phasors))))) if np.abs(np.mean(ref_phasors)) > 0 else float('nan'),
        'sig_coherence': coherence(sig_phasors),
    }
    print(f"  buffers={m['buffers']}  rate={m['buf_rate_hz']:.1f}/s  "
          f"effective={m['eff_msps']:.2f} Msps")
    print(f"  peak ADC={m['peak_adc']:.0f}/2047  ref |phasor|={m['ref_mag']:.5f}")
    print(f"  REF coherence={m['ref_coherence']:.4f}  "
          f"phase std={m['ref_phase_std_deg']:.2f} deg")
    print(f"  SIG coherence={m['sig_coherence']:.4f}")
    return m


def main():
    driver = BladeRFDriver()
    driver.open()
    print(f"serial={driver.serial}  fs={driver.sample_rate/1e6:g} Msps  "
          f"cw_offset={driver.cw_offset/1e3:g} kHz")
    try:
        plain = collect(driver, Format.SC16_Q11, "SC16_Q11 (baseline)")
        packed = collect(driver, Format.SC16_Q11_PACKED, "SC16_Q11_PACKED")
    finally:
        driver.close()

    if not plain or not packed:
        print("\nInconclusive: one of the runs produced no data.")
        return 2

    print("\n" + "=" * 62)
    print(f"{'metric':<22}{'SC16_Q11':>13}{'PACKED':>13}{'delta':>13}")
    print("-" * 62)
    for key, fmt in (('buf_rate_hz', '{:.1f}'), ('eff_msps', '{:.2f}'),
                     ('peak_adc', '{:.0f}'), ('ref_mag', '{:.5f}'),
                     ('ref_coherence', '{:.4f}'), ('sig_coherence', '{:.4f}')):
        a, b = plain[key], packed[key]
        delta = f"{100*(b-a)/a:+.1f}%" if a else "n/a"
        print(f"{key:<22}{fmt.format(a):>13}{fmt.format(b):>13}{delta:>13}")
    print("=" * 62)

    # The verdict rests on the reference channel: it is a CW tone through a
    # cable, so it should be near-perfectly coherent in both formats.
    ratio = packed['ref_coherence'] / plain['ref_coherence'] if plain['ref_coherence'] else 0
    if ratio > 0.95:
        print("\nPACKED LOOKS CORRECT: reference coherence held.")
        if packed['buf_rate_hz'] > plain['buf_rate_hz'] * 1.05:
            print("It is also delivering buffers faster -- you were USB-limited, keep it.")
        else:
            print("But throughput did NOT improve: you are not USB-limited here,")
            print("so packed is only costing you unpack CPU. Consider reverting.")
        return 0

    print("\nPACKED IS CORRUPTING SAMPLES: reference coherence collapsed")
    print(f"({plain['ref_coherence']:.4f} -> {packed['ref_coherence']:.4f}).")
    print("Revert to Format.SC16_Q11 and check the FPGA image version.")
    return 1


if __name__ == '__main__':
    sys.exit(main())
