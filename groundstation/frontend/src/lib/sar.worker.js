const SPEED_OF_LIGHT = 299792458;

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + halfLen] * curRe - im[i + j + halfLen] * curIm;
        const vIm = re[i + j + halfLen] * curIm + im[i + j + halfLen] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + halfLen] = uRe - vRe;
        im[i + j + halfLen] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function ifftInPlace(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

function complexSvdFilter(hCalReals, hCalImags, numPositions, numSteps, k, strength) {
  // SVD clutter filter on complex h_cal matrix (numPositions × numSteps)
  // Removes the first k spatial components (walls, static clutter)
  if (k < 1 || numPositions < 2) return { reals: hCalReals, imags: hCalImags };

  // Work with flat arrays: re[p*numSteps + s], im[p*numSteps + s]
  const re = new Float64Array(numPositions * numSteps);
  const im = new Float64Array(numPositions * numSteps);
  for (let p = 0; p < numPositions; p++) {
    for (let s = 0; s < numSteps; s++) {
      re[p * numSteps + s] = hCalReals[p][s];
      im[p * numSteps + s] = hCalImags[p][s];
    }
  }

  const s = Math.max(0, Math.min(1, strength));

  for (let comp = 0; comp < k; comp++) {
    // Power iteration to find dominant singular vector
    // Right singular vector v (complex, length numSteps)
    let vRe = new Float64Array(numSteps);
    let vIm = new Float64Array(numSteps);
    for (let i = 0; i < numSteps; i++) { vRe[i] = Math.cos(i); vIm[i] = Math.sin(i); }
    let norm = 0;
    for (let i = 0; i < numSteps; i++) norm += vRe[i] * vRe[i] + vIm[i] * vIm[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < numSteps; i++) { vRe[i] /= norm; vIm[i] /= norm; }

    let uRe = new Float64Array(numPositions);
    let uIm = new Float64Array(numPositions);
    let sigma = 0;

    for (let iter = 0; iter < 50; iter++) {
      // u = A * v (matrix × vector)
      for (let p = 0; p < numPositions; p++) {
        let sumR = 0, sumI = 0;
        for (let j = 0; j < numSteps; j++) {
          const ar = re[p * numSteps + j], ai = im[p * numSteps + j];
          sumR += ar * vRe[j] - ai * vIm[j];
          sumI += ar * vIm[j] + ai * vRe[j];
        }
        uRe[p] = sumR;
        uIm[p] = sumI;
      }

      // sigma = ||u||
      sigma = 0;
      for (let p = 0; p < numPositions; p++) sigma += uRe[p] * uRe[p] + uIm[p] * uIm[p];
      sigma = Math.sqrt(sigma);
      if (sigma < 1e-10) break;
      for (let p = 0; p < numPositions; p++) { uRe[p] /= sigma; uIm[p] /= sigma; }

      // v_new = A^H * u (adjoint × vector)
      let vNewRe = new Float64Array(numSteps);
      let vNewIm = new Float64Array(numSteps);
      for (let j = 0; j < numSteps; j++) {
        let sumR = 0, sumI = 0;
        for (let p = 0; p < numPositions; p++) {
          const ar = re[p * numSteps + j], ai = im[p * numSteps + j];
          // conj(A[p,j]) * u[p] = (ar - j*ai) * (uRe + j*uIm)
          sumR += ar * uRe[p] + ai * uIm[p];
          sumI += ar * uIm[p] - ai * uRe[p];
        }
        vNewRe[j] = sumR;
        vNewIm[j] = sumI;
      }

      // Normalize v
      norm = 0;
      for (let j = 0; j < numSteps; j++) norm += vNewRe[j] * vNewRe[j] + vNewIm[j] * vNewIm[j];
      norm = Math.sqrt(norm);
      if (norm < 1e-10) break;
      for (let j = 0; j < numSteps; j++) { vNewRe[j] /= norm; vNewIm[j] /= norm; }

      // Check convergence
      let diff = 0;
      for (let j = 0; j < numSteps; j++) diff += (vNewRe[j] - vRe[j]) ** 2 + (vNewIm[j] - vIm[j]) ** 2;
      vRe = vNewRe;
      vIm = vNewIm;
      if (diff < 1e-10) break;
    }

    // Subtract: A -= s * sigma * u * v^H
    for (let p = 0; p < numPositions; p++) {
      for (let j = 0; j < numSteps; j++) {
        // sigma * u[p] * conj(v[j]) = sigma * (uRe+j*uIm)*(vRe-j*vIm)
        const outerRe = uRe[p] * vRe[j] + uIm[p] * vIm[j];
        const outerIm = uIm[p] * vRe[j] - uRe[p] * vIm[j];
        re[p * numSteps + j] -= s * sigma * outerRe;
        im[p * numSteps + j] -= s * sigma * outerIm;
      }
    }
  }

  // Rebuild arrays
  const filteredReals = [];
  const filteredImags = [];
  for (let p = 0; p < numPositions; p++) {
    const r = new Array(numSteps);
    const i = new Array(numSteps);
    for (let j = 0; j < numSteps; j++) {
      r[j] = re[p * numSteps + j];
      i[j] = im[p * numSteps + j];
    }
    filteredReals.push(r);
    filteredImags.push(i);
  }
  return { reals: filteredReals, imags: filteredImags };
}

function computeComplexRangeProfile(hCalReal, hCalImag, numSteps, freqStepHz, rangeOffset) {
  const nfftMin = numSteps * 4;
  const nfft = 1 << Math.ceil(Math.log2(nfftMin));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < numSteps; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (numSteps - 1)));
    re[i] = hCalReal[i] * w;
    im[i] = hCalImag[i] * w;
  }
  ifftInPlace(re, im);

  const maxRange = SPEED_OF_LIGHT / (2 * freqStepHz);
  const half = nfft / 2;
  const distRe = [];
  const distIm = [];
  const distances = [];
  for (let i = 0; i < half; i++) {
    const d = (i / nfft) * maxRange - rangeOffset;
    if (d >= 0) {
      distRe.push(re[i]);
      distIm.push(im[i]);
      distances.push(d);
    }
  }
  return { re: distRe, im: distIm, distances };
}

