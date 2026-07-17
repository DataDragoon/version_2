// AquaSense — bladeRF signal generator + oscilloscope debug panel

(function () {
    'use strict';

    let ws = null;
    let connected = false;
    let state = { tx_active: false, rx_active: false };
    let txShape = null;
    let rxData = null;
    let fftData = null;
    let showFFT = true;
    let animFrame = null;

    // Canvas refs
    const txCanvas = document.getElementById('sdr-tx-canvas');
    const rxCanvas = document.getElementById('sdr-rx-canvas');
    const fftCanvas = document.getElementById('sdr-fft-canvas');

    // Control refs
    const freqInput = document.getElementById('sdr-freq');
    const setFreqBtn = document.getElementById('sdr-set-freq');
    const sampleRateSelect = document.getElementById('sdr-sample-rate');
    const waveformSelect = document.getElementById('sdr-waveform');
    const cwOffsetInput = document.getElementById('sdr-cw-offset');
    const chirpBwInput = document.getElementById('sdr-chirp-bw');
    const chirpDurInput = document.getElementById('sdr-chirp-dur');
    const txGainSlider = document.getElementById('sdr-tx-gain');
    const txGainVal = document.getElementById('sdr-tx-gain-val');
    const txAmpSlider = document.getElementById('sdr-tx-amp');
    const txAmpVal = document.getElementById('sdr-tx-amp-val');
    const rxGainSlider = document.getElementById('sdr-rx-gain');
    const rxGainVal = document.getElementById('sdr-rx-gain-val');
    const txToggle = document.getElementById('sdr-tx-toggle');
    const rxToggle = document.getElementById('sdr-rx-toggle');
    const fftToggle = document.getElementById('sdr-fft-toggle');
    const deviceStatus = document.getElementById('sdr-device-status');
    const serialEl = document.getElementById('sdr-serial');
    const sdrStatusEl = document.getElementById('sdr-status');
    const offsetRow = document.getElementById('sdr-offset-row');
    const chirpBwRow = document.getElementById('sdr-chirp-bw-row');
    const chirpDurRow = document.getElementById('sdr-chirp-dur-row');

    // --- Public API ---
    window.aquasensePanel = { start, stop };

    function start(ip) {
        if (connected) return;
        ws = new WebSocket(`ws://${ip}:9003`);
        ws.onopen = () => {
            connected = true;
            sdrStatusEl.textContent = 'Connected';
            startRenderLoop();
        };
        ws.onmessage = (e) => dispatch(JSON.parse(e.data));
        ws.onclose = () => { cleanup(); };
        ws.onerror = () => { if (ws) ws.close(); };
    }

    function stop() {
        if (ws) { ws.close(); ws = null; }
        cleanup();
    }

    function cleanup() {
        connected = false;
        ws = null;
        state = { tx_active: false, rx_active: false };
        txShape = null;
        rxData = null;
        fftData = null;
        deviceStatus.textContent = 'Disconnected';
        serialEl.textContent = '—';
        sdrStatusEl.textContent = '—';
        txToggle.textContent = 'Start TX';
        txToggle.classList.remove('active');
        rxToggle.textContent = 'Start RX';
        rxToggle.classList.remove('active');
        if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    }

    function send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    // --- Message dispatch ---
    function dispatch(msg) {
        switch (msg.type) {
            case 'status': updateStatus(msg); break;
            case 'tx_shape': txShape = msg; break;
            case 'rx_data': rxData = msg; break;
            case 'rx_fft': fftData = msg; break;
            case 'error': console.warn('[sdr]', msg.message); break;
        }
    }

    function updateStatus(s) {
        state = s;
        const mode = s.simulated ? 'Simulated' : 'Connected';
        deviceStatus.textContent = mode;
        serialEl.textContent = s.serial || '—';
        txToggle.textContent = s.tx_active ? 'Stop TX' : 'Start TX';
        txToggle.classList.toggle('active', s.tx_active);
        rxToggle.textContent = s.rx_active ? 'Stop RX' : 'Start RX';
        rxToggle.classList.toggle('active', s.rx_active);
    }

    // --- Controls ---
    setFreqBtn.addEventListener('click', () => {
        send({ cmd: 'set_freq', value: parseFloat(freqInput.value) });
    });

    sampleRateSelect.addEventListener('change', () => {
        send({ cmd: 'set_sample_rate', value: parseFloat(sampleRateSelect.value) });
    });

    waveformSelect.addEventListener('change', () => {
        const type = waveformSelect.value;
        offsetRow.style.display = type === 'cw' ? '' : 'none';
        chirpBwRow.style.display = type === 'chirp' ? '' : 'none';
        chirpDurRow.style.display = type === 'chirp' ? '' : 'none';
        sendWaveform();
    });

    cwOffsetInput.addEventListener('change', sendWaveform);
    chirpBwInput.addEventListener('change', sendWaveform);
    chirpDurInput.addEventListener('change', sendWaveform);

    txAmpSlider.addEventListener('input', () => {
        txAmpVal.textContent = txAmpSlider.value + '%';
    });
    txAmpSlider.addEventListener('change', sendWaveform);

    function sendWaveform() {
        const cmd = {
            cmd: 'set_waveform',
            type: waveformSelect.value,
            offset_khz: parseFloat(cwOffsetInput.value),
            amplitude: parseInt(txAmpSlider.value) / 100,
            chirp_bw_khz: parseFloat(chirpBwInput.value),
            chirp_duration_ms: parseFloat(chirpDurInput.value),
        };
        send(cmd);
    }

    txGainSlider.addEventListener('input', () => {
        txGainVal.textContent = txGainSlider.value + ' dB';
    });
    txGainSlider.addEventListener('change', () => {
        send({ cmd: 'set_tx_gain', value: parseInt(txGainSlider.value) });
    });

    rxGainSlider.addEventListener('input', () => {
        rxGainVal.textContent = rxGainSlider.value + ' dB';
    });
    rxGainSlider.addEventListener('change', () => {
        send({ cmd: 'set_rx_gain', value: parseInt(rxGainSlider.value) });
    });

    txToggle.addEventListener('click', () => {
        send({ cmd: state.tx_active ? 'stop_tx' : 'start_tx' });
    });

    rxToggle.addEventListener('click', () => {
        send({ cmd: state.rx_active ? 'stop_rx' : 'start_rx' });
    });

    fftToggle.addEventListener('change', () => {
        showFFT = fftToggle.checked;
    });

    // --- Canvas rendering ---
    const COLORS = {
        bg: '#1a1a25',
        grid: '#2a2a3a',
        i: '#4aff8a',
        q: '#4a9eff',
        fftFill: 'rgba(74, 158, 255, 0.3)',
        fftLine: '#4a9eff',
        text: '#6a6a7a',
        peak: '#ff4a6a',
    };

    function startRenderLoop() {
        if (animFrame) return;
        function frame() {
            render();
            animFrame = requestAnimationFrame(frame);
        }
        animFrame = requestAnimationFrame(frame);
    }

    function render() {
        drawScope(txCanvas, txShape, 'TX');
        drawScope(rxCanvas, rxData, 'RX');
        if (showFFT) {
            drawFFT(fftCanvas, fftData);
        } else {
            clearCanvas(fftCanvas);
        }
    }

    function clearCanvas(canvas) {
        const ctx = getCtx(canvas);
        if (!ctx) return;
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function getCtx(canvas) {
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const w = Math.floor(rect.width * devicePixelRatio);
        const h = Math.floor(rect.height * devicePixelRatio);
        if (w < 1 || h < 1) return null;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        return ctx;
    }

    function drawScope(canvas, data, label) {
        const ctx = getCtx(canvas);
        if (!ctx) return;
        const w = canvas.width / devicePixelRatio;
        const h = canvas.height / devicePixelRatio;

        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        const hLines = 4;
        const vLines = 8;
        ctx.beginPath();
        for (let i = 1; i < hLines; i++) {
            const y = (h / hLines) * i;
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
        }
        for (let i = 1; i < vLines; i++) {
            const x = (w / vLines) * i;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
        }
        ctx.stroke();

        // Center line
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);

        if (!data || !data.i || data.i.length === 0) {
            ctx.fillStyle = COLORS.text;
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(label + ' idle', w / 2, h / 2 + 4);
            return;
        }

        const samples = data.i;
        const qSamples = data.q;
        const len = samples.length;
        const xStep = w / (len - 1);
        const yMid = h / 2;
        const yScale = (h / 2) * 0.85;

        // I channel
        ctx.strokeStyle = COLORS.i;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
            const x = i * xStep;
            const y = yMid - samples[i] * yScale;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Q channel
        if (qSamples && qSamples.length > 0) {
            ctx.strokeStyle = COLORS.q;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            for (let i = 0; i < len; i++) {
                const x = i * xStep;
                const y = yMid - qSamples[i] * yScale;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // Y-axis labels
        ctx.fillStyle = COLORS.text;
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('+1', 4, 12);
        ctx.fillText(' 0', 4, yMid + 3);
        ctx.fillText('-1', 4, h - 4);

        // Legend
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.i;
        ctx.fillText('I', w - 20, 12);
        ctx.fillStyle = COLORS.q;
        ctx.fillText('Q', w - 4, 12);
    }

    function drawFFT(canvas, data) {
        const ctx = getCtx(canvas);
        if (!ctx) return;
        const w = canvas.width / devicePixelRatio;
        const h = canvas.height / devicePixelRatio;

        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let i = 1; i < 4; i++) {
            const y = (h / 4) * i;
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
        }
        for (let i = 1; i < 8; i++) {
            const x = (w / 8) * i;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
        }
        ctx.stroke();

        if (!data || !data.magnitudes || data.magnitudes.length === 0) {
            ctx.fillStyle = COLORS.text;
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('FFT idle', w / 2, h / 2 + 4);
            return;
        }

        const mags = data.magnitudes;
        const len = mags.length;
        const xStep = w / (len - 1);

        // Scale: -80 dB to 0 dB
        const dbMin = -80;
        const dbMax = 0;
        const dbRange = dbMax - dbMin;

        function dbToY(db) {
            const clamped = Math.max(dbMin, Math.min(dbMax, db));
            return h - ((clamped - dbMin) / dbRange) * h;
        }

        // Fill
        ctx.fillStyle = COLORS.fftFill;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < len; i++) {
            ctx.lineTo(i * xStep, dbToY(mags[i]));
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();

        // Line
        ctx.strokeStyle = COLORS.fftLine;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
            const x = i * xStep;
            const y = dbToY(mags[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Find and mark peak
        let peakIdx = 0;
        let peakVal = mags[0];
        for (let i = 1; i < len; i++) {
            if (mags[i] > peakVal) { peakVal = mags[i]; peakIdx = i; }
        }
        const peakX = peakIdx * xStep;
        const peakY = dbToY(peakVal);
        ctx.fillStyle = COLORS.peak;
        ctx.beginPath();
        ctx.arc(peakX, peakY, 4, 0, Math.PI * 2);
        ctx.fill();

        // Peak label
        ctx.fillStyle = COLORS.text;
        ctx.font = '9px monospace';
        ctx.textAlign = peakIdx > len / 2 ? 'right' : 'left';
        const freqSpan = data.freq_span || 2000000;
        const peakFreq = ((peakIdx / len) - 0.5) * freqSpan;
        const peakFreqKHz = (peakFreq / 1000).toFixed(0);
        ctx.fillText(peakVal.toFixed(1) + ' dB @ ' + peakFreqKHz + ' kHz', peakX + (peakIdx > len / 2 ? -8 : 8), peakY - 8);

        // Y-axis dB labels
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.text;
        ctx.fillText('0 dB', 4, 12);
        ctx.fillText('-40', 4, h / 2 + 3);
        ctx.fillText('-80', 4, h - 4);

        // X-axis frequency labels
        ctx.textAlign = 'center';
        const halfSpanKHz = (freqSpan / 2000).toFixed(0);
        ctx.fillText('-' + halfSpanKHz + 'k', 30, h - 4);
        ctx.fillText('0', w / 2, h - 4);
        ctx.fillText('+' + halfSpanKHz + 'k', w - 30, h - 4);
    }

})();
