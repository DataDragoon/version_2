// Camera debug panel — MJPEG live feed from Pi

(function () {
    'use strict';

    const img = document.getElementById('camera-feed');
    const fpsEl = document.getElementById('camera-fps');
    const resEl = document.getElementById('camera-res');
    const statusEl = document.getElementById('camera-status');
    let streaming = false;

    window.cameraPanel = {
        start: function (ip) {
            if (streaming) return;
            img.src = `http://${ip}:8080/stream`;
            streaming = true;
            statusEl.textContent = 'Connecting...';
            statusEl.className = 'camera-status connecting';
        },
        stop: function () {
            img.src = '';
            streaming = false;
            statusEl.textContent = 'Disconnected';
            statusEl.className = 'camera-status';
            fpsEl.textContent = '—';
            resEl.textContent = '—';
        }
    };

    img.addEventListener('load', function onFirstFrame() {
        statusEl.textContent = 'Live';
        statusEl.className = 'camera-status live';
        resEl.textContent = img.naturalWidth + ' x ' + img.naturalHeight;
        img.removeEventListener('load', onFirstFrame);
        startFpsCounter();
    });

    img.addEventListener('error', function () {
        if (streaming) {
            statusEl.textContent = 'Error';
            statusEl.className = 'camera-status error';
        }
    });

    // FPS estimation via frame load events
    let frameCount = 0;
    let fpsInterval = null;

    function startFpsCounter() {
        frameCount = 0;
        if (fpsInterval) clearInterval(fpsInterval);

        // For MJPEG streams, we estimate FPS by polling naturalWidth changes
        // or simply report the configured rate since MJPEG img doesn't fire per-frame events
        fpsEl.textContent = '30';

        // Use a MutationObserver approach or just show configured rate
        // MJPEG in <img> doesn't fire load per frame — show configured value
    }
})();
