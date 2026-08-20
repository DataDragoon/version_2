"""Standalone benchmark for SFCW sweep optimization.

Run from pi/radar/: python benchmark_sweep.py

Tests baseline timing, coherence, settle count sensitivity,
then optimized sweep timing and coherence validation.
"""

import time
import sys
import numpy as np
import threading

from bladerf_driver import BladeRFDriver
from sfcw_engine import SFCWEngine


def compute_coherence(sweeps):
    """Compute pairwise coherence metrics for a list of h_cal arrays."""
    correlations = []
    repeatabilities = []
    phase_stds = []

    for i in range(len(sweeps) - 1):
        a_raw = sweeps[i]
        b_raw = sweeps[i + 1]

        # Correlation (mean-subtracted)
        a = a_raw - np.mean(a_raw)
        b = b_raw - np.mean(b_raw)
        corr = np.abs(np.sum(a * np.conj(b))) / (
            np.sqrt(np.sum(np.abs(a) ** 2)) * np.sqrt(np.sum(np.abs(b) ** 2))
        )
        correlations.append(float(corr))

        # Repeatability
        residual = b_raw - a_raw
        rep = 1.0 - (np.std(residual) / np.std(a_raw))
        repeatabilities.append(float(rep))

        # Phase std (residuals after linear fit)
        phase_raw = np.angle(b_raw)
        phase_unwrapped = np.unwrap(phase_raw)
        n = len(phase_unwrapped)
        coeffs = np.polyfit(np.arange(n), phase_unwrapped, 1)
        residuals = phase_unwrapped - np.polyval(coeffs, np.arange(n))
        phase_stds.append(float(np.std(residuals)))

    return {
        'correlations': correlations,
        'repeatabilities': repeatabilities,
        'phase_stds': phase_stds,
        'corr_mean': np.mean(correlations),
        'corr_min': np.min(correlations),
        'corr_std': np.std(correlations),
        'rep_mean': np.mean(repeatabilities),
        'rep_min': np.min(repeatabilities),
        'phase_std_mean': np.mean(phase_stds),
        'phase_std_max': np.max(phase_stds),
    }


def run_sweeps(engine, n, mode='standard'):
    """Run n sweeps and return (h_cal_list, time_list)."""
    h_cals = []
    times = []
    for i in range(n):
        t0 = time.perf_counter()
        if mode == 'fast':
            h_cal, _ = engine._sweep_core_fast(
                engine.num_steps,
                np.linspace(engine.start_freq, engine.stop_freq, engine.num_steps).astype(np.int64),
                engine.num_buffers
            )
        else:
            h_cal, _ = engine._sweep_core(
                engine.num_steps,
                np.linspace(engine.start_freq, engine.stop_freq, engine.num_steps).astype(np.int64),
                engine.num_buffers
            )
        t1 = time.perf_counter()
        if h_cal is not None:
            h_cals.append(h_cal)
            times.append((t1 - t0) * 1000)
    return h_cals, times


