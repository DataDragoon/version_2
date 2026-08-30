// B-scan background subtraction — groundstation-side, mirroring the SFCW panel.
//
// Two mutually exclusive sources, never both:
//   - captured reference: one sweep, subtracted exactly as captured. It is only
//     valid near the standoff AND the position it was taken at; nothing here
//     tries to extrapolate it to either, because the attempt to do so made it
//     worse (see bgForStandoff).
//   - ML model: the background is inferred per position from that position's
//     own standoff, so it stays valid across the whole captured span.
//
// The Pi ships raw h_cal and holds no background state; everything here runs
// on the groundstation so B-scan exports, SAR and BG-model training data all
// keep reading the unmodified wire values.

import { inferBgModel } from './bgModelInfer';
import { computeRangeProfile } from './rangeProfile';

// Background spectrum to subtract at one position, or null if unavailable.
export function bgForStandoff({ bgRef, bgModel }, standoffMm, numSteps) {
  if (bgModel) {
    if (bgModel.sfcwParams && bgModel.sfcwParams.numSteps !== numSteps) return null;
    if (standoffMm == null) return null;
    return inferBgModel(bgModel, standoffMm, numSteps);
  }

  if (bgRef && bgRef.h_cal_real && bgRef.h_cal_imag) {
    if (bgRef.h_cal_real.length !== numSteps) return null;
    // Subtracted exactly as captured. There used to be a lidar-driven phase
    // ramp here that shifted the reference in range to "correct" for each
    // cell's standoff; it is gone deliberately and must not come back without
    // a bench measurement first. Two reasons (both measured on `row4`, an
    // empty-wall 15x4 C-scan, 2026-08-30 -- see CLAUDE.md):
    //
    //   1. Its sign was inverted. An echo at distance d is exp(-j*2pi*2d*f/c),
    //      so pushing the background OUT by deltaD needs exp(-j...); the code
    //      applied exp(+j...) and pulled it IN, turning a deltaD error into
    //      2*deltaD. Verified: a synthetic echo at 100 mm given deltaD=+10 mm
    //      landed at 90 mm instead of 110 mm.
    //   2. Even with the sign right it loses. Mean suppression over row4's 60
    //      cells: 4.4 dB as shipped, 6.4 dB sign-corrected, 10.9 dB with no
    //      alignment at all. The dominant background term sits at alpha ~ 0 (a
    //      static coupling reflection that does not move with standoff), so
    //      shifting the WHOLE spectrum corrupts the largest component to fix a
    //      smaller one -- in either direction.
    //
    // The shipped version drove the mismatched rows to NEGATIVE suppression,
    // i.e. the subtraction added more energy than it removed, manufacturing
    // detections on a wall with nothing in it.
    return { bgReal: bgRef.h_cal_real, bgImag: bgRef.h_cal_imag };
  }

  return null;
}

export function freqGrid(startFreqMhz, stopFreqMhz, numSteps) {
  const startHz = startFreqMhz * 1e6;
  const stopHz = stopFreqMhz * 1e6;
  const freqs = new Array(numSteps);
  for (let i = 0; i < numSteps; i++) {
    freqs[i] = startHz + (i / (numSteps - 1)) * (stopHz - startHz);
  }
  return freqs;
}

// Subtract the selected background from every position and recompute range
// profiles. Returns the input untouched when no background is selected.
export function applyBscanBg(bscanData, { enabled, bgRef, bgModel }, sfcwParams) {
  if (bscanData.length === 0) return bscanData;
  const active = enabled && (bgModel || bgRef);

  return bscanData.map((pos) => {
    if (!pos.h_cal_real || !pos.h_cal_imag) return pos;
    const numSteps = pos.h_cal_real.length;
    const freqs = freqGrid(sfcwParams.startFreq, sfcwParams.stopFreq, numSteps);

    let real = pos.h_cal_real;
    let imag = pos.h_cal_imag;

    if (active) {
      const bg = bgForStandoff({ bgRef, bgModel }, pos.lidar_standoff_mm, numSteps);
      if (bg) {
        real = new Array(numSteps);
        imag = new Array(numSteps);
        for (let i = 0; i < numSteps; i++) {
          real[i] = pos.h_cal_real[i] - bg.bgReal[i];
          imag[i] = pos.h_cal_imag[i] - bg.bgImag[i];
        }
      }
    }

    const rp = computeRangeProfile(real, imag, numSteps, pos.step_size, pos.range_offset);
    return { ...pos, magnitudes: rp.magnitudes, distances: rp.distances, h_cal_real: real, h_cal_imag: imag, freqs };
  });
}
