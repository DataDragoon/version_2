import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Viewport from './components/Viewport';
import { svdFilter, powerIteration } from './lib/svd';
import { useSarWorker } from './hooks/useSarWorker';
import { useBgModelWorker } from './hooks/useBgModelWorker';
import { inferBgModel } from './lib/bgModelInfer';

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

function computeRangeProfile(hCalReal, hCalImag, numSteps, stepSize, rangeOffset) {
  const nfftMin = numSteps * 4;
  const nfft = 1 << Math.ceil(Math.log2(nfftMin));

  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < numSteps; i++) {
    re[i] = hCalReal[i];
    im[i] = hCalImag[i];
  }

  ifftInPlace(re, im);

  const maxRange = SPEED_OF_LIGHT / (2 * stepSize);
  const half = nfft / 2;
  const magnitudes = [];
  const distances = [];
  for (let i = 0; i < half; i++) {
    const d = (i / nfft) * maxRange - rangeOffset;
    if (d >= 0) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      magnitudes.push(20 * Math.log10(mag + 1e-12));
      distances.push(d);
    }
  }
  return { magnitudes, distances };
}

function runPhaseUnwindTest(samples, sfcwParams) {
  const startHz = sfcwParams.startFreq * 1e6;
  const stopHz = sfcwParams.stopFreq * 1e6;
  const numSteps = samples[0].num_steps;

  const freqs = [];
  for (let i = 0; i < numSteps; i++) {
    freqs.push(startHz + (i / (numSteps - 1)) * (stopHz - startHz));
  }

  const residuals = [];
  const reconstructionErrors = [];

  for (const sample of samples) {
    const d = sample.lidar_standoff_mm / 1000;
    const residualReal = new Array(numSteps);
    const residualImag = new Array(numSteps);
    let maxErr = 0;
    let sumErrSq = 0;

    for (let i = 0; i < numSteps; i++) {
      // Unwind: multiply by exp(+j * 4π * f * d / c)
      const phase = 4 * Math.PI * freqs[i] * d / SPEED_OF_LIGHT;
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      const origR = sample.h_cal_real[i];
      const origI = sample.h_cal_imag[i];
      residualReal[i] = origR * cosP - origI * sinP;
      residualImag[i] = origR * sinP + origI * cosP;

      // Rewind: multiply by exp(-j * 4π * f * d / c)
      const reconR = residualReal[i] * cosP + residualImag[i] * sinP;
      const reconI = -residualReal[i] * sinP + residualImag[i] * cosP;

      const errR = reconR - origR;
      const errI = reconI - origI;
      const errMag = Math.sqrt(errR * errR + errI * errI);
      sumErrSq += errMag * errMag;
      if (errMag > maxErr) maxErr = errMag;
    }

    residuals.push({ real: residualReal, imag: residualImag, distance: d });
    reconstructionErrors.push({
      maxError: maxErr,
      rmsError: Math.sqrt(sumErrSq / numSteps),
    });
  }

  // Cross-sweep residual consistency: how similar are the 5 residuals to each other?
  const meanResidualReal = new Array(numSteps).fill(0);
  const meanResidualImag = new Array(numSteps).fill(0);
  for (const r of residuals) {
    for (let i = 0; i < numSteps; i++) {
      meanResidualReal[i] += r.real[i] / residuals.length;
      meanResidualImag[i] += r.imag[i] / residuals.length;
    }
  }

  let totalVariance = 0;
  let totalSignalPower = 0;
  for (const r of residuals) {
    for (let i = 0; i < numSteps; i++) {
      const diffR = r.real[i] - meanResidualReal[i];
      const diffI = r.imag[i] - meanResidualImag[i];
      totalVariance += diffR * diffR + diffI * diffI;
      totalSignalPower += meanResidualReal[i] ** 2 + meanResidualImag[i] ** 2;
    }
  }
  const snrLinear = totalSignalPower / (totalVariance || 1e-30);
  const snrDb = 10 * Math.log10(snrLinear);

  // Correlation between consecutive residuals
  let corrSum = 0;
  for (let k = 0; k < residuals.length - 1; k++) {
    let dotRe = 0, dotIm = 0, magA = 0, magB = 0;
    for (let i = 0; i < numSteps; i++) {
      const aR = residuals[k].real[i], aI = residuals[k].imag[i];
      const bR = residuals[k + 1].real[i], bI = residuals[k + 1].imag[i];
      dotRe += aR * bR + aI * bI;
      dotIm += aI * bR - aR * bI;
      magA += aR * aR + aI * aI;
      magB += bR * bR + bI * bI;
    }
    corrSum += Math.sqrt(dotRe * dotRe + dotIm * dotIm) / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-30);
  }
  const avgCorrelation = corrSum / (residuals.length - 1);

  return {
    reconstructionErrors,
    maxErrorOverall: Math.max(...reconstructionErrors.map(e => e.maxError)),
    rmsErrorOverall: Math.sqrt(reconstructionErrors.reduce((s, e) => s + e.rmsError ** 2, 0) / reconstructionErrors.length),
    residualSnrDb: snrDb,
    residualCorrelation: avgCorrelation,
    residuals,
    freqs,
    distances: samples.map(s => s.lidar_standoff_mm),
  };
}

