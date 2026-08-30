#!/usr/bin/env python3
"""Back-to-back check of SC16_Q11 vs SC16_Q11_PACKED on real hardware.

Packed mode has no version gate in libbladeRF and no error path: on an FPGA
older than v0.16.0 the device keeps sending 16-bit samples while the host
unpacks them as SC12, producing plausible-looking garbage. Sample values alone
cannot detect this -- the unpacker masks to 12 bits, so |I|,|Q| <= 2047 either
way. What does detect it is where the tone lands in the spectrum.

TX2 loops into RX2 through a short cable carrying a CW tone at cw_offset, so
every buffer's FFT must show one dominant bin at that offset. Scrambled bit
boundaries smear that peak across the band. The test is per-buffer and
phase-independent, and it validates the SC16_Q11 baseline before judging
packed -- a metric that cannot pass the known-good case proves nothing.

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



    # Spectral purity, NOT cross-buffer phase. Each buffer is mixed against a
    # ref_tone that restarts at t=0, while the RF tone runs continuously, so
    # consecutive phasors rotate by (cw_offset * buffer_period) mod 1 turn --
    # 345 deg per buffer at 100 kHz / 4096 / 10 Msps. Averaging those gives ~0
    # for CORRECT data, which is what the first version of this script wrongly
    # reported as corruption. Purity is per-buffer and phase-independent: a CW
    # tone puts nearly all its power in one FFT bin no matter its phase, and
    # scrambled bit boundaries smear it across the band.
    expected_bin = int(round(driver.cw_offset / driver.sample_rate * n))

    def purity(iq):
        spec = np.abs(np.fft.fft(iq)) ** 2
        total = spec.sum()
        if total <= 0:
            return 0.0, -1
        k = int(np.argmax(spec))
        # Peak bin plus its two neighbours, to be fair to leakage between bins.
        lobe = spec[(k - 1) % n] + spec[k] + spec[(k + 1) % n]
        return float(lobe / total), k

    ref_pur = np.empty(len(bufs))
    sig_pur = np.empty(len(bufs))
    ref_bin = np.empty(len(bufs), dtype=int)
    peak = 0.0
    stale = 0
    prev2 = None
    for k, (rx1, rx2) in enumerate(bufs):
        i1 = rx1[0::2].astype(np.float64)
        q1 = rx1[1::2].astype(np.float64)
        i2 = rx2[0::2].astype(np.float64)
        q2 = rx2[1::2].astype(np.float64)
        sig_pur[k], _ = purity(i1 + 1j * q1)
        ref_pur[k], ref_bin[k] = purity(i2 + 1j * q2)
        peak = max(peak, np.abs(i1).max(), np.abs(q1).max(),
                   np.abs(i2).max(), np.abs(q2).max())
        # Any part of a buffer identical to the previous one means it was not
        # rewritten -- the failure mode that bit the RX_X2 half-buffer bug.
        if prev2 is not None and np.array_equal(rx2[n:], prev2[n:]):
            stale += 1
        prev2 = rx2

    dt = np.diff(arrivals)
    rate = 1.0 / np.median(dt) if len(dt) else 0.0
    bin_hz = float(np.median(ref_bin)) * driver.sample_rate / n

    m = {
        'buffers': len(bufs),
        'buf_rate_hz': rate,
        'eff_msps': rate * n / 1e6,
        'peak_adc': peak,
        'ref_purity': float(np.mean(ref_pur)),
        'sig_purity': float(np.mean(sig_pur)),
        'ref_tone_hz': bin_hz,
        'bin_agree': float(np.mean(ref_bin == expected_bin)),
        'stale_frac': stale / max(len(bufs) - 1, 1),
    }
    print(f"  buffers={m['buffers']}  rate={m['buf_rate_hz']:.1f}/s  "
          f"effective={m['eff_msps']:.2f} Msps")
    print(f"  peak ADC={m['peak_adc']:.0f}/2047  stale second-halves="
          f"{100*m['stale_frac']:.1f}%")
    print(f"  REF tone at {m['ref_tone_hz']/1e3:.1f} kHz "
          f"(expected {driver.cw_offset/1e3:.1f}), "
          f"bin agrees on {100*m['bin_agree']:.0f}% of buffers")
    print(f"  REF spectral purity={m['ref_purity']:.4f}  "
          f"SIG purity={m['sig_purity']:.4f}")
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
                     ('peak_adc', '{:.0f}'), ('ref_purity', '{:.4f}'),
                     ('sig_purity', '{:.4f}'), ('ref_tone_hz', '{:.0f}'),
                     ('bin_agree', '{:.2f}'), ('stale_frac', '{:.3f}')):
        a, b = plain[key], packed[key]
        delta = f"{100*(b-a)/a:+.1f}%" if a else "n/a"
        print(f"{key:<22}{fmt.format(a):>13}{fmt.format(b):>13}{delta:>13}")
    print("=" * 62)

    # Sanity-check the BASELINE first. SC16_Q11 is known-good, so if it fails
    # the metric then the metric is broken, not the format -- exactly what the
    # coherence version of this script got wrong.
    if plain['ref_purity'] < 0.5 or plain['bin_agree'] < 0.9:
        print("\nINCONCLUSIVE: the SC16_Q11 baseline itself does not show a clean")
        print(f"tone (purity {plain['ref_purity']:.4f}, bin agreement "
              f"{100*plain['bin_agree']:.0f}%). Check the TX2->RX2 cable, gains and")
        print("cw_offset before drawing any conclusion about packed mode.")
        return 2

    ratio = packed['ref_purity'] / plain['ref_purity']
    if ratio > 0.9 and packed['bin_agree'] > 0.9:
        print("\nPACKED IS CORRECT: the tone stays in the right bin, equally pure.")
        if packed['buf_rate_hz'] > plain['buf_rate_hz'] * 1.05:
            print("It also delivers buffers faster -- you were USB-limited, keep it.")
        else:
            print("But throughput did NOT improve: you are not USB-limited here,")
            print("so packed is only costing you unpack CPU. Consider reverting.")
        return 0

    print("\nPACKED IS CORRUPTING SAMPLES: the reference tone smeared")
    print(f"(purity {plain['ref_purity']:.4f} -> {packed['ref_purity']:.4f}, "
          f"bin agreement {100*packed['bin_agree']:.0f}%).")
    print("Revert to Format.SC16_Q11.")
    return 1


if __name__ == '__main__':
    sys.exit(main())