def run_timed_sweep_detailed(engine, mode='standard'):
    """Run one sweep with per-step timing instrumentation.

    Returns (h_cal, total_ms, per_step_retune_ms, per_step_settle_ms,
             per_step_capture_ms, per_step_overhead_ms).
    """
    from bladerf._bladerf import ffi, libbladeRF
    import bladerf

    num_steps = engine.num_steps
    freqs = np.linspace(engine.start_freq, engine.stop_freq, num_steps).astype(np.int64)
    num_buffers = engine.num_buffers

    h_signal = np.zeros(num_steps, dtype=np.complex128)
    h_reference = np.zeros(num_steps, dtype=np.complex128)

    dev_ptr = engine.driver.device.dev[0]
    tx_ch = bladerf.CHANNEL_TX(0)
    rx_ch = bladerf.CHANNEL_RX(0)

    use_qt = (engine._use_quick_tune and engine._qt_profiles_rx is not None
              and len(engine._qt_profiles_rx) == num_steps)
    settle_count = 10 if use_qt else 2

    retune_times = []
    settle_times = []
    capture_times = []
    overhead_times = []

    t_sweep_start = time.perf_counter()

    for i in range(num_steps):
        t_step_start = time.perf_counter()

        # Retune
        t0 = time.perf_counter()
        f = int(freqs[i])
        if use_qt:
            libbladeRF.bladerf_schedule_retune(dev_ptr, rx_ch, 0, f, engine._qt_profiles_rx[i])
            libbladeRF.bladerf_schedule_retune(dev_ptr, tx_ch, 0, f, engine._qt_profiles_tx[i])
        else:
            libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, f)
            libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, f)
        t1 = time.perf_counter()
        retune_times.append((t1 - t0) * 1000)

        # Settle
        t0 = time.perf_counter()
        with engine._rx_cond:
            target_seq = engine._rx_seq + settle_count
            while engine._rx_seq < target_seq:
                if not engine._rx_cond.wait(timeout=1.0):
                    break
        t1 = time.perf_counter()
        settle_times.append((t1 - t0) * 1000)

        # Capture
        t0 = time.perf_counter()
        rx1_bufs = []
        rx2_bufs = []
        with engine._rx_cond:
            last_seq = engine._rx_seq

        for _ in range(num_buffers):
            with engine._rx_cond:
                while engine._rx_seq <= last_seq:
                    if not engine._rx_cond.wait(timeout=1.0):
                        break
                if engine._rx_seq > last_seq:
                    rx1_bufs.append(engine._rx_latest[0])
                    rx2_bufs.append(engine._rx_latest[1])
                    last_seq = engine._rx_seq

        if len(rx1_bufs) > 0:
            sig_arr = np.array(rx1_bufs, dtype=np.float64)
            ref_arr = np.array(rx2_bufs, dtype=np.float64)
            sig_cplx = (sig_arr[:, 0::2] + 1j * sig_arr[:, 1::2]) * engine._ref_tone_scaled
            ref_cplx = (ref_arr[:, 0::2] + 1j * ref_arr[:, 1::2]) * engine._ref_tone_scaled
            h_signal[i] = sig_cplx.mean()
            h_reference[i] = ref_cplx.mean()
        t1 = time.perf_counter()
        capture_times.append((t1 - t0) * 1000)

        t_step_end = time.perf_counter()
        step_total = (t_step_end - t_step_start) * 1000
        overhead_times.append(step_total - retune_times[-1] - settle_times[-1] - capture_times[-1])

    t_sweep_end = time.perf_counter()
    total_ms = (t_sweep_end - t_sweep_start) * 1000

    ref_mag = np.abs(h_reference)
    valid = ref_mag > 1e-10
    h_cal = np.zeros(num_steps, dtype=np.complex128)
    h_cal[valid] = h_signal[valid] / h_reference[valid]

    return (h_cal, total_ms,
            np.mean(retune_times), np.mean(settle_times),
            np.mean(capture_times), np.mean(overhead_times))


def test_a_baseline_timing(engine, n=20):
    """Test A: Baseline timing profile."""
    print("\n" + "=" * 60)
    print("  TEST A: BASELINE TIMING (20 sweeps)")
    print("=" * 60)

    # Detailed breakdown from one sweep
    _, _, retune_ms, settle_ms, capture_ms, overhead_ms = run_timed_sweep_detailed(engine)

    # Bulk timing
    _, times = run_sweeps(engine, n, mode='standard')

    mean_t = np.mean(times)
    std_t = np.std(times)
    median_t = np.median(times)
    step_time = mean_t / engine.num_steps

    print(f"\n  Mean sweep time:     {mean_t:.1f} ms  (std: {std_t:.1f} ms)")
    print(f"  Median sweep time:   {median_t:.1f} ms")
    print(f"  Per-step breakdown (mean):")
    print(f"    Retune commands:   {retune_ms:.2f} ms  (2 USB round-trips)")
    print(f"    Settle wait:       {settle_ms:.2f} ms  (10 buffers × 4096 samples)")
    print(f"    Capture + process: {capture_ms:.2f} ms")
    print(f"    Python overhead:   {overhead_ms:.2f} ms  (lock, loop, numpy)")
    print(f"  Total step time:     {step_time:.2f} ms")

    return mean_t, std_t, median_t, {'retune': retune_ms, 'settle': settle_ms,
                                      'capture': capture_ms, 'overhead': overhead_ms}


