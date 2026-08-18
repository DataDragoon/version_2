// B-scan background subtraction — groundstation-side, mirroring the SFCW panel.
//
// Two mutually exclusive sources, never both:
//   - captured reference: one sweep, phase-aligned to each position by the
//     lidar standoff difference. Only valid near the standoff it was taken at.
//   - ML model: the background is inferred per position from that position's
//     own standoff, so no alignment fudge is needed and it stays valid across
//     the whole captured span.
//
// The Pi ships raw h_cal and holds no background state; everything here runs
// on the groundstation so B-scan exports, SAR and BG-model training data all
// keep reading the unmodified wire values.

import { inferBgModel } from './bgModelInfer';
import { computeRangeProfile } from './rangeProfile';

const SPEED_OF_LIGHT = 299792458;

// Background spectrum to subtract at one position, or null if unavailable.
export function bgForStandoff({ bgRef, bgModel }, standoffMm, numSteps, freqs) {
  if (bgModel) {
    if (bgModel.sfcwParams && bgModel.sfcwParams.numSteps !== numSteps) return null;
    if (standoffMm == null) return null;
    return inferBgModel(bgModel, standoffMm, numSteps);
  }

  if (bgRef && bgRef.h_cal_real && bgRef.h_cal_imag) {
    if (bgRef.h_cal_real.length !== numSteps) return null;
    // Phase-align the reference to this position's standoff. Without lidar on
    // both ends there is nothing to align by, so subtract as-is.
    let deltaD = 0;
    if (standoffMm != null && bgRef.lidar_standoff_mm != null) {
      deltaD = (standoffMm - bgRef.lidar_standoff_mm) / 1000;
    }
    const deltaPhasePerHz = 2 * Math.PI * 2 * deltaD / SPEED_OF_LIGHT;
    const bgReal = new Array(numSteps);
    const bgImag = new Array(numSteps);
    for (let i = 0; i < numSteps; i++) {
      const phase = deltaPhasePerHz * freqs[i];
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      const r = bgRef.h_cal_real[i];
      const m = bgRef.h_cal_imag[i];
      bgReal[i] = r * cosP - m * sinP;
      bgImag[i] = r * sinP + m * cosP;
    }
    return { bgReal, bgImag };
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
      const bg = bgForStandoff({ bgRef, bgModel }, pos.lidar_standoff_mm, numSteps, freqs);
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
