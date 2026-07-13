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

    document.getElementById('of-reset-origin').addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ cmd: 'reset_origin' }));
        }
    });

    window.optiflowPanel = {
        start: function (ip) {
            if (streaming) return;
            streaming = true;

            feed.src = `http://${ip}:8080/stream`;
            statusEl.textContent = 'Connecting...';
            statusEl.className = 'camera-status connecting';

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

    // focal length in pixels: f_px = (diag_px / 2) / tan(dfov / 2)
    // diag_px = sqrt(1920^2 + 1080^2) = 2203, dfov = 75deg
    const F_PX = 1436;

    function getLidarMm() {
        const el = document.getElementById('lidar-dist-mm');
        const val = parseFloat(el.textContent);
        return isNaN(val) ? null : val;
    }

    function formatReal(mm) {
        if (Math.abs(mm) >= 1000) return (mm / 1000).toFixed(3) + ' m';
        if (Math.abs(mm) >= 10) return (mm / 10).toFixed(2) + ' cm';
        return mm.toFixed(1) + ' mm';
    }

    function updateStats(data) {
        document.getElementById('of-fps').textContent = data.fps;
        document.getElementById('of-keypoints').textContent = data.keypoints;
        document.getElementById('of-dx').textContent = data.mean_flow[0].toFixed(2);
        document.getElementById('of-dy').textContent = data.mean_flow[1].toFixed(2);
        document.getElementById('of-pos-x').textContent = data.position[0].toFixed(1);
        document.getElementById('of-pos-y').textContent = data.position[1].toFixed(1);
        document.getElementById('of-frame').textContent = data.frame;

        const distMm = getLidarMm();
        if (distMm !== null) {
            const mmPerPx = distMm / F_PX;
            const realX = data.position[0] * mmPerPx;
            const realY = data.position[1] * mmPerPx;
            document.getElementById('of-real-x').textContent = formatReal(realX);
            document.getElementById('of-real-y').textContent = formatReal(realY);
            document.getElementById('of-height').textContent = formatReal(distMm);
        } else {
            document.getElementById('of-real-x').textContent = 'no LiDAR';
            document.getElementById('of-real-y').textContent = 'no LiDAR';
            document.getElementById('of-height').textContent = '—';
        }
    }

    function resetStats() {
        ['of-fps', 'of-keypoints', 'of-dx', 'of-dy', 'of-pos-x', 'of-pos-y', 'of-frame',
         'of-real-x', 'of-real-y', 'of-height']
            .forEach(id => { document.getElementById(id).textContent = '—'; });
    }

    function resizeOverlay() {
        const containerRect = feed.parentElement.getBoundingClientRect();
        const natW = feed.naturalWidth || 1920;
        const natH = feed.naturalHeight || 1080;
        const scale = Math.min(containerRect.width / natW, containerRect.height / natH);
        const w = natW * scale;
        const h = natH * scale;
        overlay.width = w;
        overlay.height = h;
        overlay.style.width = w + 'px';
        overlay.style.height = h + 'px';
        overlay.style.left = ((containerRect.width - w) / 2) + 'px';
        overlay.style.top = ((containerRect.height - h) / 2) + 'px';
    }

    feed.addEventListener('load', resizeOverlay);
    window.addEventListener('resize', resizeOverlay);

    function drawOverlay(data) {
        if (!overlay.width || !overlay.height) resizeOverlay();
        if (!data.vectors || data.vectors.length === 0) {
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            return;
        }

        ctx.clearRect(0, 0, overlay.width, overlay.height);

        const natW = feed.naturalWidth || 1920;
        const natH = feed.naturalHeight || 1080;
        const scaleX = overlay.width / natW;
        const scaleY = overlay.height / natH;
        const vectorScale = 5;

        ctx.strokeStyle = '#4aff8a';
        ctx.lineWidth = 1.5;
        ctx.fillStyle = '#4aff8a';

        for (const v of data.vectors) {
            const x = v.x * scaleX;
            const y = v.y * scaleY;
            const ex = x + v.dx * vectorScale * scaleX;
            const ey = y + v.dy * vectorScale * scaleY;

            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(ex, ey);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Mean flow indicator at center
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

        ctx.fillStyle = '#4a9eff';
        ctx.beginPath();
        ctx.arc(cx + mx, cy + my, 4, 0, Math.PI * 2);
        ctx.fill();
    }
})();