export default function App() {
  const [activePanel, setActivePanel] = useState(null);
  const [piIp, setPiIp] = useState(() => localStorage.getItem('pi_ip') || '');

  // IMU state
  const [imuData, setImuData] = useState(null);
  const [imuRate, setImuRate] = useState(0);
  const imuCountRef = useRef(0);
  const [lidarMm, setLidarMm] = useState(null);

  // OptiFlow state
  const [optiflowData, setOptiflowData] = useState(null);
  const [optiflowRate, setOptiflowRate] = useState(0);
  const optiflowCountRef = useRef(0);
  const [gyroComp, setGyroComp] = useState(false);

  // SDR / RF Calib state
  const [sdrStatus, setSdrStatus] = useState(null);
  const [rxSamples, setRxSamples] = useState([]);
  const [fftData, setFftData] = useState(null);
  const [txActive, setTxActive] = useState(false);
  const [rxActive, setRxActive] = useState(false);
  const [showFFT, setShowFFT] = useState(true);
  const [graphPaused, setGraphPaused] = useState(false);

  // SFCW state
  const [sfcwRunning, setSfcwRunning] = useState(false);
  const [sfcwStatus, setSfcwStatus] = useState(null);
  const [sfcwResult, setSfcwResult] = useState(null);
  const [sfcwProgress, setSfcwProgress] = useState(null);
  const [coherenceResult, setCoherenceResult] = useState(null);

  // SFCW range scale ({min, max} in meters)
  const [sfcwRangeScale, setSfcwRangeScale] = useState({ min: 0, max: 3 });

  // SFCW panel params (lifted so they survive panel switches)
  const [sfcwParams, setSfcwParams] = useState({
    startFreq: 2000,
    stopFreq: 5000,
    stepSize: 20,
    settleTime: 3,
    numBuffers: 4,
    tx1Gain: 30,
    rx1Gain: 30,
    rangeOffset: 0.5,
  });

  const sfcwParamsRef = useRef(sfcwParams);
  sfcwParamsRef.current = sfcwParams;

  // Background Model state
  const [bgModelCaptures, setBgModelCaptures] = useState([]);
  const [bgModelCapturing, setBgModelCapturing] = useState(false);
  const [bgModelAccumCount, setBgModelAccumCount] = useState(0);
  const bgModelAccumRef = useRef(null);
  const [bgModelTesting, setBgModelTesting] = useState(false);
  const [bgModelTestCount, setBgModelTestCount] = useState(0);
  const [bgModelTestResult, setBgModelTestResult] = useState(null);
  const bgModelTestRef = useRef(null);
  const bgModelWorker = useBgModelWorker();

  // Loaded BG model for SFCW live subtraction
  const [sfcwBgModel, setSfcwBgModel] = useState(null);
  const [sfcwStandoffMm, setSfcwStandoffMm] = useState(null);

  // B-Scan state
  const [bscanData, setBscanData] = useState([]);
  const [bscanCapturing, setBscanCapturing] = useState(false);
  const [bscanBgRef, setBscanBgRef] = useState(null);
  const [bgApplied, setBgApplied] = useState(true);
  const bscanPendingRef = useRef(null);

  // Lidar accumulator for averaging during SFCW sweeps
  const LIDAR_ANTENNA_OFFSET_MM = 315;
  const lidarAccumRef = useRef([]);
  const [bscanParams, setBscanParams] = useState({
    stepSize: 5,
    numPositions: 20,
    wallStandoff: 0,
    wallThickness: 30,
    wallPermittivity: 1,
  });

  // B-scan display toggles
  const [bscanScaleMode, setBscanScaleMode] = useState('linear');
  const [bscanDisplayMode, setBscanDisplayMode] = useState('color');
  const [bgStandoffMm, setBgStandoffMm] = useState(null);

  // B-scan SVD filter state (used by bscan panel + sar)
  const [svdEnabled, setSvdEnabled] = useState(false);
  const [svdK, setSvdK] = useState(1);
  const [svdStrength, setSvdStrength] = useState(0.5);

  // B-scan BG reference as displayable range profile (no subtraction — raw BG)
  const bscanBgDisplay = useMemo(() => {
    if (!bscanBgRef || !bscanBgRef.h_cal_real || !bscanBgRef.h_cal_imag) return null;
    const numSteps = bscanBgRef.h_cal_real.length;
    const rp = computeRangeProfile(bscanBgRef.h_cal_real, bscanBgRef.h_cal_imag, numSteps, bscanBgRef.step_size, bscanBgRef.range_offset);
    return { magnitudes: rp.magnitudes, distances: rp.distances };
  }, [bscanBgRef]);


  // B-scan frontend processing: lidar-aligned complex BG subtract → IFFT
  const processedBscanData = useMemo(() => {
    if (bscanData.length === 0) return bscanData;
    const startHz = sfcwParams.startFreq * 1e6;
    const stopHz = sfcwParams.stopFreq * 1e6;

    return bscanData.map((pos) => {
      if (!pos.h_cal_real || !pos.h_cal_imag) return pos;
      const numSteps = pos.h_cal_real.length;
      let real = pos.h_cal_real;
      let imag = pos.h_cal_imag;

      if (bgApplied && bscanBgRef && bscanBgRef.h_cal_real && bscanBgRef.h_cal_imag) {
        // Use lidar distance offset for phase alignment; direct subtraction if no lidar
        let deltaD = 0;
        if (pos.lidar_standoff_mm != null && bscanBgRef.lidar_standoff_mm != null) {
          deltaD = (pos.lidar_standoff_mm - bscanBgRef.lidar_standoff_mm) / 1000;
        }
        const deltaPhasePerHz = 2 * Math.PI * 2 * deltaD / SPEED_OF_LIGHT;

        real = new Array(numSteps);
        imag = new Array(numSteps);
        for (let i = 0; i < numSteps; i++) {
          const freq = startHz + (i / (numSteps - 1)) * (stopHz - startHz);
          const phase = deltaPhasePerHz * freq;
          const cosP = Math.cos(phase);
          const sinP = Math.sin(phase);
          const bgR = bscanBgRef.h_cal_real[i];
          const bgI = bscanBgRef.h_cal_imag[i];
          const alignedBgR = bgR * cosP - bgI * sinP;
          const alignedBgI = bgR * sinP + bgI * cosP;
          real[i] = pos.h_cal_real[i] - alignedBgR;
          imag[i] = pos.h_cal_imag[i] - alignedBgI;
        }
      }

      const rp = computeRangeProfile(real, imag, numSteps, pos.step_size, pos.range_offset);
      const freqs = [];
      for (let i = 0; i < numSteps; i++) {
        freqs.push(startHz + (i / (numSteps - 1)) * (stopHz - startHz));
      }
      return { ...pos, magnitudes: rp.magnitudes, distances: rp.distances, h_cal_real: real, h_cal_imag: imag, freqs };
    });
  }, [bscanData, bscanBgRef, bgApplied, sfcwParams.startFreq, sfcwParams.stopFreq]);

  const filteredBscanData = useMemo(() => {
    if (!svdEnabled || processedBscanData.length < 2) return processedBscanData;
    return svdFilter(processedBscanData, svdK, svdStrength);
  }, [processedBscanData, svdEnabled, svdK, svdStrength]);

  // Compute spatial alignment bin shifts using lidar standoff data
  const alignShifts = useMemo(() => {
    if (filteredBscanData.length < 2) {
      return { scanShifts: filteredBscanData.map(() => 0), bgShift: 0 };
    }

    const distances = filteredBscanData[0].distances;
    if (!distances || distances.length < 2) {
      return { scanShifts: filteredBscanData.map(() => 0), bgShift: 0 };
    }
    const binSpacingM = distances[1] - distances[0];

    const hasLidar = filteredBscanData.every(pos => pos.lidar_standoff_mm != null);
    if (!hasLidar) {
      return { scanShifts: filteredBscanData.map(() => 0), bgShift: 0 };
    }

    const standoffs = filteredBscanData.map(pos => pos.lidar_standoff_mm / 1000);
    const maxStandoff = Math.max(...standoffs);

    const scanShifts = standoffs.map(s => (maxStandoff - s) / binSpacingM);

    let bgShift = 0;
    if (bscanBgRef && bscanBgRef.lidar_standoff_mm != null) {
      const bgStandoff = bscanBgRef.lidar_standoff_mm / 1000;
      bgShift = (maxStandoff - bgStandoff) / binSpacingM;
    } else if (bscanBgDisplay && bscanBgDisplay.magnitudes) {
      let bgPeakIdx = 0, maxVal = -Infinity;
      for (let i = 0; i < bscanBgDisplay.magnitudes.length; i++) {
        if (bscanBgDisplay.magnitudes[i] > maxVal) { maxVal = bscanBgDisplay.magnitudes[i]; bgPeakIdx = i; }
      }
      const maxStandoffScanPeak = (() => {
        const idx = standoffs.indexOf(maxStandoff);
        const mags = filteredBscanData[idx].magnitudes;
        let pk = 0, mv = -Infinity;
        for (let i = 0; i < mags.length; i++) { if (mags[i] > mv) { mv = mags[i]; pk = i; } }
        return pk;
      })();
      bgShift = maxStandoffScanPeak - bgPeakIdx;
      if (bgShift < 0) bgShift = 0;
    }

    return { scanShifts, bgShift };
  }, [filteredBscanData, bscanBgDisplay, bscanBgRef, bscanParams]);

  // Aligned panel state
  const [alignEnabled, setAlignEnabled] = useState(true);
  const [alignNormEnabled, setAlignNormEnabled] = useState(false);
  const [alignSvdEnabled, setAlignSvdEnabled] = useState(false);
  const [alignSvdK, setAlignSvdK] = useState(1);
  const [alignSvdStrength, setAlignSvdStrength] = useState(0.5);

  // Aligned panel pipeline: align scans to common reference in freq domain → BG subtract → IFFT → SVD
  // This ensures background subtraction happens AFTER spatial alignment, so reflections
  // from the same physical location subtract correctly across all scan positions.
  const alignedSvdData = useMemo(() => {
    if (bscanData.length < 2) return null;
    const startHz = sfcwParams.startFreq * 1e6;
    const stopHz = sfcwParams.stopFreq * 1e6;

    const hasLidar = bscanData.every(pos => pos.lidar_standoff_mm != null);
    if (!hasLidar) return null;

    const standoffs = bscanData.map(pos => pos.lidar_standoff_mm / 1000);
    const maxStandoff = Math.max(...standoffs);

    // Phase-shift each scan to the reference position (max standoff),
    // then subtract BG (also phase-shifted to reference), then IFFT
    const processed = bscanData.map((pos, idx) => {
      if (!pos.h_cal_real || !pos.h_cal_imag) return pos;
      const numSteps = pos.h_cal_real.length;

      const alignD = maxStandoff - standoffs[idx];
      const alignPhasePerHz = 2 * Math.PI * 2 * alignD / SPEED_OF_LIGHT;

      let real = new Array(numSteps);
      let imag = new Array(numSteps);
      for (let i = 0; i < numSteps; i++) {
        const freq = startHz + (i / (numSteps - 1)) * (stopHz - startHz);
        const phase = alignPhasePerHz * freq;
        const cosP = Math.cos(phase);
        const sinP = Math.sin(phase);
        real[i] = pos.h_cal_real[i] * cosP - pos.h_cal_imag[i] * sinP;
        imag[i] = pos.h_cal_real[i] * sinP + pos.h_cal_imag[i] * cosP;
      }

      if (bgApplied && bscanBgRef && bscanBgRef.h_cal_real && bscanBgRef.h_cal_imag
          && bscanBgRef.h_cal_real.length === numSteps) {
        let bgAlignD = 0;
        if (bscanBgRef.lidar_standoff_mm != null) {
          bgAlignD = maxStandoff - (bscanBgRef.lidar_standoff_mm / 1000);
        }
        const bgPhasePerHz = 2 * Math.PI * 2 * bgAlignD / SPEED_OF_LIGHT;

        for (let i = 0; i < numSteps; i++) {
          const freq = startHz + (i / (numSteps - 1)) * (stopHz - startHz);
          const phase = bgPhasePerHz * freq;
          const cosP = Math.cos(phase);
          const sinP = Math.sin(phase);
          const bgR = bscanBgRef.h_cal_real[i] * cosP - bscanBgRef.h_cal_imag[i] * sinP;
          const bgI = bscanBgRef.h_cal_real[i] * sinP + bscanBgRef.h_cal_imag[i] * cosP;
          real[i] -= bgR;
          imag[i] -= bgI;
        }
      }

      const rp = computeRangeProfile(real, imag, numSteps, pos.step_size, pos.range_offset);
      return { ...pos, magnitudes: rp.magnitudes, distances: rp.distances };
    });

    if (alignSvdEnabled && processed.length >= 2) {
      return svdFilter(processed, alignSvdK, alignSvdStrength);
    }
    return processed;
  }, [bscanData, sfcwParams.startFreq, sfcwParams.stopFreq, bgApplied, bscanBgRef, alignSvdEnabled, alignSvdK, alignSvdStrength]);

  // 2D Map state
  const [mapGateStart, setMapGateStart] = useState(2);
  const [mapGateEnd, setMapGateEnd] = useState(15);
  const [mapDynRange, setMapDynRange] = useState(30);
  const [mapMetric, setMapMetric] = useState('peak');
  const [mapFocusEnabled, setMapFocusEnabled] = useState(false);
  const [mapFocusAperture, setMapFocusAperture] = useState(7);
  const [mapSvdEnabled, setMapSvdEnabled] = useState(false);
  const [mapSvdK, setMapSvdK] = useState(1);
  const [mapSvdStrength, setMapSvdStrength] = useState(0.5);

  // SAR processing state (independent of B-scan panel)
  const [sarBgEnabled, setSarBgEnabled] = useState(true);
  const [sarSvdEnabled, setSarSvdEnabled] = useState(false);
  const [sarSvdK, setSarSvdK] = useState(1);
  const [sarSvdStrength, setSarSvdStrength] = useState(1.0);
  const [sarScaleMode, setSarScaleMode] = useState('db');
  const [sarAperture, setSarAperture] = useState(1);
  const [sarCoherent, setSarCoherent] = useState(true);
  const [sarDynRange, setSarDynRange] = useState(20);

  const sarProcessedData = useMemo(() => {
    if (bscanData.length === 0) return bscanData;
    const startHz = sfcwParams.startFreq * 1e6;
    const stopHz = sfcwParams.stopFreq * 1e6;

    return bscanData.map((pos) => {
      if (!pos.h_cal_real || !pos.h_cal_imag) return pos;
      const numSteps = pos.h_cal_real.length;
      let real = pos.h_cal_real;
      let imag = pos.h_cal_imag;

      if (sarBgEnabled && bscanBgRef && bscanBgRef.h_cal_real && bscanBgRef.h_cal_imag) {
        let deltaD = 0;
        if (pos.lidar_standoff_mm != null && bscanBgRef.lidar_standoff_mm != null) {
          deltaD = (pos.lidar_standoff_mm - bscanBgRef.lidar_standoff_mm) / 1000;
        }
        const deltaPhasePerHz = 2 * Math.PI * 2 * deltaD / SPEED_OF_LIGHT;
        real = new Array(numSteps);
        imag = new Array(numSteps);
        for (let i = 0; i < numSteps; i++) {
          const freq = startHz + (i / (numSteps - 1)) * (stopHz - startHz);
          const phase = deltaPhasePerHz * freq;
          const cosP = Math.cos(phase);
          const sinP = Math.sin(phase);
          const bgR = bscanBgRef.h_cal_real[i];
          const bgI = bscanBgRef.h_cal_imag[i];
          real[i] = pos.h_cal_real[i] - (bgR * cosP - bgI * sinP);
          imag[i] = pos.h_cal_imag[i] - (bgR * sinP + bgI * cosP);
        }
      }

      const rp = computeRangeProfile(real, imag, numSteps, pos.step_size, pos.range_offset);
      return { ...pos, magnitudes: rp.magnitudes, distances: rp.distances, h_cal_real: Array.from(real), h_cal_imag: Array.from(imag) };
    });
  }, [bscanData, bscanBgRef, sarBgEnabled, sfcwParams.startFreq, sfcwParams.stopFreq]);

  const sarBscanInput = useMemo(() => {
    if (!sarSvdEnabled || sarProcessedData.length < 2) return sarProcessedData;
    return svdFilter(sarProcessedData, sarSvdK, sarSvdStrength);
  }, [sarProcessedData, sarSvdEnabled, sarSvdK, sarSvdStrength]);

  const sarParams = useMemo(() => ({ ...bscanParams, aperture: sarAperture, coherent: sarCoherent, startFreq: sfcwParams.startFreq, svdEnabled: sarSvdEnabled, svdK: sarSvdK, svdStrength: sarSvdStrength }), [bscanParams, sarAperture, sarCoherent, sfcwParams.startFreq, sarSvdEnabled, sarSvdK, sarSvdStrength]);
  const { sarResult, sarProgress } = useSarWorker(sarBscanInput, sarParams);

  // 2D Map uses the same processed B-scan as the main B-scan panel, optionally with its own SVD
  const mapBscanData = useMemo(() => {
    if (!mapSvdEnabled || processedBscanData.length < 2) return processedBscanData;
    return svdFilter(processedBscanData, mapSvdK, mapSvdStrength);
  }, [processedBscanData, mapSvdEnabled, mapSvdK, mapSvdStrength]);

  // Apply loaded BG model to live SFCW result
  const processedSfcwResult = useMemo(() => {
    if (!sfcwResult || !sfcwBgModel) return sfcwResult;
    if (!sfcwResult.h_cal_real || !sfcwResult.h_cal_imag) return sfcwResult;

    const numSteps = sfcwResult.h_cal_real.length;
    if (numSteps !== sfcwBgModel.sfcwParams.numSteps) {
      console.warn('[BG Model] numSteps mismatch:', numSteps, 'vs model:', sfcwBgModel.sfcwParams.numSteps);
      return sfcwResult;
    }
    if (sfcwStandoffMm == null) {
      console.warn('[BG Model] no lidar standoff available');
      return sfcwResult;
    }

    const { bgReal, bgImag } = inferBgModel(sfcwBgModel, sfcwStandoffMm, numSteps);

    const subReal = new Array(numSteps);
    const subImag = new Array(numSteps);
    for (let i = 0; i < numSteps; i++) {
      subReal[i] = sfcwResult.h_cal_real[i] - bgReal[i];
      subImag[i] = sfcwResult.h_cal_imag[i] - bgImag[i];
    }

    const rp = computeRangeProfile(subReal, subImag, numSteps, sfcwResult.step_size, sfcwResult.range_offset);
    return { ...sfcwResult, magnitudes: rp.magnitudes, distances: rp.distances };
  }, [sfcwResult, sfcwBgModel, sfcwStandoffMm]);

  // IMU WebSocket
  const handleImuMessage = useCallback((msg) => {
    imuCountRef.current++;
    setImuData(msg);
    if (msg.lidar !== null && msg.lidar !== undefined) {
      setLidarMm(msg.lidar);
      lidarAccumRef.current.push(msg.lidar);
    }
  }, []);

  const imuUrl = piIp ? `ws://${piIp}:9001` : null;
  const { status: imuStatus, connect: connectImu, disconnect: disconnectImu } = useWebSocket(imuUrl, handleImuMessage);

  // OptiFlow WebSocket
  const handleOptiflowMessage = useCallback((msg) => {
    optiflowCountRef.current++;
    setOptiflowData(msg);
  }, []);

  const optiflowUrl = piIp ? `ws://${piIp}:9002` : null;
  const { status: optiflowStatus, send: sendOptiflow, connect: connectOptiflow, disconnect: disconnectOptiflow } = useWebSocket(optiflowUrl, handleOptiflowMessage);

  // SDR WebSocket (RF Calib + SFCW share this connection)
  const handleSdrMessage = useCallback((msg) => {
    if (msg.type === 'status') {
      setSdrStatus(msg);
      setTxActive(msg.tx_active);
      setRxActive(msg.rx_active);
      if (!msg.rx_active) {
        setRxSamples([]);
        setFftData(null);
      }
    } else if (msg.type === 'rx_data') {
      setRxSamples(msg.i);
    } else if (msg.type === 'rx_fft') {
      setFftData({ magnitudes: msg.magnitudes, freq_span: msg.freq_span || 2000000 });
    } else if (msg.type === 'sfcw_status') {
      setSfcwRunning(msg.running);
      setSfcwStatus(msg);
    } else if (msg.type === 'sfcw_result') {
      // Compute averaged lidar standoff for this sweep
      const accum = lidarAccumRef.current;
      const avgLidarMm = accum.length > 0
        ? accum.reduce((s, v) => s + v, 0) / accum.length
        : null;
      const standoffMm = avgLidarMm !== null ? avgLidarMm - LIDAR_ANTENNA_OFFSET_MM : null;
      lidarAccumRef.current = [];

      // Always update live display
      setSfcwResult(msg);
      setSfcwStandoffMm(standoffMm);

      // Flag-based B-scan capture: sweep itself carries the flag
      if (msg.bscan_capture) {
        const posData = {
          magnitudes: [...msg.magnitudes],
          distances: [...msg.distances],
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
          lidar_standoff_mm: standoffMm,
        };
        setBscanData(prev => [...prev, posData]);
        setBscanCapturing(false);
      }
      if (msg.bscan_bg_capture) {
        setBscanBgRef({
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
          lidar_standoff_mm: standoffMm,
        });
        setBscanCapturing(false);
      }
      if (bgModelAccumRef.current) {
        const accum = bgModelAccumRef.current;
        accum.samples.push({
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          lidar_standoff_mm: standoffMm,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
          timestamp: msg.timestamp,
        });
        setBgModelAccumCount(accum.samples.length);

        if (accum.samples.length >= 5) {
          setBgModelCaptures(prev => [...prev, { samples: accum.samples }]);
          bgModelAccumRef.current = null;
          setBgModelCapturing(false);
          setBgModelAccumCount(0);
        }
      }
      if (bgModelTestRef.current) {
        const test = bgModelTestRef.current;
        test.samples.push({
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          lidar_standoff_mm: standoffMm,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
        });
        setBgModelTestCount(test.samples.length);

        if (test.samples.length >= 5) {
          const result = runPhaseUnwindTest(test.samples, sfcwParamsRef.current);
          setBgModelTestResult(result);
          bgModelTestRef.current = null;
          setBgModelTesting(false);
          setBgModelTestCount(0);
        }
      }
      setSfcwProgress(null);
    } else if (msg.type === 'sfcw_progress') {
      setSfcwProgress(msg);
    } else if (msg.type === 'sfcw_error') {
      setSfcwRunning(false);
      setSfcwProgress(null);
      if (bscanPendingRef.current) {
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      }
    } else if (msg.type === 'coherence_result') {
      setCoherenceResult(msg);
      setSfcwRunning(false);
    }
  }, []);

  const sdrUrl = piIp ? `ws://${piIp}:9003` : null;
  const { status: sdrConnectionStatus, send: sendSdr, connect: connectSdr, disconnect: disconnectSdr } = useWebSocket(sdrUrl, handleSdrMessage);

  const handleBscanAction = useCallback((action) => {
    if (action === 'start_session') {
      if (sfcwRunning) return;
      sendSdr({ cmd: 'sfcw_start' });
    } else if (action === 'stop_session') {
      sendSdr({ cmd: 'sfcw_stop' });
    } else if (action === 'add_scan') {
      setBscanCapturing(true);
      sendSdr({ cmd: 'bscan_capture' });
    } else if (action === 'capture_bg') {
      setBscanCapturing(true);
      sendSdr({ cmd: 'bscan_bg_capture' });
    } else if (action === 'clear_bg') {
      setBscanBgRef(null);
    } else if (action === 'new') {
      setBscanData([]);
    } else if (action === 'undo') {
      setBscanData(prev => prev.slice(0, -1));
    } else if (action === 'export') {
      const exportData = {
        version: 3,
        timestamp: new Date().toISOString(),
        params: bscanParams,
        sfcwParams: sfcwParams,
        lidarAntennaOffsetMm: LIDAR_ANTENNA_OFFSET_MM,
        data: bscanData,
        bgRef: bscanBgRef,
      };
      const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bscan_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (action === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (imported.data && Array.isArray(imported.data)) {
              setBscanData(imported.data);
              if (imported.bgRef) {
                setBscanBgRef(imported.bgRef);
              }
              if (imported.params) {
                const { stepSize, numPositions, wallStandoff, wallThickness, wallPermittivity } = imported.params;
                setBscanParams(prev => ({
                  ...prev,
                  ...(stepSize != null && { stepSize }),
                  ...(numPositions != null && { numPositions }),
                  ...(wallStandoff != null && { wallStandoff }),
                  ...(wallThickness != null && { wallThickness }),
                  ...(wallPermittivity != null && { wallPermittivity }),
                }));
              }
            }
          } catch (err) {
            console.error('Failed to import B-scan:', err);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }
  }, [sendSdr, sfcwRunning, bscanData, bscanParams, sfcwParams]);

  const handleBgModelAction = useCallback((action, payload) => {
    if (action === 'start_session') {
      if (sfcwRunning) return;
      sendSdr({ cmd: 'sfcw_start' });
    } else if (action === 'stop_session') {
      sendSdr({ cmd: 'sfcw_stop' });
    } else if (action === 'capture') {
      setBgModelCapturing(true);
      bgModelAccumRef.current = { samples: [] };
    } else if (action === 'undo') {
      setBgModelCaptures(prev => prev.slice(0, -1));
    } else if (action === 'clear') {
      setBgModelCaptures([]);
    } else if (action === 'build') {
      const allSamples = bgModelCaptures.flatMap(c => c.samples);
      if (allSamples.length < 5) return;
      bgModelWorker.startTraining(allSamples, sfcwParams);
    } else if (action === 'save_model') {
      if (!bgModelWorker.resultRef.current || !payload) return;
      const modelData = {
        ...bgModelWorker.resultRef.current,
        name: payload,
        created: new Date().toISOString(),
      };
      fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelData),
      }).then(r => r.json()).then(res => {
        if (res.success) bgModelWorker.reset();
      }).catch(err => console.error('Failed to save model:', err));
    } else if (action === 'export') {
      const exportData = {
        version: 1,
        type: 'bgmodel_training_data',
        timestamp: new Date().toISOString(),
        sfcwParams: sfcwParams,
        lidarAntennaOffsetMm: LIDAR_ANTENNA_OFFSET_MM,
        captures: bgModelCaptures,
      };
      const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bgmodel_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (action === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (imported.type === 'bgmodel_training_data' && Array.isArray(imported.captures)) {
              setBgModelCaptures(imported.captures);
            }
          } catch (err) {
            console.error('Failed to import BG model data:', err);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    } else if (action === 'test_phase') {
      setBgModelTesting(true);
      setBgModelTestResult(null);
      bgModelTestRef.current = { samples: [] };
    }
  }, [sendSdr, sfcwRunning, bgModelCaptures, sfcwParams, bgModelWorker.startTraining, bgModelWorker.reset, bgModelWorker.resultRef]);

  // Rate counter interval
  const rateIntervalRef = useRef(null);

  const handleConnect = useCallback(() => {
    if (!piIp.trim()) return;
    localStorage.setItem('pi_ip', piIp);
    connectImu();
    connectOptiflow();
    connectSdr();

    if (rateIntervalRef.current) clearInterval(rateIntervalRef.current);
    rateIntervalRef.current = setInterval(() => {
      setImuRate(imuCountRef.current);
      imuCountRef.current = 0;
      setOptiflowRate(optiflowCountRef.current);
      optiflowCountRef.current = 0;
    }, 1000);
  }, [piIp, connectImu, connectOptiflow, connectSdr]);

  const handleDisconnect = useCallback(() => {
    disconnectImu();
    disconnectOptiflow();
    disconnectSdr();
    if (rateIntervalRef.current) { clearInterval(rateIntervalRef.current); rateIntervalRef.current = null; }
    setImuRate(0);
    setOptiflowRate(0);
  }, [disconnectImu, disconnectOptiflow, disconnectSdr]);

  const isConnected = imuStatus === 'connected';

  // Auto-connect on mount if a saved IP exists
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (!autoConnectedRef.current && piIp.trim()) {
      autoConnectedRef.current = true;
      handleConnect();
    }
  }, [handleConnect, piIp]);

  return (
    <div className="flex w-full min-h-screen bg-black">
      <Sidebar
        isConnected={isConnected}
        activePanel={activePanel}
        onActivePanelChange={setActivePanel}
        piIp={piIp}
        onPiIpChange={setPiIp}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        imuRate={imuRate}
        imuData={imuData}
        lidarMm={lidarMm}
        optiflowRate={optiflowRate}
        optiflowData={optiflowData}
        sdrConnected={sdrConnectionStatus === 'connected'}
        txActive={txActive}
        rxActive={rxActive}
        showFFT={showFFT}
        onToggleFFT={setShowFFT}
        graphPaused={graphPaused}
        onTogglePause={setGraphPaused}
        sendSdr={sendSdr}
        gyroComp={gyroComp}
        onGyroCompChange={(v) => {
          setGyroComp(v);
          sendOptiflow({ cmd: 'gyro_comp', enabled: v });
        }}
        sendOptiflow={sendOptiflow}
        sfcwRunning={sfcwRunning}
        sfcwStatus={sfcwStatus}
        sfcwParams={sfcwParams}
        onSfcwParamsChange={setSfcwParams}
        sfcwResult={processedSfcwResult}
        coherenceResult={coherenceResult}
        sfcwRangeScale={sfcwRangeScale}
        onSfcwRangeScaleChange={setSfcwRangeScale}
        sfcwBgModel={sfcwBgModel}
        onLoadSfcwBgModel={setSfcwBgModel}
        onClearSfcwBgModel={() => setSfcwBgModel(null)}
        bscanData={bscanData}
        bscanCapturing={bscanCapturing}
        bscanBgCaptured={bscanBgRef !== null}
        bgApplied={bgApplied}
        onBgAppliedChange={setBgApplied}
        bscanParams={bscanParams}
        onBscanParamsChange={setBscanParams}
        onBscanAction={handleBscanAction}
        svdEnabled={svdEnabled}
        svdK={svdK}
        svdStrength={svdStrength}
        onSvdEnabledChange={setSvdEnabled}
        onSvdKChange={setSvdK}
        onSvdStrengthChange={setSvdStrength}
        bscanScaleMode={bscanScaleMode}
        onBscanScaleModeChange={setBscanScaleMode}
        bscanDisplayMode={bscanDisplayMode}
        onBscanDisplayModeChange={setBscanDisplayMode}
        bgStandoffMm={bgStandoffMm}
        onBgStandoffMmChange={setBgStandoffMm}
        alignEnabled={alignEnabled}
        onAlignEnabledChange={setAlignEnabled}
        alignNormEnabled={alignNormEnabled}
        onAlignNormEnabledChange={setAlignNormEnabled}
        alignSvdEnabled={alignSvdEnabled}
        alignSvdK={alignSvdK}
        alignSvdStrength={alignSvdStrength}
        onAlignSvdEnabledChange={setAlignSvdEnabled}
        onAlignSvdKChange={setAlignSvdK}
        onAlignSvdStrengthChange={setAlignSvdStrength}
        sarBscanData={sarBscanInput}
        sarResult={sarResult}
        sarProgress={sarProgress}
        sarBgEnabled={sarBgEnabled}
        onSarBgEnabledChange={setSarBgEnabled}
        sarSvdEnabled={sarSvdEnabled}
        sarSvdK={sarSvdK}
        sarSvdStrength={sarSvdStrength}
        onSarSvdEnabledChange={setSarSvdEnabled}
        onSarSvdKChange={setSarSvdK}
        onSarSvdStrengthChange={setSarSvdStrength}
        sarScaleMode={sarScaleMode}
        onSarScaleModeChange={setSarScaleMode}
        sarAperture={sarAperture}
        onSarApertureChange={setSarAperture}
        sarCoherent={sarCoherent}
        onSarCoherentChange={setSarCoherent}
        sarDynRange={sarDynRange}
        onSarDynRangeChange={setSarDynRange}
        mapBscanData={mapBscanData}
        mapGateStart={mapGateStart}
        mapGateEnd={mapGateEnd}
        onMapGateStartChange={setMapGateStart}
        onMapGateEndChange={setMapGateEnd}
        mapDynRange={mapDynRange}
        onMapDynRangeChange={setMapDynRange}
        mapMetric={mapMetric}
        onMapMetricChange={setMapMetric}
        mapFocusEnabled={mapFocusEnabled}
        mapFocusAperture={mapFocusAperture}
        onMapFocusEnabledChange={setMapFocusEnabled}
        onMapFocusApertureChange={setMapFocusAperture}
        mapSvdEnabled={mapSvdEnabled}
        mapSvdK={mapSvdK}
        mapSvdStrength={mapSvdStrength}
        onMapSvdEnabledChange={setMapSvdEnabled}
        onMapSvdKChange={setMapSvdK}
        onMapSvdStrengthChange={setMapSvdStrength}
        bgModelCaptures={bgModelCaptures}
        bgModelCapturing={bgModelCapturing}
        bgModelAccumCount={bgModelAccumCount}
        bgModelTesting={bgModelTesting}
        bgModelTestCount={bgModelTestCount}
        bgModelTestResult={bgModelTestResult}
        bgModelTraining={bgModelWorker.trainingState}
        bgModelTrainProgress={bgModelWorker.progress}
        bgModelTrainResult={bgModelWorker.result}
        bgModelTrainError={bgModelWorker.error}
        onBgModelAction={handleBgModelAction}
      />
      <Viewport
        activePanel={activePanel}
        isConnected={isConnected}
        piIp={piIp}
        imuData={imuData}
        optiflowData={optiflowData}
        txActive={txActive}
        rxActive={rxActive}
        rxSamples={rxSamples}
        fftData={fftData}
        showFFT={showFFT}
        graphPaused={graphPaused}
        sfcwResult={processedSfcwResult}
        sfcwProgress={sfcwProgress}
        sfcwRunning={sfcwRunning}
        sfcwRangeScale={sfcwRangeScale}
        bscanData={filteredBscanData}
        bscanAlignedSvdData={alignedSvdData}
        bscanBgDisplay={bscanBgDisplay}
        bscanAlignShifts={alignShifts}
        bscanParams={bscanParams}
        bscanCapturing={bscanCapturing}
        bscanScaleMode={bscanScaleMode}
        bscanDisplayMode={bscanDisplayMode}
        sarResult={sarResult}
        sarProgress={sarProgress}
        sarScaleMode={sarScaleMode}
        sarDynRange={sarDynRange}
        mapBscanData={mapBscanData}
        mapGateStart={mapGateStart}
        mapGateEnd={mapGateEnd}
        mapDynRange={mapDynRange}
        mapMetric={mapMetric}
        mapStepSize={bscanParams.stepSize}
        mapFocusEnabled={mapFocusEnabled}
        mapFocusAperture={mapFocusAperture}
        bgModelCaptures={bgModelCaptures}
        bgModelCapturing={bgModelCapturing}
      />
    </div>
  );
}