self.onmessage = function (e) {
  const { bscanData, bscanParams } = e.data;
  const t0 = performance.now();

  const { stepSize, wallThickness, wallStandoff, wallPermittivity, aperture, coherent } = bscanParams;
  const pixelsX = 100;
  const pixelsZ = 100;

  const numPositions = bscanData.length;
  if (numPositions < 2 || !bscanData[0].magnitudes || !bscanData[0].distances) {
    self.postMessage({ type: 'result', result: null });
    return;
  }

  const standoffM = (wallStandoff || 0) / 100;
  const thicknessM = wallThickness / 100;
  const sqrtEr = Math.sqrt(wallPermittivity || 1);
  const wallBackApparent = standoffM + thicknessM * sqrtEr;

  const distances = bscanData[0].distances;
  const numBins = distances.length;
  let endBin = numBins - 1;
  for (let i = numBins - 1; i >= 0; i--) {
    if (distances[i] <= wallBackApparent) { endBin = i; break; }
  }

  const depthMax = distances[endBin];
  const apertureLength = (numPositions - 1) * stepSize / 100;

  const antennaX = [];
  for (let p = 0; p < numPositions; p++) {
    antennaX.push(p * stepSize / 100);
  }

  const image = new Float64Array(pixelsX * pixelsZ);

  const hasHcal = coherent && bscanData[0].h_cal_real && bscanData[0].h_cal_imag;

  if (hasHcal) {
    // Coherent SAR: complex range profiles + phase-compensated summation
    const numSteps = bscanData[0].h_cal_real.length;
    const freqStepHz = bscanData[0].step_size || 20000000;
    const rangeOffset = bscanData[0].range_offset || 0.5;
    const startFreq = bscanParams.startFreq ? bscanParams.startFreq * 1e6 : 2e9;
    const k_start = 2 * Math.PI * startFreq / SPEED_OF_LIGHT;

    // Apply complex SVD clutter filter to h_cal before range profile computation
    let hCalReals = bscanData.map(p => p.h_cal_real);
    let hCalImags = bscanData.map(p => p.h_cal_imag);
    if (bscanParams.svdEnabled && bscanParams.svdK >= 1) {
      const filtered = complexSvdFilter(hCalReals, hCalImags, numPositions, numSteps, bscanParams.svdK, bscanParams.svdStrength);
      hCalReals = filtered.reals;
      hCalImags = filtered.imags;
    }

    // Compute complex range profiles for all positions
    const crps = [];
    for (let p = 0; p < numPositions; p++) {
      crps.push(computeComplexRangeProfile(
        hCalReals[p], hCalImags[p],
        numSteps, freqStepHz, rangeOffset
      ));
    }

    const crpDists = crps[0].distances;
    const crpNumBins = crpDists.length;
    const crpDistStart = crpDists[0];
    const crpDistStep = crpNumBins > 1 ? (crpDists[crpNumBins - 1] - crpDistStart) / (crpNumBins - 1) : 1;

    // Find end bin for wall depth
    let crpEndBin = crpNumBins - 1;
    for (let i = crpNumBins - 1; i >= 0; i--) {
      if (crpDists[i] <= wallBackApparent) { crpEndBin = i; break; }
    }

    for (let zi = 0; zi < pixelsZ; zi++) {
      const depth = Math.max(0.005, (zi / (pixelsZ - 1)) * depthMax);

      for (let xi = 0; xi < pixelsX; xi++) {
        const lateral = (xi / (pixelsX - 1)) * apertureLength;

        let sumRe = 0;
        let sumIm = 0;

        for (let p = 0; p < numPositions; p++) {
          const dx = lateral - antennaX[p];
          const R = Math.sqrt(dx * dx + depth * depth);

          const binFloat = (R - crpDistStart) / crpDistStep;
          const binIdx = Math.floor(binFloat);
          if (binIdx < 0 || binIdx >= crpEndBin) continue;

          const frac = binFloat - binIdx;
          const valRe = crps[p].re[binIdx] * (1 - frac) + crps[p].re[binIdx + 1] * frac;
          const valIm = crps[p].im[binIdx] * (1 - frac) + crps[p].im[binIdx + 1] * frac;

          const phase = 2 * k_start * R;
          const cosP = Math.cos(phase);
          const sinP = Math.sin(phase);

          sumRe += valRe * cosP - valIm * sinP;
          sumIm += valRe * sinP + valIm * cosP;
        }

        const mag = Math.sqrt(sumRe * sumRe + sumIm * sumIm);
        image[zi * pixelsX + xi] = 20 * Math.log10(mag + 1e-12);
      }

      if (zi % 10 === 0 || zi === pixelsZ - 1) {
        self.postMessage({ type: 'progress', progress: (zi + 1) / pixelsZ });
      }
    }
  } else {
    // Incoherent SAR: magnitude-only with nearby-position averaging
    const distStart = distances[0];
    const distStep = endBin > 0 ? (distances[endBin] - distStart) / endBin : 1;
    const stepM = stepSize / 100;
    const maxDist = (aperture + 0.5) * stepM;

    for (let zi = 0; zi < pixelsZ; zi++) {
      const depth = (zi / (pixelsZ - 1)) * depthMax;

      for (let xi = 0; xi < pixelsX; xi++) {
        const lateral = (xi / (pixelsX - 1)) * apertureLength;
        let sum = 0;
        let count = 0;

        for (let p = 0; p < numPositions; p++) {
          const dx = lateral - antennaX[p];
          if (Math.abs(dx) > maxDist) continue;

          const range = Math.sqrt(dx * dx + depth * depth);
          const binFloat = (range - distStart) / distStep;
          const binIdx = Math.floor(binFloat);
          if (binIdx < 0 || binIdx >= endBin) continue;

          const frac = binFloat - binIdx;
          const mag = bscanData[p].magnitudes[binIdx] * (1 - frac) + bscanData[p].magnitudes[binIdx + 1] * frac;
          sum += mag;
          count++;
        }

        image[zi * pixelsX + xi] = count > 0 ? sum / count : -90;
      }

      if (zi % 10 === 0 || zi === pixelsZ - 1) {
        self.postMessage({ type: 'progress', progress: (zi + 1) / pixelsZ });
      }
    }
  }

  const computeTimeMs = Math.round(performance.now() - t0);

  self.postMessage({
    type: 'result',
    result: {
      image: Array.from(image),
      pixelsX,
      pixelsZ,
      depthMax,
      apertureLength,
      numPositions,
      computeTimeMs,
      coherent: hasHcal,
    },
  });
};