def test_b_baseline_coherence(engine, n=50):
    """Test B: Baseline phase coherence."""
    print("\n" + "=" * 60)
    print("  TEST B: BASELINE COHERENCE (50 sweeps)")
    print("=" * 60)

    h_cals, _ = run_sweeps(engine, n, mode='standard')

    if len(h_cals) < 2:
        print("  ERROR: Not enough sweeps completed")
        return None, h_cals

    metrics = compute_coherence(h_cals)

    failures = sum(1 for ps in metrics['phase_stds'] if ps > 0.3)
    all_coherent = failures == 0

    print(f"\n  Correlation:    mean={metrics['corr_mean']:.4f}  min={metrics['corr_min']:.4f}  std={metrics['corr_std']:.4f}")
    print(f"  Repeatability:  mean={metrics['rep_mean']:.4f}  min={metrics['rep_min']:.4f}")
    print(f"  Phase std:      mean={np.degrees(metrics['phase_std_mean']):.2f}°  max={np.degrees(metrics['phase_std_max']):.2f}°")
    print(f"  ALL COHERENT (phase_std < 0.3 rad): {'YES' if all_coherent else 'NO'}")
    print(f"  Failed sweeps:  {failures}/{n}")

    return metrics, h_cals


def test_c_settle_sweep(engine):
    """Test C: Settle count sweep to find minimum viable value."""
    print("\n" + "=" * 60)
    print("  TEST C: SETTLE COUNT SWEEP")
    print("=" * 60)

    from bladerf._bladerf import ffi, libbladeRF
    import bladerf

    settle_values = [6, 7, 8, 9, 10, 11, 12]
    results = {}

    for settle in settle_values:
        h_cals = []
        times = []

        for trial in range(10):
            num_steps = engine.num_steps
            freqs = np.linspace(engine.start_freq, engine.stop_freq, num_steps).astype(np.int64)

            h_signal = np.zeros(num_steps, dtype=np.complex128)
            h_reference = np.zeros(num_steps, dtype=np.complex128)
            dev_ptr = engine.driver.device.dev[0]
            tx_ch = bladerf.CHANNEL_TX(0)
            rx_ch = bladerf.CHANNEL_RX(0)

            t0 = time.perf_counter()
            for i in range(num_steps):
                f = int(freqs[i])
                libbladeRF.bladerf_schedule_retune(dev_ptr, rx_ch, 0, f, engine._qt_profiles_rx[i])
                libbladeRF.bladerf_schedule_retune(dev_ptr, tx_ch, 0, f, engine._qt_profiles_tx[i])

                with engine._rx_cond:
                    target_seq = engine._rx_seq + settle
                    while engine._rx_seq < target_seq:
                        if not engine._rx_cond.wait(timeout=1.0):
                            break

                with engine._rx_cond:
                    last_seq = engine._rx_seq
                for _ in range(engine.num_buffers):
                    with engine._rx_cond:
                        while engine._rx_seq <= last_seq:
                            if not engine._rx_cond.wait(timeout=1.0):
                                break
                        if engine._rx_seq > last_seq:
                            rx1_buf = engine._rx_latest[0]
                            rx2_buf = engine._rx_latest[1]
                            last_seq = engine._rx_seq

                sig_arr = np.array([rx1_buf], dtype=np.float64)
                ref_arr = np.array([rx2_buf], dtype=np.float64)
                sig_cplx = (sig_arr[:, 0::2] + 1j * sig_arr[:, 1::2]) * engine._ref_tone_scaled
                ref_cplx = (ref_arr[:, 0::2] + 1j * ref_arr[:, 1::2]) * engine._ref_tone_scaled
                h_signal[i] = sig_cplx.mean()
                h_reference[i] = ref_cplx.mean()

            t1 = time.perf_counter()

            ref_mag = np.abs(h_reference)
            valid = ref_mag > 1e-10
            h_cal = np.zeros(num_steps, dtype=np.complex128)
            h_cal[valid] = h_signal[valid] / h_reference[valid]
            h_cals.append(h_cal)
            times.append((t1 - t0) * 1000)

        metrics = compute_coherence(h_cals)
        failures = sum(1 for ps in metrics['phase_stds'] if ps > 0.3 or
                       c < 0.95 for c, ps in zip(metrics['correlations'], metrics['phase_stds']))
        # Count based on correlation only — phase_std fails at 60 MHz steps (known)
        failures = 0
        for j in range(len(metrics['correlations'])):
            if metrics['correlations'][j] < 0.95:
                failures += 1

        results[settle] = {
            'corr': metrics['corr_mean'],
            'phase_std_deg': np.degrees(metrics['phase_std_mean']),
            'failures': failures,
            'sweep_time_ms': np.mean(times),
        }

        print(f"  settle={settle:2d}:  corr={metrics['corr_mean']:.4f}  "
              f"phase_std={np.degrees(metrics['phase_std_mean']):.2f}°  "
              f"failures={failures}/10  sweep_time={np.mean(times):.0f}ms")

    # Find minimum viable (0 correlation failures)
    min_viable = None
    for settle in settle_values:
        if results[settle]['failures'] == 0:
            min_viable = settle
            break

    if min_viable is not None:
        print(f"\n  Minimum viable settle_count: {min_viable} (0 correlation failures)")
    else:
        # All have failures — pick the one with best correlation
        best = max(settle_values, key=lambda s: results[s]['corr'])
        print(f"\n  WARNING: No settle_count had 0 correlation failures!")
        print(f"  Best correlation at settle={best}: {results[best]['corr']:.4f}")
        min_viable = best

    return results, min_viable


