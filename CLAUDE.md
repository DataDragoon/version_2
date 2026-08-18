# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

SFCW radar for within-wall imaging (rebar, pipes, voids, studs — not beyond the wall).
See CONTEXT.md for full system description.

## Key Facts

- This repo runs on TWO machines: Raspberry Pi (pi/) and PC (groundstation/)
- Clone the repo on both; run the appropriate code on each
- Pi never receives direct user input — all control via groundstation over LAN
- Heavy compute (SAR reconstruction, ML) belongs on the PC side
- Every subsystem must have a corresponding debug tool on groundstation

## Code Conventions

- Python for all Pi code (sensor drivers, radar control, networking)
- Python or TypeScript for groundstation (TBD based on UI framework choice)
- Shared protocol definitions in shared/protocols/
- Keep sensor interfaces minimal and async-friendly
- Prefer ZeroMQ or similar for IPC once protocol is chosen

## Hardware Context

- Raspberry Pi with AI HAT+ (Hailo-8L accelerator)
- Camera: Pi NoIR v3 (CSI, use libcamera/picamera2)
- LiDAR: TF-LC02 (UART, 115200 baud default)
- IMU: MPU-6500 (I2C, address 0x68)
- SDR: bladeRF (USB, use libbladeRF / pybladeRF)
- Antennas: 2x Vivaldi (wideband, one TX one RX)

## Living Documentation Rule

CLAUDE.md and CONTEXT.md are living documents. Whenever you learn key information
worth persisting — new design decisions, hardware findings, protocol choices,
calibration values, architectural changes, or anything a future session would
need to know — update CLAUDE.md and/or CONTEXT.md immediately. Don't wait to be
asked. These files are how context survives across sessions and collaborators.

## Current Phase

IMU, LiDAR, Camera, and bladeRF SDR integrated. All stream to groundstation debug panels.
RF Calib panel provides signal generator + oscilloscope for bladeRF calibration (TX1/RX1).
SFCW panel performs stepped-frequency sweeps (1–6 GHz default) with range profile + waterfall display.
Both RF panels share port 9003 — starting an SFCW sweep auto-stops any active TX/RX in RF Calib.

## SFCW Background Subtraction — Groundstation Only

All SFCW background subtraction happens on the groundstation. The Pi ships raw `h_cal`
and holds no background state; `sfcw_capture_bg`, `sfcw_clear_bg`, `sfcw_bg_mode`, and
`bscan_clear_bg` no longer exist as commands.

Two mutually exclusive sources, both in `App.jsx` `processedSfcwResult`:
- **Captured reference** — "Capture BG" tags the next sweep as `sfcwBgRef`.
- **ML model** — "Load Model" infers a background from lidar standoff (`bgModelInfer.js`).

Selecting either clears the other; "Clear BG" clears both. Subtraction is always complex
(vector) — the old complex/magnitude toggle is gone, complex was the default and is now
the only mode.

**Why groundstation-side:** Pi-side subtraction ran before transmission, so it silently
contaminated B-scan captures, SAR, and BG-model *training* data, which all read
`msg.h_cal_*`. Keeping the wire raw means only the SFCW live display is affected.

Note `SfcwDisplay` recomputes its own range profile from `h_cal_real/imag` for
windowing/range-comp, so any subtraction must write back into those fields — replacing
only `magnitudes`/`distances` gets silently discarded.
Pi-side architecture: bladerf_driver.py (HAL) → sfcw_engine.py (sweep logic) → sdr_server.py (WebSocket).
Next steps: OptiFlow pipeline, SAR reconstruction integration.

## BG Model — Capture Protocol and Findings

**Capture protocol (as of 2026-08-18).** One capture = N sweeps at a **static** standoff
(N configurable in the BG Model panel, default 40, persisted to `localStorage.bgmodel_sweeps`).
Positions are hand-placed and deliberately **irregular**; irregular beats uniform, because
uniform undersampling folds alias energy coherently onto a single wrong spatial frequency
while irregular spacing scatters it. Target: ~30 positions over the widest span the bench
allows (150 mm+).

`bgCaptureStats.computeCaptureStats()` runs at capture completion and stores, per position:
coherent complex mean (`h_mean_real/imag` — this is the training target), per-frequency noise
variance, per-sweep and post-averaging SNR, sweep-pair correlation, standoff mean/std, and
`radarRangeM` (range of the dominant return from the coherent mean, sub-bin interpolated).
`radarRangeM` is **diagnostic only** — nothing consumes it. It exists so the dataset carries an
independent standoff estimate to check the lidar against.

Training now uses **one sample per position** (the coherent mean), not every raw sweep. Replicas
measure the same standoff repeatedly, so feeding them individually adds no information — MSE
regresses to this mean anyway, at N× the epochs.

