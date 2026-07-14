// IMU debug panel — 3D orientation + live data
// Browser connects directly to Pi's WebSocket

(function () {
    'use strict';

    // --- Panel navigation ---
    const navItems = document.querySelectorAll('.nav-item[data-panel]');
    const panels = document.querySelectorAll('.panel');

    navItems.forEach(item => {
        if (item.classList.contains('disabled')) return;
        item.addEventListener('click', () => {
            navItems.forEach(n => n.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            item.classList.add('active');
            const panel = document.getElementById('panel-' + item.dataset.panel);
            if (panel) panel.classList.add('active');
        });
    });

    // --- Connection management ---
    let ws = null;
    let packetCount = 0;
    let rateInterval = null;
    let piIp = null;

    const ipInput = document.getElementById('pi-ip');
    const connectBtn = document.getElementById('connect-btn');

    // Restore last-used IP
    const savedIp = localStorage.getItem('pi_ip');
    if (savedIp) ipInput.value = savedIp;

    connectBtn.addEventListener('click', connect);
    ipInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') connect();
    });

    function connect() {
        const ip = ipInput.value.trim();
        if (!ip) return;

        localStorage.setItem('pi_ip', ip);
        piIp = ip;

        if (ws) ws.close();

        connectBtn.textContent = '...';
        ws = new WebSocket(`ws://${ip}:9001`);

        ws.onopen = () => {
            connectBtn.textContent = 'Connected';
            connectBtn.disabled = true;
            document.getElementById('link-status').classList.add('connected');
            document.getElementById('link-status').classList.remove('disconnected');
            rateInterval = setInterval(() => {
                document.getElementById('imu-rate').textContent = packetCount + ' Hz';
                packetCount = 0;
            }, 1000);
            if (window.optiflowPanel) window.optiflowPanel.start(piIp);
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            packetCount++;
            updateDisplay(data);
            updateOrientation(data);
            if (window.imuCalUpdate) window.imuCalUpdate(data);
        };

        ws.onclose = () => {
            connectBtn.textContent = 'Connect';
            connectBtn.disabled = false;
            document.getElementById('link-status').classList.remove('connected');
            document.getElementById('link-status').classList.add('disconnected');
            document.getElementById('imu-rate').textContent = '— Hz';
            if (rateInterval) { clearInterval(rateInterval); rateInterval = null; }
            if (window.optiflowPanel) window.optiflowPanel.stop();
        };

        ws.onerror = () => {
            ws.close();
        };
    }

    function updateDisplay(data) {
        const [ax, ay, az] = data.accel;
        const [gx, gy, gz] = data.gyro;

        document.getElementById('ax').textContent = ax.toFixed(4);
        document.getElementById('ay').textContent = ay.toFixed(4);
        document.getElementById('az').textContent = az.toFixed(4);
        document.getElementById('gx').textContent = gx.toFixed(2);
        document.getElementById('gy').textContent = gy.toFixed(2);
        document.getElementById('gz').textContent = gz.toFixed(2);
        document.getElementById('temp').textContent = data.temp.toFixed(1);

        const lidarMm = document.getElementById('lidar-dist-mm');
        const lidarCm = document.getElementById('lidar-dist-cm');
        if (data.lidar !== null && data.lidar !== undefined) {
            lidarMm.textContent = data.lidar;
            lidarCm.textContent = (data.lidar / 10).toFixed(1);
        } else {
            lidarMm.textContent = '—';
            lidarCm.textContent = '—';
        }

        document.getElementById('roll').textContent = roll.toFixed(1);
        document.getElementById('pitch').textContent = pitch.toFixed(1);
        document.getElementById('yaw').textContent = yaw.toFixed(1);
    }

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

    // --- Madgwick AHRS filter ---
    // Quaternion-based orientation from gyro + accel fusion
    // Beta controls how aggressively accel corrects gyro drift
    // Higher = more accel trust (less drift, more noise), lower = smoother but drifts
    let q = [1, 0, 0, 0]; // w, x, y, z
    let lastTime = null;
    const BETA = 0.04; // Madgwick gain — 0.04 is a good balance
    const DEG = Math.PI / 180;
    let roll = 0, pitch = 0, yaw = 0;

    function madgwickUpdate(gx, gy, gz, ax, ay, az, dt) {
        let [qw, qx, qy, qz] = q;

        // Normalise accelerometer
        let norm = Math.sqrt(ax * ax + ay * ay + az * az);
        if (norm < 0.01) return; // free-fall, skip accel correction
        const recipNorm = 1.0 / norm;
        ax *= recipNorm;
        ay *= recipNorm;
        az *= recipNorm;

        // Gradient descent corrective step
        const _2qw = 2 * qw, _2qx = 2 * qx, _2qy = 2 * qy, _2qz = 2 * qz;
        const _4qw = 4 * qw, _4qx = 4 * qx, _4qy = 4 * qy;
        const _8qx = 8 * qx, _8qy = 8 * qy;
        const qwqw = qw * qw, qxqx = qx * qx, qyqy = qy * qy, qzqz = qz * qz;

        let s0 = _4qw * qyqy + _2qy * ax + _4qw * qxqx - _2qx * ay;
        let s1 = _4qx * qzqz - _2qz * ax + 4 * qwqw * qx - _2qw * ay - _4qx + _8qx * qxqx + _8qx * qyqy + _4qx * az;
        let s2 = 4 * qwqw * qy + _2qw * ax + _4qy * qzqz - _2qz * ay - _4qy + _8qy * qxqx + _8qy * qyqy + _4qy * az;
        let s3 = 4 * qxqx * qz - _2qx * ax + 4 * qyqy * qz - _2qy * ay;

        norm = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
        if (norm > 0) {
            const rn = 1.0 / norm;
            s0 *= rn; s1 *= rn; s2 *= rn; s3 *= rn;
        }

        // Convert gyro to rad/s
        const gxr = gx * DEG, gyr = gy * DEG, gzr = gz * DEG;

        // Quaternion rate from gyro
        const qDot0 = 0.5 * (-qx * gxr - qy * gyr - qz * gzr);
        const qDot1 = 0.5 * (qw * gxr + qy * gzr - qz * gyr);
        const qDot2 = 0.5 * (qw * gyr - qx * gzr + qz * gxr);
        const qDot3 = 0.5 * (qw * gzr + qx * gyr - qy * gxr);

        // Integrate
        qw += (qDot0 - BETA * s0) * dt;
        qx += (qDot1 - BETA * s1) * dt;
        qy += (qDot2 - BETA * s2) * dt;
        qz += (qDot3 - BETA * s3) * dt;

        // Normalise quaternion
        norm = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
        q = [qw / norm, qx / norm, qy / norm, qz / norm];
    }

    function quaternionToEuler(qw, qx, qy, qz) {
        // Body frame → roll/pitch/yaw (ZYX convention)
        const sinr = 2 * (qw * qx + qy * qz);
        const cosr = 1 - 2 * (qx * qx + qy * qy);
        const r = Math.atan2(sinr, cosr);

        const sinp = 2 * (qw * qy - qz * qx);
        const p = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);

        const siny = 2 * (qw * qz + qx * qy);
        const cosy = 1 - 2 * (qy * qy + qz * qz);
        const y = Math.atan2(siny, cosy);

        return [r / DEG, p / DEG, y / DEG];
    }

    function updateOrientation(data) {
        const [aFwd, aLeft, aUp] = data.accel;
        const [gRoll, gPitch, gYaw] = data.gyro;
        const now = data.timestamp;

        if (lastTime === null) {
            lastTime = now;
            return;
        }

        const dt = now - lastTime;
        lastTime = now;

        if (dt <= 0 || dt > 1) return;

        // Madgwick expects body-frame gyro (rad/s done inside) and accel (normalized inside)
        // Body frame: X=forward, Y=left, Z=up
        // Gravity in body frame when level: [0, 0, 1]
        madgwickUpdate(gRoll, gPitch, gYaw, aFwd, aLeft, aUp, dt);

        [roll, pitch, yaw] = quaternionToEuler(q[0], q[1], q[2], q[3]);

        // Update 3D model using quaternion directly
        // Body frame: X=forward, Y=left, Z=up
        // Three.js:   X=right,   Y=up,   Z=toward viewer (out of screen)
        // Axis mapping: three_x = -body_y, three_y = body_z, three_z = -body_x
        // For quaternion q=[w,bx,by,bz], remap imaginary part same way:
        //   three_qx = -body_qy, three_qy = body_qz, three_qz = -body_qx
        group.quaternion.set(-q[2], q[3], -q[1], q[0]);
    }

    // --- Render loop ---
    function animate() {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    }
    animate();

    // Auto-connect if we have a saved IP
    if (savedIp) connect();
})();
