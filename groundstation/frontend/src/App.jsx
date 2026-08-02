import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Viewport from './components/Viewport';
import { svdFilter } from './lib/svd';
import { useSarWorker } from './hooks/useSarWorker';

const SPEED_OF_LIGHT = 299792458;

function computeRangeProfile(hCalReal, hCalImag, numSteps, stepSize, rangeOffset) {
  const nfftMin = numSteps * 4;
  const nfft = 1 << Math.ceil(Math.log2(nfftMin));
  const win = new Float64Array(numSteps);
  for (let i = 0; i < numSteps; i++) {
    win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (numSteps - 1)));
  }

  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < numSteps; i++) {
    re[i] = hCalReal[i] * win[i];
    im[i] = hCalImag[i] * win[i];
  }

  const out = fft(re, im, true);

  const maxRange = SPEED_OF_LIGHT / (2 * stepSize);
  const half = nfft / 2;
  const magnitudes = [];
  const distances = [];
  for (let i = 0; i < half; i++) {
    const d = (i / nfft) * maxRange - rangeOffset;
    if (d >= 0) {
      const mag = Math.sqrt(out.re[i] * out.re[i] + out.im[i] * out.im[i]);
      magnitudes.push(20 * Math.log10(mag + 1e-12));
      distances.push(d);
    }
  }
  return { magnitudes, distances };
}

function fft(re, im, inverse) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let i = 0; i < n; i++) { outRe[i] = re[i]; outIm[i] = im[i]; }

  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    const j = parseInt(i.toString(2).padStart(bits, '0').split('').reverse().join(''), 2);
    if (j > i) {
      [outRe[i], outRe[j]] = [outRe[j], outRe[i]];
      [outIm[i], outIm[j]] = [outIm[j], outIm[i]];
    }
  }

  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const sign = inverse ? -1 : 1;
    const angle = sign * 2 * Math.PI / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += size) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfSize; j++) {
        const tRe = curRe * outRe[i + j + halfSize] - curIm * outIm[i + j + halfSize];
        const tIm = curRe * outIm[i + j + halfSize] + curIm * outRe[i + j + halfSize];
        outRe[i + j + halfSize] = outRe[i + j] - tRe;
        outIm[i + j + halfSize] = outIm[i + j] - tIm;
        outRe[i + j] += tRe;
        outIm[i + j] += tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
  return { re: outRe, im: outIm };
}