**Spacing limits** (`spacingLimits()`). An echo with path multiplier α oscillates in standoff
with period `c / (2·f·(α−1))`; worst case is α=3 (triple bounce) at the top of the band. At
5 GHz that period is 15 mm, so:
- ≤ 5 mm gaps — well sampled
- 5–7.5 mm — coarse but unaliased
- Above 7.5 mm — α=3 folds onto a wrong spatial frequency and *corrupts* a fit rather than missing detail

**Span sets echo resolution:** `Δα = c / (2·f_c·span)`. At 3.5 GHz, 85 mm span → Δα = 0.50;
150 mm → 0.29. Widest possible span is the single biggest accuracy lever.

**Export format v2** (`bgmodel_<N>pos_<ts>.json`): hoists `common` (num_steps, step_size,
range_offset) out of the per-sweep repetition and stores per-capture `stats` + column arrays
(`standoffs`, `real`, `imag`). ~7 MB for 30 positions × 40 sweeps. Import accepts v1 and v2 and
backfills stats when absent.

**Analysis of the existing MLP** (1 → 64 → 64 → 302 ReLU, 23,918 params, `bgmodel.worker.js`):
- Output is effectively **rank ~5** — SVD over the input domain puts 96% of energy in 5 PCs,
  in near-equal quadrature pairs (the signature of complex sinusoids in `d`). 19,328 of its
  parameters describe a rank-5 map.
- Only 13/64 first-layer knots land inside the input domain; 32/64 L1 and 17/64 L2 units are
  dead across the whole domain.
- Per-frequency residual magnitude spans **20 dB**, so pooled scalar target normalization makes
  MSE a silently power-weighted loss that starves the weak bins.
- `finalLoss` is training MSE with no held-out split anywhere. Param:data ratio was 0.32:1.
- Inference is 19.3 µs (~52k/s), ~1700× headroom at 30 fps. Sweeps run at 3–6 Hz, so the model
  is nowhere near the bottleneck — **data, not compute, is the constraint.**

**Lidar precision is the hard ceiling.** Two-way phase is `4πfd/c`, so at 5 GHz **1 mm of
standoff error = 12° of phase error**. 20 dB of coherent suppression needs the standoff to
~0.5 mm; the TF-LC02 is a ±few-mm sensor. Comparing `radarRangeM` against `standoffMm` across
the new dataset is the cheap test of whether a radar-derived standoff beats the lidar.

**Planned direction** — physics-parameterized phase + learned amplitude:
`H_bg(f,d) = Σ_k A_k(f,d) · exp(−j·4πf·(α_k·d + β_k)/c)`. Delay is pure geometry and exact even
in the near field (2 params per echo); `A_k(f,d)` is where near-field coupling lives, so it is
learned but smooth in `d` because the exponential absorbs all the fast oscillation. ~330 params
vs 23,918. Extrapolation is a free byproduct, not a goal — operation stays inside the trained
near-field range. Evaluation: leave-one-position-out, scored as clutter suppression in dB inside
the target range gate, against a linear-interpolation baseline.

## SFCW Phase Coherence — Known Constraints

The bladeRF2 (AD9361 RFIC) has **separate TX and RX synthesizers**. After each frequency
retune, both PLLs relock to independent random phases. We compensate via dual-channel
reference: TX2→RX2 loopback cable captures the random offset, then h_cal = h_signal / h_reference
cancels it. This gets us ~0.80 sweep-to-sweep correlation — good enough for SAR averaging.

**Why gain must stay constant during a sweep:**
The AD9361 RX gain table uses different analog stage combinations (LNA, mixer, TIA) at each
gain index. Switching gain literally routes the signal through different physical paths with
different parasitic capacitances → non-deterministic phase shifts between RX1 and RX2.
This is an inherent hardware characteristic with NO known software fix (confirmed via AD9361
driver source, bladeRF GitHub issues, Analog Devices forums). Frequency-dependent power
rolloff is handled in post-processing instead.

**Optimizations applied:**
- FPGA tuning mode (`BLADERF_TUNING_MODE_FPGA`) — deterministic retune timing
- Buffer-discard settle (2× 1024-sample buffers = 1.024ms) instead of time.sleep()
- Flat gain throughout sweep; gains set once after enable_module

**Why ~0.80 is the ceiling without architectural change:**
- Reference-channel division inherently amplifies noise (dividing two noisy measurements)
- Thermal drift in PLL/VCO between frequency steps
- USB FIFO timing jitter (non-deterministic buffer boundaries)

**Path to 1.0: shared-LO architecture.**
A single local oscillator feeding both TX and RX mixers would eliminate the random phase
offset entirely — no reference channel needed. The bladeRF2/AD9361 cannot do this.
Hardware that can: NI USRP X310 + UBX daughterboards (LO export/import ports), or a
custom discrete design (single wideband PLL + power splitter + two mixers + FPGA).
This is a future hardware upgrade path, not a software fix.
