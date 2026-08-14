import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Viewport from './components/Viewport';
import { svdFilter, powerIteration } from './lib/svd';
import { useSarWorker } from './hooks/useSarWorker';

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

  // SAR state (only SAR-specific params; depth/wall/svd come from bscan)
  const [sarParams, setSarParams] = useState({
    pixelsX: 100,
    pixelsZ: 100,
    window: 'blackman-harris',
    coherent: false,
    useAligned: false,
  });


  // SAR uses exactly what's displayed: aligned+shifted data when useAligned, else bscan data
  const sarInputData = useMemo(() => {
    if (!sarParams.useAligned) return filteredBscanData;
    const sourceData = alignedSvdData || filteredBscanData;
    const shifts = alignShifts.scanShifts;
    if (!shifts || shifts.length !== sourceData.length) return sourceData;
    // Bake alignment shifts into the data (shift magnitudes + distances)
    const binSpacing = sourceData[0].distances && sourceData[0].distances.length >= 2
      ? sourceData[0].distances[1] - sourceData[0].distances[0] : 0;
    if (binSpacing === 0) return sourceData;
    return sourceData.map((pos, i) => {
      const intShift = Math.round(shifts[i]);
      if (intShift === 0) return pos;
      const numBins = pos.magnitudes.length;
      const newMags = new Array(numBins);
      const newDist = new Array(numBins);
      for (let b = 0; b < numBins; b++) {
        const srcBin = b - intShift;
        if (srcBin >= 0 && srcBin < numBins) {
          newMags[b] = pos.magnitudes[srcBin];
          newDist[b] = pos.distances[srcBin] + intShift * binSpacing;
        } else {
          newMags[b] = pos.magnitudes[0];
          newDist[b] = (pos.distances[0] || 0) + b * binSpacing;
        }
      }
      return { ...pos, magnitudes: newMags, distances: newDist };
    });
  }, [sarParams.useAligned, filteredBscanData, alignedSvdData, alignShifts]);

  const { sarResult, sarProgress } = useSarWorker(sarInputData, bscanParams, sarParams);

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
        sfcwResult={sfcwResult}
        coherenceResult={coherenceResult}
        sfcwRangeScale={sfcwRangeScale}
        onSfcwRangeScaleChange={setSfcwRangeScale}
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
        sarBscanData={sarInputData}
        sarParams={sarParams}
        onSarParamsChange={setSarParams}
        sarResult={sarResult}
        sarProgress={sarProgress}
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
        sfcwResult={sfcwResult}
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
      />
    </div>
  );
}