function peakAlign(scanData) {
  const numBins = scanData[0].magnitudes.length;
  const peakIndices = scanData.map(pos => {
    let maxVal = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < pos.magnitudes.length; i++) {
      if (pos.magnitudes[i] > maxVal) {
        maxVal = pos.magnitudes[i];
        maxIdx = i;
      }
    }
    return maxIdx;
  });

  const maxPeakIdx = Math.max(...peakIndices);
  const distances = scanData[0].distances;

  return scanData.map((pos, i) => {
    const shift = maxPeakIdx - peakIndices[i];
    if (shift === 0) return pos;
    const fillVal = pos.magnitudes[0];
    const newMags = new Array(numBins).fill(fillVal);
    for (let j = 0; j < numBins; j++) {
      const srcIdx = j - shift;
      if (srcIdx >= 0 && srcIdx < numBins) {
        newMags[j] = pos.magnitudes[srcIdx];
      }
    }
    return { ...pos, magnitudes: newMags, distances };
  });
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
  const [bscanBgCaptured, setBscanBgCaptured] = useState(false);
  const bscanPendingRef = useRef(null);
  const [bscanParams, setBscanParams] = useState({
    stepSize: 5,
    numPositions: 20,
    wallStandoff: 0,
    wallThickness: 15,
    wallPermittivity: 4.5,
  });

  // B-scan SVD filter state (used by bscan panel + sar)
  const [svdEnabled, setSvdEnabled] = useState(false);
  const [svdK, setSvdK] = useState(1);
  const [svdStrength, setSvdStrength] = useState(0.5);

  const filteredBscanData = useMemo(() => {
    if (!svdEnabled || bscanData.length < 2) return bscanData;
    return svdFilter(bscanData, svdK, svdStrength);
  }, [bscanData, svdEnabled, svdK, svdStrength]);

  // SAR state (only SAR-specific params; depth/wall/svd come from bscan)
  const [sarParams, setSarParams] = useState({
    pixelsX: 100,
    pixelsZ: 100,
    window: 'blackman-harris',
  });

  const { sarResult, sarProgress } = useSarWorker(filteredBscanData, bscanParams, sarParams, svdEnabled, svdK);

  // Aligned panel state — independent processing pipeline
  const [alignEnabled, setAlignEnabled] = useState(true);
  const [alignBgRef, setAlignBgRef] = useState(null);
  const [alignSvdEnabled, setAlignSvdEnabled] = useState(false);
  const [alignSvdK, setAlignSvdK] = useState(1);
  const [alignSvdStrength, setAlignSvdStrength] = useState(0.5);

  // Aligned pipeline: IFFT → peak align → normalized BG subtract → SVD
  const alignedDisplayData = useMemo(() => {
    if (bscanData.length === 0) return [];
    const startHz = sfcwParams.startFreq * 1e6;
    const stopHz = sfcwParams.stopFreq * 1e6;

    // Step 1: compute range profiles from raw complex
    let processed = bscanData.map(pos => {
      if (!pos.h_cal_real || !pos.h_cal_imag) return pos;
      const numSteps = pos.h_cal_real.length;
      const rp = computeRangeProfile(pos.h_cal_real, pos.h_cal_imag, numSteps, pos.step_size, pos.range_offset);
      const freqs = [];
      for (let i = 0; i < numSteps; i++) {
        freqs.push(startHz + (i / (numSteps - 1)) * (stopHz - startHz));
      }
      return { ...pos, magnitudes: rp.magnitudes, distances: rp.distances, freqs };
    });

    // Step 2: peak align across scans
    if (alignEnabled && processed.length >= 2) {
      processed = peakAlign(processed);
    }

    // Step 3: normalized BG subtract (align BG peak to each scan's peak, normalize, subtract)
    if (alignBgRef && alignBgRef.h_cal_real && alignBgRef.h_cal_imag) {
      const bgNumSteps = alignBgRef.h_cal_real.length;
      const bgRp = computeRangeProfile(alignBgRef.h_cal_real, alignBgRef.h_cal_imag, bgNumSteps, alignBgRef.step_size, alignBgRef.range_offset);
      const bgNumBins = bgRp.magnitudes.length;

      let bgPeakIdx = 0;
      let bgPeakVal = -Infinity;
      for (let i = 0; i < bgNumBins; i++) {
        if (bgRp.magnitudes[i] > bgPeakVal) { bgPeakVal = bgRp.magnitudes[i]; bgPeakIdx = i; }
      }
      const bgPeakLin = Math.pow(10, bgPeakVal / 20);

      processed = processed.map(pos => {
        if (!pos.magnitudes) return pos;
        const numBins = pos.magnitudes.length;

        let scanPeakIdx = 0;
        let scanPeakVal = -Infinity;
        for (let i = 0; i < numBins; i++) {
          if (pos.magnitudes[i] > scanPeakVal) { scanPeakVal = pos.magnitudes[i]; scanPeakIdx = i; }
        }
        const scanPeakLin = Math.pow(10, scanPeakVal / 20);

        const bgShift = scanPeakIdx - bgPeakIdx;
        const normFactor = scanPeakLin / bgPeakLin;

        const newMags = new Array(numBins);
        for (let i = 0; i < numBins; i++) {
          const scanLin = Math.pow(10, pos.magnitudes[i] / 20);
          const bgSrcIdx = i - bgShift;
          const bgDb = (bgSrcIdx >= 0 && bgSrcIdx < bgNumBins) ? bgRp.magnitudes[bgSrcIdx] : bgRp.magnitudes[0];
          const bgLin = Math.pow(10, bgDb / 20) * normFactor;
          const diff = Math.max(scanLin - bgLin, 1e-12);
          newMags[i] = 20 * Math.log10(diff);
        }
        return { ...pos, magnitudes: newMags };
      });
    }

    // Step 4: SVD
    if (alignSvdEnabled && processed.length >= 2) {
      processed = svdFilter(processed, alignSvdK, alignSvdStrength);
    }

    return processed;
  }, [bscanData, sfcwParams.startFreq, sfcwParams.stopFreq, alignEnabled, alignBgRef, alignSvdEnabled, alignSvdK, alignSvdStrength]);

  // IMU WebSocket
  const handleImuMessage = useCallback((msg) => {
    imuCountRef.current++;
    setImuData(msg);
    if (msg.lidar !== null && msg.lidar !== undefined) {
      setLidarMm(msg.lidar);
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
      if (msg.background_active !== undefined) {
        setBscanBgCaptured(msg.background_active);
      }
    } else if (msg.type === 'sfcw_result') {
      if (bscanPendingRef.current === 'capture') {
        const posData = {
          magnitudes: [...msg.magnitudes],
          distances: [...msg.distances],
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
        };
        setBscanData(prev => [...prev, posData]);
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      } else if (bscanPendingRef.current === 'capture_bg') {
        setBscanBgCaptured(true);
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      } else if (bscanPendingRef.current === 'capture_align_bg') {
        setAlignBgRef({
          h_cal_real: msg.h_cal_real ? [...msg.h_cal_real] : null,
          h_cal_imag: msg.h_cal_imag ? [...msg.h_cal_imag] : null,
          num_steps: msg.num_steps,
          step_size: msg.step_size,
          range_offset: msg.range_offset,
        });
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      } else {
        setSfcwResult(msg);
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
    if (action === 'capture') {
      bscanPendingRef.current = 'capture';
      setBscanCapturing(true);
      sendSdr({ cmd: 'sweep_capture' });
    } else if (action === 'capture_bg') {
      bscanPendingRef.current = 'capture_bg';
      setBscanCapturing(true);
      sendSdr({ cmd: 'sweep_capture_bg' });
    } else if (action === 'clear_bg') {
      sendSdr({ cmd: 'bscan_clear_bg' });
      setBscanBgCaptured(false);
    } else if (action === 'new') {
      setBscanData([]);
    } else if (action === 'undo') {
      setBscanData(prev => prev.slice(0, -1));
    } else if (action === 'export') {
      const exportData = {
        version: 1,
        timestamp: new Date().toISOString(),
        params: bscanParams,
        sfcwParams: sfcwParams,
        data: bscanData,
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
  }, [sendSdr, bscanData, bscanParams, sfcwParams]);

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
        bscanBgCaptured={bscanBgCaptured}
        bscanParams={bscanParams}
        onBscanParamsChange={setBscanParams}
        onBscanAction={handleBscanAction}
        svdEnabled={svdEnabled}
        svdK={svdK}
        svdStrength={svdStrength}
        onSvdEnabledChange={setSvdEnabled}
        onSvdKChange={setSvdK}
        onSvdStrengthChange={setSvdStrength}
        alignEnabled={alignEnabled}
        onAlignEnabledChange={setAlignEnabled}
        alignBgCaptured={alignBgRef !== null}
        onAlignBgCapture={() => {
          bscanPendingRef.current = 'capture_align_bg';
          setBscanCapturing(true);
          sendSdr({ cmd: 'sweep_capture' });
        }}
        onAlignBgClear={() => setAlignBgRef(null)}
        alignSvdEnabled={alignSvdEnabled}
        alignSvdK={alignSvdK}
        alignSvdStrength={alignSvdStrength}
        onAlignSvdEnabledChange={setAlignSvdEnabled}
        onAlignSvdKChange={setAlignSvdK}
        onAlignSvdStrengthChange={setAlignSvdStrength}
        alignedDisplayData={alignedDisplayData}
        sarBscanData={bscanData}
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
        bscanParams={bscanParams}
        bscanCapturing={bscanCapturing}
        alignedDisplayData={alignedDisplayData}
        sarResult={sarResult}
        sarProgress={sarProgress}
      />
    </div>
  );
}