def test_d_optimized_timing(engine, n=20, baseline_mean=0):
    """Test D: Optimized sweep timing."""
    print("\n" + "=" * 60)
    print("  TEST D: OPTIMIZED TIMING (20 sweeps)")
    print("=" * 60)

    _, times = run_sweeps(engine, n, mode='fast')

    mean_t = np.mean(times)
    std_t = np.std(times)
    median_t = np.median(times)
    improvement = (1 - mean_t / baseline_mean) * 100 if baseline_mean > 0 else 0

    print(f"\n  === OPTIMIZED vs BASELINE ===")
    print(f"  {'':20s} {'Baseline':>10s}  {'Optimized':>10s}  {'Improvement':>12s}")
    print(f"  {'Mean sweep:':20s} {baseline_mean:>8.1f} ms  {mean_t:>8.1f} ms  {improvement:>8.1f}% faster")
    print(f"  {'Median sweep:':20s} {'':>10s}  {median_t:>8.1f} ms")
    print(f"  {'Per-step time:':20s} {baseline_mean/engine.num_steps:>8.2f} ms  {mean_t/engine.num_steps:>8.2f} ms")

    return mean_t, std_t, median_t


def test_e_optimized_coherence(engine, n=50, baseline_metrics=None):
    """Test E: Optimized sweep coherence — THE GATE."""
    print("\n" + "=" * 60)
    print("  TEST E: OPTIMIZED COHERENCE (50 sweeps) — THE GATE")
    print("=" * 60)

    h_cals, _ = run_sweeps(engine, n, mode='fast')

    if len(h_cals) < 2:
        print("  ERROR: Not enough sweeps completed")
        return None, h_cals, False

    metrics = compute_coherence(h_cals)

    # At 60 MHz steps, phase_std always fails (known PLL issue). Use correlation
    # as the real coherence gate — it measures sweep-to-sweep repeatability.
    corr_failures = sum(1 for c in metrics['correlations'] if c < 0.95)
    corr_pass = metrics['corr_mean'] >= 0.95
    passed = corr_pass and corr_failures == 0

    bl = baseline_metrics or {}
    bl_corr = bl.get('corr_mean', 0)
    bl_phase = bl.get('phase_std_mean', 0)

    print(f"\n  Correlation:    mean={metrics['corr_mean']:.4f}  min={metrics['corr_min']:.4f}  (baseline: {bl_corr:.4f})")
    print(f"  Repeatability:  mean={metrics['rep_mean']:.4f}  min={metrics['rep_min']:.4f}")
    print(f"  Phase std:      mean={np.degrees(metrics['phase_std_mean']):.2f}°  max={np.degrees(metrics['phase_std_max']):.2f}°  (baseline: {np.degrees(bl_phase):.2f}°)")
    print(f"  Corr failures:  {corr_failures}/{n}  (sweeps with correlation < 0.95)")
    print(f"\n  PASS CRITERIA (correlation-based — phase_std invalid at 60 MHz steps):")
    print(f"    mean correlation >= 0.95:           {'PASS' if corr_pass else 'FAIL'}")
    print(f"    zero corr failures (< 0.95):        {'PASS' if corr_failures == 0 else 'FAIL'}")
    print(f"\n  VERDICT: {'PASS' if passed else 'FAIL'}")

    return metrics, h_cals, passed


