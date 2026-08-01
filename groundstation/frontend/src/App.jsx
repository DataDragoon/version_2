import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Viewport from './components/Viewport';
import { svdFilter } from './lib/svd';
import { useSarWorker } from './hooks/useSarWorker';

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
    dbFloor: -90,
    dbCeil: -20,
    distMin: 0,
    distMax: null,
    wallEnabled: true,
    wallStandoff: 5,
    wallThickness: 15,
    wallPermittivity: 4.5,
  });

  // SVD filter state
  const [svdEnabled, setSvdEnabled] = useState(false);
  const [svdK, setSvdK] = useState(1);
  const [svdStrength, setSvdStrength] = useState(0.5);

  const filteredBscanData = useMemo(() => {
    if (!svdEnabled || bscanData.length < 2) return bscanData;
    return svdFilter(bscanData, svdK, svdStrength);
  }, [bscanData, svdEnabled, svdK, svdStrength]);

  // SAR state
  const [sarParams, setSarParams] = useState({
    pixelsX: 100,
    pixelsZ: 100,
    depthMin: 0.1,
    depthMax: 3.0,
    lateralMin: undefined,
    lateralMax: undefined,
    meanSubtract: true,
    svdEnabled: true,
    svdK: 2,
    window: 'blackman-harris',
    dbFloor: -85,
    dbCeil: -60,
    wallEnabled: true,
    wallStandoff: 5,
    wallThickness: 15,
    wallPermittivity: 4.5,
  });

  const { sarResult, sarProgress } = useSarWorker(bscanData, bscanParams, sarParams);

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
        const posData = { magnitudes: [...msg.magnitudes], distances: [...msg.distances] };
        setBscanData(prev => [...prev, posData]);
        bscanPendingRef.current = null;
        setBscanCapturing(false);
      } else if (bscanPendingRef.current === 'capture_bg') {
        setBscanBgCaptured(true);
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
                setBscanParams(prev => ({ ...prev, ...imported.params }));
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
        bscanData={filteredBscanData}
        bscanParams={bscanParams}
        bscanCapturing={bscanCapturing}
        sarResult={sarResult}
        sarProgress={sarProgress}
        sarParams={sarParams}
      />
    </div>
  );
}
