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

IMU, LiDAR, and bladeRF SDR integrated. All stream to groundstation debug panels.
RF Calib panel provides signal generator + oscilloscope for bladeRF calibration — always
runs both channels (antenna TX1/RX1 + reference TX2/RX2 loopback) simultaneously, viewport
split left (antenna) / right (reference) for both TX and RX.
SFCW panel performs stepped-frequency sweeps (2–5 GHz, hard-bounded by the quick-tune master
table's 256-profile hardware ceiling — see Quick-tune master table below) with range profile
+ waterfall display.
Both RF panels share port 9003 — starting an SFCW sweep auto-stops any active TX/RX in RF Calib.
C-scan panel rasters a 2D grid of positions over the target and shares the SFCW panel's
background model machinery (see below).

## SFCW Amplitude Scaling (Dynamic / Manual)

The SFCW panel carries an `sfcwScaleRange = { dynamic, min, max, isDb }` (App.jsx), the
same shape the C-scan panel uses for its colour scale. Dynamic (the default) is the old
behaviour: the range profile's Y axis tracks session-wide extremes and the waterfall's
colour range tracks its visible history. Manual pins **both** panes to one pair of limits.

Seeding matters: the live limits are computed inside `SfcwDisplay`, not the panel, so the
display publishes them every frame through `onDynamicScale` into an App-level **ref**
(`sfcwDynamicScale`) — a ref, not state, so a 3–6 Hz sweep does not re-render the sidebar.
The panel reads it via `getDynamicScale()` at the moment the toggle is clicked, so switching
to manual never makes the colours or the axis jump.

`isDb` records which units the pinned numbers are in. Flipping the display's dB/LIN button
(or "Reset Scale") hands the scale back to dynamic, because dB limits are meaningless on a
linear trace. Panes flag a pinned scale with an amber `MANUAL` next to their title, and the
waterfall's colour-bar numbers turn amber too.

The other two `SfcwDisplay` instances (C-scan and BG Model live sweep) pass no `scaleRange`
and stay dynamic — `manual` is false whenever the prop is absent.

## Background Subtraction — Groundstation Only (SFCW + B-scan)

All background subtraction happens on the groundstation. The Pi ships raw `h_cal`,
holds no background state, and has no notion of a B-scan at all. These commands no
longer exist: `sfcw_capture_bg`, `sfcw_clear_bg`, `sfcw_bg_mode`, `bscan_clear_bg`,
`bscan_capture`, `bscan_bg_capture`, `bgmodel_capture`. Every "capture" now works by
tagging the next `sfcw_result` to arrive, groundstation-side, with a ref flag.

Both panels offer the same two mutually exclusive sources:
- **Captured reference** — "Capture BG" tags the next sweep as `sfcwBgRef` / `bscanBgRef`.
- **ML model** — "Load Model" infers a background from lidar standoff (`bgModelInfer.js`).

Selecting either clears the other; "Clear BG" clears both. Subtraction is always complex
(vector) — the old complex/magnitude toggle is gone, complex was the default and is now
the only mode.

- SFCW live display: `App.jsx` `processedSfcwResult`.
- C-scan: `lib/bscanBg.js` `applyBscanBg()`, shared by `processedBscanData` (C-scan +
  2D Map), `sarProcessedData` (SAR), and `alignedSvdData` (Aligned).

**The model path is strictly better for B-scans.** A captured reference is only valid
near the standoff it was taken at, so B-scan positions are corrected by phase-aligning
it with the lidar standoff difference — a fudge that degrades as the hand-held standoff
drifts. A model is evaluated at *each position's own* standoff, so no alignment is
needed and it stays valid across the whole captured span. Outside that span the Akima
interpolator clamps, so the panel flags standoffs beyond the model's `d` range.

The Aligned panel subtracts first and rotates the residual to the common reference
position. That is identical to rotating both and subtracting (the alignment ramp is a
common factor) and it lets the model see each position's true standoff.

**Why groundstation-side:** Pi-side subtraction ran before transmission, so it silently
contaminated B-scan captures, SAR, and BG-model *training* data, which all read
`msg.h_cal_*`. Keeping the wire raw means only the live display is affected.

Note `SfcwDisplay` recomputes its own range profile from `h_cal_real/imag` for
windowing/range-comp, so any subtraction must write back into those fields — replacing
only `magnitudes`/`distances` gets silently discarded. `applyBscanBg` does this.

**Removed from the panel:** the SVD filter (the Aligned, SAR and 2D Map panels
keep their own; `lib/svd.js` stays) and the Wall section. Wall standoff / thickness /
permittivity were never doing refraction work in practice — εr defaulted to 1, so the
distance correction was the identity and the only live effect was capping display depth
at the wall thickness. That is now a single `maxDepth` field (cm, default 30) under
Display, used by both `BscanDisplay` and `sar.worker.js`. Export is v5 (see the C-scan
section); import still reads v3 and maps the old `wallThickness` onto `maxDepth`.
Pi-side architecture: bladerf_driver.py (HAL) → sfcw_engine.py (sweep logic) → sdr_server.py (WebSocket).

**SFCW params are pushed groundstation → Pi, never read back.** The engine carries its
own defaults, and `sfcw_set_params` used to be sent only from a panel field's `onChange`,
so a fresh page load left the Pi sweeping at its defaults while the panel displayed and
derived everything (step count, sweep time, max range) from different ones. `App.jsx`
`sendSfcwParams()` now pushes the full set on SDR connect and again before every
`sfcw_start` (all three start paths: both `App.jsx` handlers and the panel's own toggle).
The panel is the source of truth; keep new SFCW params in that payload or they will not
reach the Pi.
Next steps: SAR reconstruction integration.

## Sweep Timing (measured 2026-08-20)

**Measured sweep times** at 151 steps (20 MHz spacing, 2–5 GHz):
- Mean: 548 ms, effective rate 1.82 Hz.
- Per-step time: 3.63 ms (10 settle buffers × 4096 samples / 2 Msps = 20.5 ms settle
  + 1 capture buffer, but the real wall time per step is 3.63 ms because RX callbacks
  overlap — the settle wait is for *new* callbacks arriving, not elapsed time).

The per-step wait is `settle_count` RX buffer callbacks in `_sweep_core`, now a
user-controlled `SFCWEngine` param (default 10, exposed in the panel as "Settle",
same param family as `num_buffers`/"Buffers") rather than hardcoded. Sweep RX buffers
are 4096 samples at the 10 Msps set in `_configure_hardware`, i.e. 0.41 ms per buffer —
`BUFFER_SAMPLES` / `SAMPLE_RATE` in `SfcwPanel.jsx` mirror those two numbers and must
track the engine. `num_buffers` genuinely averages that many post-settle captures per
step now (see Quick-tune master table below) — the panel's per-step estimate is
`(settle_count + num_buffers) * 0.41ms`.

**Regression, 2026-08-20 to 2026-08-23 (fixed): do not drop `settle_count` below 10
without a real per-step validation.** An optimization pass (`407e205`, `510a9fe`) cut
the quick-tune `settle_count` from 10 to 7, gated behind an experimental
`sweep_mode='fast'` flag with an explicit "reduced if Test C proves it safe" caveat —
then the very next commit merged it in as the unconditional default and rewrote the
caveat into an unsubstantiated "validated over 50 sweeps" claim, with no test artifact
in the repo. Symptom: intermittent fully-garbled sweeps (good scans mostly,
occasionally one random-looking sweep, rarely two in a row) — one step retuning late
means its capture still holds the previous frequency's IQ, and since the range profile
is one IFFT across all steps, a single bad bin corrupts the whole sweep rather than
just that bin. Default reverted to 10. If it ever needs to drop again, validate with a
per-step check (flag/log which step index was corrupted), not just an aggregate
correlation over whole sweeps — an aggregate metric is exactly what let this ship
unnoticed. `benchmark_sweep.py` is a leftover from that pass and is currently broken
(references `_sweep_core_fast`/`sweep_mode`/`_qt_profiles_rx`, all since removed) —
needs a rewrite against the current `_sweep_core`/master-table API before it's useful
again.

## Quick-tune master table (2026-08-23)

Per-grid quick-tune profile caching is gone. `SFCWEngine._ensure_master_quick_tune_table()`
generates one fixed table spanning `QT_MASTER_START_FREQ`–`QT_MASTER_STOP_FREQ` (2–5 GHz)
at `QT_MASTER_STEP` (20 MHz) once per device connection — 151 profiles, paying the full
per-frequency VCO-cal cost (`bladerf_set_frequency` + `bladerf_get_quick_tune`) only that
once, ~6s total. `set_params()` snaps `start_freq`/`stop_freq` to the nearest 20 MHz and
clamps them into that range, and snaps `step_size` to a 20 MHz multiple (`_snap_freq`/
`_snap_step`), so every sweep's frequencies are guaranteed to land exactly on master grid
points. `_build_sweep_grid()` then just indexes into the cached table — no regeneration,
no device reset — so start/stop/step can change freely mid-session, live, with no
interruption.

This replaced the old scheme: profiles were cached per-`(start, stop, step)` combo, and
changing any of those three flipped `_freq_grid_dirty`, which forced a full
`driver.reset()` + reconfigure + restream on the next sweep (or mid-sweep, via
`_reconfigure_for_new_grid()`). That reset path was unreliable in practice — bladeRF
errors on the reopen — which is why it's gone rather than fixed. The master table only
needs invalidating (`SFCWEngine.invalidate_quick_tune_table()`) after an explicit
`device_reset` from the panel; `sdr_server.py`'s `device_reset` handler calls it.

**Hard ceiling: `MAX_QUICK_TUNE_PROFILES = 256`, do not exceed it.** The first version of
this table tried 1–6 GHz at 10 MHz spacing (501 profiles) and it was broken: verified
against libbladeRF's own source on the Pi
(`~/bladerf-src/host/libraries/libbladeRF/src/board/bladerf2/bladerf2.c:1419-1513`),
`bladerf_get_quick_tune()` is not a stateless read — every call *writes* a new fastlock
profile into a fixed-size on-device table (`board_data->quick_tune_tx/rx_profile`, capped
at `NUM_BBP_FASTLOCK_PROFILES = 256` in `fpga_common/include/bladerf2_common.h`, one shared
counter per direction across both TX/RX sub-channels). That counter only resets on a full
`bladerf_open()`. Past 256 calls it returns `BLADERF_ERR_UNEXPECTED` and leaves the profile
struct unpopulated — the original code didn't check the return code, so it silently stored
zeroed/garbage profiles for every frequency past the 256th, which `bladerf_schedule_retune()`
would then happily retune to the wrong RF state. Symptom on stdout: a wall of
`[ERROR @ .../bladerf2.c:1427/1456] Reached maximum number of TX/RX quick tune profiles.`
repeated once per frequency past the cap, on every `start.py` run. `_ensure_master_quick_tune_table()`
now raises immediately if `len(freqs) > MAX_QUICK_TUNE_PROFILES` (compile-time check) or if
`bladerf_get_quick_tune()` ever returns nonzero (runtime check) — fail loud, never store an
unchecked profile. 2–5 GHz at 20 MHz is 151 profiles, comfortably under 256.

Consequence: the sweep range is hard-bounded to 2–5 GHz (panel Start/Stop min/max 2000/5000
MHz) — anything requested outside that gets clamped, and step size floors at 20 MHz. Widening
either means trading against the 256-profile ceiling (span_MHz / step_MHz + 1 ≤ 256) — there's
no way to have both a wide range and fine resolution simultaneously on this hardware without a
different strategy (e.g. a lazy per-frequency cache with a reset-triggered eviction, discussed
and deferred 2026-08-23 in favor of just picking a range/step that fits).

**Default step size is 60 MHz (51 steps, 2–5 GHz)** — `sfcwParams.stepSize` in
`App.jsx` and `SFCWEngine.step_size` both carry it, and the groundstation pushes its
value to the Pi on connect (see the param-push note above).

## C-Scan Panel — 2D Raster (replaced the B-scan panel, 2026-08-20)

The B-scan panel is gone; `CscanPanel.jsx` + `CscanDisplay.jsx` + `lib/cscanGrid.js`
replace it. Panel id is `cscan` (was `bscan`). App-level state keeps its `bscan*` names
(`bscanData`, `bscanParams`, …) because the underlying record is still one B-scan trace
per position — only the panel and its geometry changed.

**Grid.** `bscanParams` is now `{ hCount, hStep, vCount, vStep, maxDepth, gateStart,
gateEnd, metric }`. `stepSize` / `numPositions` are gone; SAR and the 2D Map are 1D and
read `stepSize: hStep` (injected in `sarParams` / `mapStepSize`) with the position count
taken from the data length as before. The Scan Grid section sits between Session and
Capture so the rectangle is described before any sweep is tagged.

**Snake raster order** (`lib/cscanGrid.js` `cellForIndex`). Capture starts at the
bottom-left cell, sweeps the bottom row left→right, steps up one row, sweeps right→left,
steps up, and repeats. Verified: a 3×2 grid captures (0,0) (4,0) (8,0) (8,6) (4,6) (0,6)
for hStep 4 / vStep 6. Every position stores `grid_ix`, `grid_iy`, `x_cm`, `y_cm`,
resolved from the capture index at capture time in the `sfcw_result` handler (via
`bscanParamsRef`), so editing the grid afterwards never relabels existing cells. Lidar
standoff is captured per cell exactly as before.

**Display.** The viewport is Live Sweep (top) over C-Scan Grid (left) + the selected
row's B-scan (right). The grid is a plan view holding the physical aspect ratio, colour =
`gatedIntensity()` over the depth gate (peak / energy / mean), drawn live as cells fill.
Uncaptured cells are outlined and empty; a cell captured with no range bin inside the gate
is mid-grey, distinct from uncaptured. The next target pulses cyan, the snake path is
dashed over the captured cells, and clicking a cell picks the row shown in the B-scan pane
(that pane sorts the row by `grid_ix`, so a right→left row still reads left→right).

**Colour scaling** is one `{ dynamic, min, max }` object shared by both panes. Dynamic
tracks the captured cells; switching to manual seeds the sliders from the current dynamic
limits so colours do not jump, then the two dB sliders drive both images live. The sliders
are disabled and dimmed while dynamic is on, and the colour bar turns amber and reads
MANUAL when it is off.

**Export is v5** (`cscan_<ts>.json`): grid params plus per-position `grid_ix` / `grid_iy` /
`x_cm` / `y_cm`. Import accepts v3–v5; a v4 (or earlier) linear scan maps onto a one-row
grid (`hCount = numPositions`, `hStep = stepSize`, `vCount = 1`).

**Known limitation:** SAR and the 2D Map still treat the capture sequence as a single line.
With `vCount = 1` that is exactly the old behaviour; with more rows their input is a
zig-zag path and the reconstruction is not meaningful until they are made grid-aware.

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

**Result on the 30-position bench set (2026-08-18) — the MLP was replaced.**
Leave-one-position-out suppression, `10*log10(signal/error)` on each held-out position's
measured spectrum, 30 positions over 155.8 mm, median gap 5.5 mm, 15 sweeps each:

| estimator | LOO suppression |
|---|---|
| **Akima interpolation, unwind α=0.80** (shipped) | **20.2 dB** (median 20.3, worst 4.0) |
| cubic spline, α=0.80 | 20.3 dB — best mean, but −12.3 dB on a bad knot |
| physics model, K=5 echoes, free A(f) | 18.7 dB |
| linear interpolation | 12.4 dB |
| Fourier-feature MLP (tanh, k=8..64) | 11.9 dB |
| nearest position | 7.4 dB |
| physics model, K=3, Chebyshev A(f) | 6.8 dB |
| **old 1-64-64-302 MLP** | **4.9 dB** |
| global mean | 0.9 dB |

The captures are dense relative to how fast the background varies, so interpolation wins
outright and needs no parameters. `bgModelInterp.js` ships Akima: it gives up 0.6 dB of mean
for a 16 dB better worst case, because it does not propagate a bad capture into neighbouring
intervals. Inference is 3.1 µs (320k/s, ~10,000× headroom at 30 fps); model file ~360 KB.
Models are `type: 'interp'`; `bgModelInfer.js` keeps the MLP path for previously saved files.

**Things that turned out differently than expected:**
- **The old MLP was underfitting, not overfitting.** 2000 full-batch epochs reached only
  7.97 dB in-sample; 10k → 12.0 dB, 40k → 13.3 dB. Its `finalLoss` looked small only because
  targets were normalized by a single pooled scalar. Its loss curve was still falling 7.4%
  per 100 epochs at epoch 1999. Verified by scoring the saved `models/model 3.json` weights
  directly: 8.6 dB in-sample, matching the numpy re-implementation used for the LOO sweep.
- **The unwind is better with α ≈ 0.80 than α = 1.0** (20.5 dB vs 19.1 dB), a broad plateau
  over 0.70–0.85. Unwinding removes fast phase but injects the lidar's own error into the
  target; 0.8 is the trade-off point. The α matched filter puts the wall echo at 0.93–0.95,
  consistent with the lidar over-reporting standoff *change* by 5–20%. Worth a calibration
  check, but not required — the interpolator absorbs it.
- **The `radarRangeM` diagnostic is unusable**: correlation 0.36 with lidar standoff, 39.9 mm
  scatter after a linear fit. Dominant-peak picking hops between echoes in the near field.
  Radar-derived standoff is not a usable input; the near-field skepticism was correct.
- **Echo structure is dominated by two components**: α≈0.0 (static cable/coupling reflection,
  strongest) and α≈0.93 (wall face, −3.4 dB). Everything else is ≥13 dB down. But a smooth
  (Chebyshev) `A_k(f)` caps the physics model at ~7 dB; with `A_k(f)` free per frequency it
  reaches 18.7 dB. The unmodelled echoes get absorbed into `A_k(f)` as fast frequency
  structure, so `A_k(f)` is *not* smooth.
- **A physics + spline hybrid gives exactly no gain** over the spline alone (20.60 vs 20.59 dB).
- **Measurement noise is not the limit.** The 15-sweep coherent mean sits 47.1 dB below signal.
  Position density is the limit.

**Position density is the dominant lever** (cleaned 22-position set, subsampled):

| median gap | LOO suppression |
|---|---|
| 5.9 mm | 19.3 dB |
| 11.8 mm | 6.9 dB |
| 17.7 mm | −3.3 dB |

Roughly 12 dB lost per doubling of gap. Capture as densely as patience allows; this matters
far more than any modelling choice.

**Range gating cannot separate in-wall targets from the wall face at this bandwidth.** The
entire background sits within 2–6 cm of range, and 3 GHz of bandwidth gives ~50 mm range
resolution. The "gated" metric therefore tracks the full-band metric closely. Separating a
target from the face needs more bandwidth or aperture, not better background subtraction.