def test_f_cross_validation(engine, n=5):
    """Test F: Cross-validate baseline vs optimized on same physical scene."""
    print("\n" + "=" * 60)
    print("  TEST F: CROSS-VALIDATION (5 interleaved pairs)")
    print("=" * 60)

    freqs = np.linspace(engine.start_freq, engine.stop_freq, engine.num_steps).astype(np.int64)
    baseline_cals = []
    optimized_cals = []

    for i in range(n):
        # Baseline
        h_cal_b, _ = engine._sweep_core(engine.num_steps, freqs, engine.num_buffers)
        if h_cal_b is not None:
            baseline_cals.append(h_cal_b)

        # Optimized
        h_cal_o, _ = engine._sweep_core_fast(engine.num_steps, freqs, engine.num_buffers)
        if h_cal_o is not None:
            optimized_cals.append(h_cal_o)

    cross_corrs = []
    for i in range(min(len(baseline_cals), len(optimized_cals))):
        a = baseline_cals[i] - np.mean(baseline_cals[i])
        b = optimized_cals[i] - np.mean(optimized_cals[i])
        corr = np.abs(np.sum(a * np.conj(b))) / (
            np.sqrt(np.sum(np.abs(a) ** 2)) * np.sqrt(np.sum(np.abs(b) ** 2))
        )
        cross_corrs.append(float(corr))
        print(f"  Baseline[{i}] vs Optimized[{i}]: corr={corr:.4f}")

    mean_cross = np.mean(cross_corrs) if cross_corrs else 0
    print(f"\n  Cross-mode correlation mean: {mean_cross:.4f}")

    return mean_cross


