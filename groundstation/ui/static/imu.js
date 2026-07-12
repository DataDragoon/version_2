// IMU debug panel — 3D orientation + live data

(function () {
    'use strict';

    // --- Three.js 3D visualization ---
    const canvas = document.getElementById('imu-canvas');
    const container = canvas.parentElement;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a25);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(3, 2, 3);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

    // Board representation
    const boardGeo = new THREE.BoxGeometry(2, 0.15, 1.4);
    const boardMat = new THREE.MeshPhongMaterial({ color: 0x1a5c2a });
    const board = new THREE.Mesh(boardGeo, boardMat);

    // Chip on board
    const chipGeo = new THREE.BoxGeometry(0.4, 0.1, 0.4);
    const chipMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
    const chip = new THREE.Mesh(chipGeo, chipMat);
    chip.position.y = 0.125;

    const group = new THREE.Group();
    group.add(board);
    group.add(chip);
    scene.add(group);

    // Axes helper
    const axes = new THREE.AxesHelper(1.5);
    scene.add(axes);

    // Grid
    const grid = new THREE.GridHelper(6, 12, 0x2a2a3a, 0x1f1f2a);
    grid.position.y = -1.5;
    scene.add(grid);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 5, 5);
    scene.add(dirLight);

    function resize() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    window.addEventListener('resize', resize);
    resize();

    // --- Orientation estimation (complementary filter) ---
    let roll = 0, pitch = 0, yaw = 0;
    let lastTime = null;
    const ALPHA = 0.98;
    const DEG = Math.PI / 180;

    function updateOrientation(data) {
        const [ax, ay, az] = data.accel;
        const [gx, gy, gz] = data.gyro;
        const now = data.timestamp;

        // Accel-based angles
        const accelRoll = Math.atan2(ay, az) / DEG;
        const accelPitch = Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) / DEG;

        if (lastTime === null) {
            roll = accelRoll;
            pitch = accelPitch;
            yaw = 0;
            lastTime = now;
            return;
        }

        const dt = now - lastTime;
        lastTime = now;

        if (dt <= 0 || dt > 1) return;

        // Complementary filter
        roll = ALPHA * (roll + gx * dt) + (1 - ALPHA) * accelRoll;
        pitch = ALPHA * (pitch + gy * dt) + (1 - ALPHA) * accelPitch;
        yaw += gz * dt;

        // Update 3D model
        group.rotation.x = pitch * DEG;
        group.rotation.z = roll * DEG;
        group.rotation.y = yaw * DEG;
    }

    // --- Render loop ---
    function animate() {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    }
    animate();

    // --- Socket.IO connection ---
    const socket = io();
    let packetCount = 0;
    let rateInterval = null;

    socket.on('connect', () => {
        document.getElementById('link-status').classList.add('connected');
        document.getElementById('link-status').classList.remove('disconnected');
        rateInterval = setInterval(() => {
            document.getElementById('imu-rate').textContent = packetCount + ' Hz';
            packetCount = 0;
        }, 1000);
    });

    socket.on('disconnect', () => {
        document.getElementById('link-status').classList.remove('connected');
        document.getElementById('link-status').classList.add('disconnected');
        if (rateInterval) clearInterval(rateInterval);
        document.getElementById('imu-rate').textContent = '— Hz';
    });

    socket.on('imu_data', (data) => {
        packetCount++;

        // Update raw values
        const [ax, ay, az] = data.accel;
        const [gx, gy, gz] = data.gyro;

        document.getElementById('ax').textContent = ax.toFixed(4);
        document.getElementById('ay').textContent = ay.toFixed(4);
        document.getElementById('az').textContent = az.toFixed(4);
        document.getElementById('gx').textContent = gx.toFixed(2);
        document.getElementById('gy').textContent = gy.toFixed(2);
        document.getElementById('gz').textContent = gz.toFixed(2);
        document.getElementById('temp').textContent = data.temp.toFixed(1);

        // Update orientation
        updateOrientation(data);

        document.getElementById('roll').textContent = roll.toFixed(1);
        document.getElementById('pitch').textContent = pitch.toFixed(1);
        document.getElementById('yaw').textContent = yaw.toFixed(1);
    });
})();
