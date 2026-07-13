// OptiFlow debug panel — live camera feed with flow vector overlay

(function () {
    'use strict';

    const feed = document.getElementById('optiflow-feed');
    const overlay = document.getElementById('optiflow-overlay');
    const ctx = overlay.getContext('2d');
    const statusEl = document.getElementById('optiflow-status');

    let ws = null;
    let streaming = false;
    let packetCount = 0;
    let rateInterval = null;

    // --- Public interface (called by sensors.js on connect/disconnect) ---
    window.optiflowPanel = {
        start: function (ip) {
            if (streaming) return;
            streaming = true;

            // Start MJPEG feed
            feed.src = `http://${ip}:8080/stream`;
            statusEl.textContent = 'Connecting...';
            statusEl.className = 'camera-status connecting';

            // Start WebSocket for flow data
            ws = new WebSocket(`ws://${ip}:9002`);
            ws.onopen = () => {
                statusEl.textContent = 'Live';
                statusEl.className = 'camera-status live';
                rateInterval = setInterval(() => {
                    document.getElementById('flow-rate').textContent = packetCount + ' Hz';
                    packetCount = 0;
                }, 1000);
            };
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                packetCount++;
                updateStats(data);
                drawOverlay(data);
            };
            ws.onclose = () => {
                if (streaming) {
                    statusEl.textContent = 'Disconnected';
                    statusEl.className = 'camera-status';
                }
            };
            ws.onerror = () => ws.close();
        },
        stop: function () {
            streaming = false;
            feed.src = '';
            if (ws) { ws.close(); ws = null; }
            if (rateInterval) { clearInterval(rateInterval); rateInterval = null; }
            statusEl.textContent = 'Disconnected';
            statusEl.className = 'camera-status';
            document.getElementById('flow-rate').textContent = '— Hz';
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            resetStats();
        }
    };

    // --- FOV toggle ---
    const btnStandard = document.getElementById('fov-standard');
    const btnWide = document.getElementById('fov-wide');

    btnStandard.addEventListener('click', () => setFov('standard'));
    btnWide.addEventListener('click', () => setFov('wide'));

    function setFov(mode) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ cmd: 'set_fov', fov: mode }));
        }
        btnStandard.classList.toggle('active', mode === 'standard');
        btnWide.classList.toggle('active', mode === 'wide');
    }

    // --- Stats update ---
    function updateStats(data) {
        document.getElementById('of-keypoints').textContent = data.keypoints;
        document.getElementById('of-dx').textContent = data.mean_flow[0].toFixed(2);
        document.getElementById('of-dy').textContent = data.mean_flow[1].toFixed(2);
        document.getElementById('of-pos-x').textContent = data.position[0].toFixed(1);
        document.getElementById('of-pos-y').textContent = data.position[1].toFixed(1);
        document.getElementById('of-frame').textContent = data.frame;
        document.getElementById('of-fov').textContent = data.fov;
    }

    function resetStats() {
        ['of-keypoints', 'of-dx', 'of-dy', 'of-pos-x', 'of-pos-y', 'of-frame', 'of-fov']
            .forEach(id => { document.getElementById(id).textContent = '—'; });
    }

    // --- Canvas overlay for flow vectors ---
    function resizeOverlay() {
        const rect = feed.getBoundingClientRect();
        overlay.width = rect.width;
        overlay.height = rect.height;
    }

    feed.addEventListener('load', function onFirst() {
        resizeOverlay();
        feed.removeEventListener('load', onFirst);
    });
    window.addEventListener('resize', resizeOverlay);

    function drawOverlay(data) {
        if (!overlay.width || !overlay.height) resizeOverlay();
        if (!data.vectors || data.vectors.length === 0) {
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            return;
        }

        ctx.clearRect(0, 0, overlay.width, overlay.height);

        // Scale from camera resolution to canvas size
        const scaleX = overlay.width / 1920;
        const scaleY = overlay.height / 1080;
        const vectorScale = 5;

        ctx.strokeStyle = '#4aff8a';
        ctx.lineWidth = 1.5;
        ctx.fillStyle = '#4aff8a';

        for (const v of data.vectors) {
            const x = v.x * scaleX;
            const y = v.y * scaleY;
            const ex = x + v.dx * vectorScale * scaleX;
            const ey = y + v.dy * vectorScale * scaleY;

            // Line
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(ex, ey);
            ctx.stroke();

            // Dot at origin
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Mean flow indicator (center of frame)
        const cx = overlay.width / 2;
        const cy = overlay.height / 2;
        const mx = data.mean_flow[0] * vectorScale * 3 * scaleX;
        const my = data.mean_flow[1] * vectorScale * 3 * scaleY;

        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + mx, cy + my);
        ctx.stroke();

        // Arrow head
        ctx.fillStyle = '#4a9eff';
        ctx.beginPath();
        ctx.arc(cx + mx, cy + my, 4, 0, Math.PI * 2);
        ctx.fill();
    }
})();