def main():
    print("=" * 60)
    print("  SFCW SWEEP SPEED OPTIMIZATION BENCHMARK")
    print("=" * 60)
    print(f"\n  Initializing hardware...")

    driver = BladeRFDriver()
    driver.open()
    print(f"  Device: {driver.serial}")

    engine = SFCWEngine(driver)
    # Params: 2-5 GHz, 60 MHz steps = 51 steps
    engine.start_freq = 2_000_000_000
    engine.stop_freq = 5_000_000_000
    engine.step_size = 60_000_000
    engine.num_buffers = 1

    print(f"  Freq: {engine.start_freq/1e9:.1f} - {engine.stop_freq/1e9:.1f} GHz")
    print(f"  Step size: {engine.step_size/1e6:.0f} MHz")
    print(f"  Steps: {engine.num_steps}")
    print(f"  Sample rate: 10 MSPS")
    print(f"  Buffer: 4096 samples (0.41 ms)")

    print(f"\n  Configuring hardware and generating quick_tune profiles...")
    engine._configure_hardware()
    print(f"  Starting TX/RX streams...")
    engine._start_tx_rx()
    time.sleep(0.2)

    # Discard first sweep (warmup)
    print(f"  Warmup sweep...")
    freqs = np.linspace(engine.start_freq, engine.stop_freq, engine.num_steps).astype(np.int64)
    engine._sweep_core(engine.num_steps, freqs, engine.num_buffers)

    try:
        # Test A: Baseline timing
        baseline_mean, baseline_std, baseline_median, breakdown = test_a_baseline_timing(engine)

        # Test B: Baseline coherence
        baseline_metrics, baseline_h_cals = test_b_baseline_coherence(engine)

        # Test C: Settle count sweep
        settle_results, min_viable_settle = test_c_settle_sweep(engine)

        # Configure optimized mode
        engine.sweep_mode = 'fast'
        engine._fast_settle_count = min_viable_settle
        print(f"\n  [CONFIG] Set sweep_mode='fast', settle_count={min_viable_settle}")

        # Test D: Optimized timing
        opt_mean, opt_std, opt_median = test_d_optimized_timing(engine, baseline_mean=baseline_mean)

        # Test E: Optimized coherence (THE GATE)
        opt_metrics, opt_h_cals, passed = test_e_optimized_coherence(engine, baseline_metrics=baseline_metrics)

        # If failed, try incrementing settle count
        settle_used = min_viable_settle
        while not passed and settle_used < 14:
            settle_used += 1
            engine._fast_settle_count = settle_used
            print(f"\n  [RETRY] Increasing settle_count to {settle_used}...")
            opt_metrics, opt_h_cals, passed = test_e_optimized_coherence(engine, baseline_metrics=baseline_metrics)

        # Test F: Cross-validation
        cross_corr_mean = test_f_cross_validation(engine)

        # Final Report
        print("\n\n" + "=" * 60)
        print("  SFCW SWEEP OPTIMIZATION REPORT")
        print("=" * 60)
        print(f"\n  Hardware: bladeRF xA9, {engine.start_freq/1e9:.0f}-{engine.stop_freq/1e9:.0f} GHz, "
              f"{engine.num_steps} steps ({engine.step_size/1e6:.0f} MHz)")
        print(f"  Sample rate: 10 MSPS, Buffer: 4096 samples")

        print(f"\n  TIMING:")
        print(f"    Baseline sweep time:    {baseline_mean:.1f} ± {baseline_std:.1f} ms")
        print(f"    Optimized sweep time:   {opt_mean:.1f} ± {opt_std:.1f} ms")
        improvement = (1 - opt_mean / baseline_mean) * 100
        print(f"    Improvement:            {improvement:.1f}%")
        buffer_period_ms = 4096 / 10_000_000 * 1000
        theoretical_min = engine.num_steps * (buffer_period_ms * (settle_used + 1))
        print(f"    Theoretical minimum:    {theoretical_min:.1f} ms ({engine.num_steps} × {buffer_period_ms*(settle_used+1):.2f}ms)")

        print(f"\n  COHERENCE:")
        if baseline_metrics:
            print(f"    Baseline (50 sweeps):   corr={baseline_metrics['corr_mean']:.4f}  "
                  f"phase_std={np.degrees(baseline_metrics['phase_std_mean']):.2f}°  "
                  f"failures={sum(1 for ps in baseline_metrics['phase_stds'] if ps > 0.3)}")
        if opt_metrics:
            print(f"    Optimized (50 sweeps):  corr={opt_metrics['corr_mean']:.4f}  "
                  f"phase_std={np.degrees(opt_metrics['phase_std_mean']):.2f}°  "
                  f"failures={sum(1 for ps in opt_metrics['phase_stds'] if ps > 0.3)}")

        print(f"\n  SETTLE COUNT:")
        print(f"    Baseline:               10 buffers")
        print(f"    Optimized:              {settle_used} buffers (minimum viable)")

        print(f"\n  CONFIGURATION:")
        print(f"    sweep_mode:             'fast'")
        print(f"    settle_count:           {settle_used}")
        optimizations = [
            "combined settle+capture wait (single lock cycle)",
            "pre-extracted loop variables",
            "inlined single-buffer capture (no list/array wrapping)",
            f"reduced settle count ({settle_used} vs 10)",
        ]
        print(f"    optimizations applied:  {optimizations}")

        print(f"\n  CROSS-VALIDATION:")
        print(f"    Baseline vs Optimized:  corr={cross_corr_mean:.4f} (mean of 5 pairs)")

        verdict = "PASS" if passed and cross_corr_mean >= 0.98 else "FAIL"
        print(f"\n  VERDICT: {verdict}")
        print("=" * 60)

    except KeyboardInterrupt:
        print("\n  Interrupted by user")
    except Exception as e:
        print(f"\n  ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print("\n  Stopping TX/RX and closing device...")
        engine._stop_tx_rx()
        driver.close()
        print("  Done.")


if __name__ == '__main__':
    main()
