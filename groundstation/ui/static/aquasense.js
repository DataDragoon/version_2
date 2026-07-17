// AquaSense — bladeRF calibration panel (signal generator + oscilloscope)

(function () {
    'use strict';

    let ws = null;
    let connected = false;
    let state = { tx_active: false, rx_active: false };
    let rxSamples = null;
    let fftMags = null;
    let fftFreqSpan = 2000000;
    let showFFT = true;
    let animFrame = null;
    let txPhase = 0;

    const txCanvas = document.getElementById('sdr-tx-canvas');
    const rxCanvas = document.getElementById('sdr-rx-canvas');
    const fftCanvas = document.getElementById('sdr-fft-canvas');
    const fftCard = fftCanvas ? fftCanvas.closest('.viz-card') : null;

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
    const fftToggleEl = document.getElementById('sdr-fft-toggle');
    const deviceStatus = document.getElementById('sdr-device-status');
    const serialEl = document.getElementById('sdr-serial');
    const sdrStatusEl = document.getElementById('sdr-status');
    const offsetRow = document.getElementById('sdr-offset-row');
    const chirpBwRow = document.getElementById('sdr-chirp-bw-row');
    const chirpDurRow = document.getElementById('sdr-chirp-dur-row');

    window.aquasensePanel = { start, stop };

    function start(ip) {
        if (connected) return;
        ws = new WebSocket(`ws://${ip}:9003`);
        ws.onopen = () => {
            connected = true;
            sdrStatusEl.textContent = 'OK';
            startRender();
        };
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'status') updateStatus(msg);
            else if (msg.type === 'rx_data') rxSamples = msg.i;
            else if (msg.type === 'rx_fft') { fftMags = msg.magnitudes; fftFreqSpan = msg.freq_span || 2000000; }
            else if (msg.type === 'error') console.warn('[sdr]', msg.message);
        };
        ws.onclose = () => cleanup();
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
        rxSamples = null;
        fftMags = null;
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
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    function updateStatus(s) {
        state = s;
        deviceStatus.textContent = s.connected ? 'Connected' : 'Disconnected';
        serialEl.textContent = s.serial || '—';
        txToggle.textContent = s.tx_active ? 'Stop TX' : 'Start TX';
        txToggle.classList.toggle('active', s.tx_active);
        rxToggle.textContent = s.rx_active ? 'Stop RX' : 'Start RX';
        rxToggle.classList.toggle('active', s.rx_active);
    }

    // --- Controls ---
    setFreqBtn.addEventListener('click', () => send({ cmd: 'set_freq', value: parseFloat(freqInput.value) }));
    sampleRateSelect.addEventListener('change', () => send({ cmd: 'set_sample_rate', value: parseFloat(sampleRateSelect.value) }));

    waveformSelect.addEventListener('change', () => {
        const t = waveformSelect.value;
        offsetRow.style.display = t === 'cw' ? '' : 'none';
        chirpBwRow.style.display = t === 'chirp' ? '' : 'none';
        chirpDurRow.style.display = t === 'chirp' ? '' : 'none';
        sendWaveform();
    });
    cwOffsetInput.addEventListener('change', sendWaveform);
    chirpBwInput.addEventListener('change', sendWaveform);
    chirpDurInput.addEventListener('change', sendWaveform);
    txAmpSlider.addEventListener('input', () => { txAmpVal.textContent = txAmpSlider.value + '%'; });
    txAmpSlider.addEventListener('change', sendWaveform);

    function sendWaveform() {
        send({
            cmd: 'set_waveform', type: waveformSelect.value,
            offset_khz: parseFloat(cwOffsetInput.value),
            amplitude: parseInt(txAmpSlider.value) / 100,
            chirp_bw_khz: parseFloat(chirpBwInput.value),
            chirp_duration_ms: parseFloat(chirpDurInput.value),
        });
    }

    txGainSlider.addEventListener('input', () => { txGainVal.textContent = txGainSlider.value + ' dB'; });
    txGainSlider.addEventListener('change', () => send({ cmd: 'set_tx_gain', value: parseInt(txGainSlider.value) }));
    rxGainSlider.addEventListener('input', () => { rxGainVal.textContent = rxGainSlider.value + ' dB'; });
    rxGainSlider.addEventListener('change', () => send({ cmd: 'set_rx_gain', value: parseInt(rxGainSlider.value) }));

    txToggle.addEventListener('click', () => send({ cmd: state.tx_active ? 'stop_tx' : 'start_tx' }));
    rxToggle.addEventListener('click', () => send({ cmd: state.rx_active ? 'stop_rx' : 'start_rx' }));

    fftToggleEl.addEventListener('change', () => {
        showFFT = fftToggleEl.checked;
        if (fftCard) fftCard.style.display = showFFT ? '' : 'none';
    });

    // --- Rendering ---
    function startRender() {
        if (animFrame) return;
        (function loop() {
            render();
            animFrame = requestAnimationFrame(loop);
        })();
    }

    function render() {
        drawTx(txCanvas);
        drawRx(rxCanvas);
        if (showFFT) drawFFT(fftCanvas);
    }

    function fitCanvas(canvas) {
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        const dpr = devicePixelRatio;
        const w = Math.floor(r.width * dpr);
        const h = Math.floor(r.height * dpr);
        if (w < 1 || h < 1) return null;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    }

    function grid(ctx, w, h) {
        ctx.strokeStyle = '#1e1e2a';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let i = 1; i < 6; i++) { const y = h / 6 * i; ctx.moveTo(0, y); ctx.lineTo(w, y); }
        for (let i = 1; i < 12; i++) { const x = w / 12 * i; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        ctx.stroke();
    }

    function trace(ctx, pts, color) {
        if (pts.length < 2) return;
        // Glow
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
        ctx.restore();
        // Main
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
        // Highlight
        ctx.strokeStyle = lighten(color, 0.45);
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    function lighten(hex, a) {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return '#' + [r,g,b].map(c => Math.min(255, Math.floor(c + (255-c)*a)).toString(16).padStart(2,'0')).join('');
    }

    // --- TX: animated waveform (like aquasense WaveformDisplay) ---
    function drawTx(canvas) {
        const ctx = fitCanvas(canvas);
        if (!ctx) return;
        const w = canvas.width / devicePixelRatio;
        const h = canvas.height / devicePixelRatio;
        ctx.fillStyle = '#0d0d14';
        ctx.fillRect(0, 0, w, h);
        grid(ctx, w, h);

        if (!state.tx_active) {
            // Dashed center line when idle
            ctx.strokeStyle = '#2a2a3a';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }

        // Animate: scrolling sine (4 visible cycles)
        txPhase += 0.04;
        const cycles = 4;
        const n = 200;
        const yMid = h / 2;
        const amp = h * 0.38;
        const pts = [];
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1);
            const x = t * w;
            const y = yMid - Math.sin(t * cycles * Math.PI * 2 + txPhase) * amp;
            pts.push([x, y]);
        }
        trace(ctx, pts, '#D1855C');
    }

    // --- RX: live time-domain oscilloscope ---
    function drawRx(canvas) {
        const ctx = fitCanvas(canvas);
        if (!ctx) return;
        const w = canvas.width / devicePixelRatio;
        const h = canvas.height / devicePixelRatio;
        ctx.fillStyle = '#0d0d14';
        ctx.fillRect(0, 0, w, h);
        grid(ctx, w, h);

        if (!rxSamples || rxSamples.length === 0) {
            ctx.strokeStyle = '#2a2a3a';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }

        const samples = rxSamples;
        const len = samples.length;
        const yMid = h / 2;
        const yScale = h * 0.42;
        const pts = [];
        for (let i = 0; i < len; i++) {
            pts.push([i / (len - 1) * w, yMid - samples[i] * yScale]);
        }
        trace(ctx, pts, '#22d3ee');

        // Y labels
        ctx.fillStyle = '#4a4a5a';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('+1.0', 4, 12);
        ctx.fillText('-1.0', 4, h - 4);
    }

    // --- FFT spectrum ---
    function drawFFT(canvas) {
        const ctx = fitCanvas(canvas);
        if (!ctx) return;
        const w = canvas.width / devicePixelRatio;
        const h = canvas.height / devicePixelRatio;
        ctx.fillStyle = '#0d0d14';
        ctx.fillRect(0, 0, w, h);
        grid(ctx, w, h);

        if (!fftMags || fftMags.length === 0) {
            ctx.strokeStyle = '#2a2a3a';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }

        const mags = fftMags;
        const len = mags.length;
        const dbMin = -80, dbMax = 0;
        const margin = h * 0.05;
        const plotH = h - margin * 2;

        function toY(db) {
            const clamped = Math.max(dbMin, Math.min(dbMax, db));
            return margin + plotH * (1 - (clamped - dbMin) / (dbMax - dbMin));
        }

        // Fill gradient
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(139,92,246,0.3)');
        grad.addColorStop(1, 'rgba(139,92,246,0.0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < len; i++) ctx.lineTo(i / (len-1) * w, toY(mags[i]));
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();

        // Trace
        const pts = [];
        for (let i = 0; i < len; i++) pts.push([i / (len-1) * w, toY(mags[i])]);
        trace(ctx, pts, '#8b5cf6');

        // Peak
        let pk = 0;
        for (let i = 1; i < len; i++) if (mags[i] > mags[pk]) pk = i;
        const px = pk / (len-1) * w;
        const py = toY(mags[pk]);
        ctx.save();
        ctx.shadowColor = '#ff4a6a'; ctx.shadowBlur = 10;
        ctx.fillStyle = '#ff4a6a';
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI*2); ctx.fill();
        ctx.restore();

        const freq = ((pk / len) - 0.5) * fftFreqSpan / 1000;
        ctx.fillStyle = '#ccc';
        ctx.font = '10px monospace';
        ctx.textAlign = pk > len*0.7 ? 'right' : 'left';
        const lx = pk > len*0.7 ? px-8 : px+8;
        ctx.fillText(mags[pk].toFixed(1)+' dB', lx, py-12);
        ctx.fillStyle = '#8b5cf6';
        ctx.fillText(freq.toFixed(0)+' kHz', lx, py-1);

        // Axis
        ctx.fillStyle = '#4a4a5a';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('0 dB', 4, margin + 4);
        ctx.fillText('-80', 4, h - margin);
        ctx.textAlign = 'center';
        const hs = (fftFreqSpan/2000).toFixed(0);
        ctx.fillText('-'+hs+'k', w*0.05, h-2);
        ctx.fillText('0', w/2, h-2);
        ctx.fillText('+'+hs+'k', w*0.95, h-2);
    }

})();
