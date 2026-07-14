// IMU Calibration & Orientation Discovery Tool
// Guides user through motions to determine axis mapping relative to camera

(function () {
    'use strict';

    const STATE = {
        step: 0,
        collecting: false,
        samples: [],
        results: {
            gravity_raw: null,
            gyro_bias: null,
            pitch_down: null,
            roll_right: null,
            yaw_right: null
        }
    };

    const STEPS = [
        {
            title: 'Hold Still — Level',
            instruction: 'Place the unit in its normal operating position (camera facing forward, unit level). Hold completely still for 3 seconds.',
            action: 'capture_static'
        },
        {
            title: 'Pitch Down',
            instruction: 'Starting from level, slowly tilt the camera DOWNWARD (nose down, like looking at the floor). Do a smooth ~45° tilt.',
            action: 'capture_pitch'
        },
        {
            title: 'Roll Right',
            instruction: 'Starting from level, slowly tilt the unit to the RIGHT (like tilting your head to the right shoulder). Smooth ~45°.',
            action: 'capture_roll'
        },
        {
            title: 'Yaw Right',
            instruction: 'Starting from level, slowly ROTATE the unit to the RIGHT (like turning your head to look right). Smooth ~90°.',
            action: 'capture_yaw'
        }
    ];

    const SAMPLE_DURATION_MS = 3000;
    const MOTION_DURATION_MS = 3000;

    // Live data (updated by main sensors.js ws)
    let liveAccel = [0, 0, 0];
    let liveGyro = [0, 0, 0];

    // Hook into the existing WebSocket data
    window.imuCalUpdate = function (data) {
        liveAccel = data.accel;
        liveGyro = data.gyro;
        updateBars();
        if (STATE.collecting) {
            STATE.samples.push({
                accel: [...data.accel],
                gyro: [...data.gyro],
                t: data.timestamp
            });
        }
    };

    // --- Bar graph rendering ---
    function updateBars() {
        const axes = ['x', 'y', 'z'];
        for (let i = 0; i < 3; i++) {
            const aBar = document.getElementById(`cal-abar-${axes[i]}`);
            const gBar = document.getElementById(`cal-gbar-${axes[i]}`);
            const aVal = document.getElementById(`cal-aval-${axes[i]}`);
            const gVal = document.getElementById(`cal-gval-${axes[i]}`);
            if (!aBar) continue;

            const aPercent = Math.min(Math.abs(liveAccel[i]) / 1.2, 1) * 100;
            const gPercent = Math.min(Math.abs(liveGyro[i]) / 100, 1) * 100;

            aBar.style.width = aPercent + '%';
            aBar.className = 'bar-fill' + (liveAccel[i] >= 0 ? ' positive' : ' negative');
            gBar.style.width = gPercent + '%';
            gBar.className = 'bar-fill' + (liveGyro[i] >= 0 ? ' positive' : ' negative');

            aVal.textContent = liveAccel[i].toFixed(4) + ' g';
            gVal.textContent = liveGyro[i].toFixed(2) + ' °/s';
        }
    }

    // --- Step logic ---
    function startStep() {
        const step = STEPS[STATE.step];
        document.getElementById('cal-step-title').textContent = `Step ${STATE.step + 1}/4: ${step.title}`;
        document.getElementById('cal-step-instruction').textContent = step.instruction;
        document.getElementById('cal-start-btn').textContent = STATE.step === 0 ? 'Start Capture' : 'Start Motion';
        document.getElementById('cal-start-btn').disabled = false;
        document.getElementById('cal-progress').style.width = '0%';
        document.getElementById('cal-status').textContent = 'Ready';
    }

    function beginCapture() {
        const step = STEPS[STATE.step];
        STATE.collecting = true;
        STATE.samples = [];

        const btn = document.getElementById('cal-start-btn');
        btn.disabled = true;

        const duration = STATE.step === 0 ? SAMPLE_DURATION_MS : MOTION_DURATION_MS;
        const statusEl = document.getElementById('cal-status');
        const progressEl = document.getElementById('cal-progress');
        statusEl.textContent = 'Collecting...';

        const startTime = Date.now();
        const timer = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const pct = Math.min(elapsed / duration * 100, 100);
            progressEl.style.width = pct + '%';

            if (elapsed >= duration) {
                clearInterval(timer);
                STATE.collecting = false;
                processCapture(step.action);
            }
        }, 50);
    }

    function processCapture(action) {
        const samples = STATE.samples;
        if (samples.length < 10) {
            document.getElementById('cal-status').textContent = 'ERROR: No data received. Is IMU connected?';
            document.getElementById('cal-start-btn').disabled = false;
            return;
        }

        if (action === 'capture_static') {
            // Average accel = gravity vector, average gyro = bias
            const avgAccel = avgAxis(samples, 'accel');
            const avgGyro = avgAxis(samples, 'gyro');
            STATE.results.gravity_raw = avgAccel;
            STATE.results.gyro_bias = avgGyro;

            document.getElementById('cal-status').textContent =
                `Gravity: [${avgAccel.map(v => v.toFixed(4)).join(', ')}] g | ` +
                `Gyro bias: [${avgGyro.map(v => v.toFixed(3)).join(', ')}] °/s`;
        } else {
            // Find which gyro axis had the largest absolute integral (total rotation)
            const bias = STATE.results.gyro_bias || [0, 0, 0];
            const integrals = [0, 0, 0];
            for (let i = 1; i < samples.length; i++) {
                const dt = samples[i].t - samples[i - 1].t;
                if (dt <= 0 || dt > 0.5) continue;
                for (let a = 0; a < 3; a++) {
                    integrals[a] += (samples[i].gyro[a] - bias[a]) * dt;
                }
            }

            // Also look at peak gyro rate
            const peakRate = [0, 0, 0];
            for (const s of samples) {
                for (let a = 0; a < 3; a++) {
                    const v = Math.abs(s.gyro[a] - bias[a]);
                    if (v > Math.abs(peakRate[a])) peakRate[a] = s.gyro[a] - bias[a];
                }
            }

            const axisNames = ['X', 'Y', 'Z'];
            const dominantIdx = indexOfMax(integrals.map(Math.abs));
            const sign = integrals[dominantIdx] > 0 ? '+' : '-';

            const result = {
                dominant_axis: axisNames[dominantIdx],
                sign: sign,
                integral_deg: integrals[dominantIdx],
                all_integrals: integrals,
                peak_rates: peakRate
            };

            if (action === 'capture_pitch') STATE.results.pitch_down = result;
            if (action === 'capture_roll') STATE.results.roll_right = result;
            if (action === 'capture_yaw') STATE.results.yaw_right = result;

            document.getElementById('cal-status').textContent =
                `Dominant: gyro ${sign}${axisNames[dominantIdx]} | ` +
                `Integrals: [${integrals.map(v => v.toFixed(1)).join(', ')}]°`;
        }

        // Advance
        STATE.step++;
        if (STATE.step < STEPS.length) {
            setTimeout(startStep, 500);
        } else {
            showResults();
        }
    }

    function showResults() {
        document.getElementById('cal-step-title').textContent = 'Complete!';
        document.getElementById('cal-step-instruction').textContent = 'Copy the text below and paste it to Claude.';
        document.getElementById('cal-start-btn').style.display = 'none';

        const r = STATE.results;
        const output = generateOutput(r);

        document.getElementById('cal-output').style.display = 'block';
        document.getElementById('cal-output-text').textContent = output;
        document.getElementById('cal-status').textContent = 'Done — copy the output below.';
    }

    function generateOutput(r) {
        const lines = [];
        lines.push('=== IMU ORIENTATION CALIBRATION RESULT ===');
        lines.push('');
        lines.push('GRAVITY VECTOR (unit level, camera forward):');
        lines.push(`  accel = [${r.gravity_raw.map(v => v.toFixed(4)).join(', ')}] g`);
        lines.push(`  (axis closest to 1g indicates "down" direction)`);
        lines.push('');
        lines.push('GYRO ZERO-RATE BIAS (stationary):');
        lines.push(`  gyro_bias = [${r.gyro_bias.map(v => v.toFixed(4)).join(', ')}] deg/s`);
        lines.push('');
        lines.push('PITCH DOWN (camera tilted toward floor):');
        if (r.pitch_down) {
            lines.push(`  dominant_gyro_axis = ${r.pitch_down.sign}${r.pitch_down.dominant_axis}`);
            lines.push(`  total_rotation = ${r.pitch_down.integral_deg.toFixed(1)} deg`);
            lines.push(`  all_integrals = [X:${r.pitch_down.all_integrals[0].toFixed(1)}, Y:${r.pitch_down.all_integrals[1].toFixed(1)}, Z:${r.pitch_down.all_integrals[2].toFixed(1)}] deg`);
        }
        lines.push('');
        lines.push('ROLL RIGHT (unit tilted right):');
        if (r.roll_right) {
            lines.push(`  dominant_gyro_axis = ${r.roll_right.sign}${r.roll_right.dominant_axis}`);
            lines.push(`  total_rotation = ${r.roll_right.integral_deg.toFixed(1)} deg`);
            lines.push(`  all_integrals = [X:${r.roll_right.all_integrals[0].toFixed(1)}, Y:${r.roll_right.all_integrals[1].toFixed(1)}, Z:${r.roll_right.all_integrals[2].toFixed(1)}] deg`);
        }
        lines.push('');
        lines.push('YAW RIGHT (rotated right, like turning head):');
        if (r.yaw_right) {
            lines.push(`  dominant_gyro_axis = ${r.yaw_right.sign}${r.yaw_right.dominant_axis}`);
            lines.push(`  total_rotation = ${r.yaw_right.integral_deg.toFixed(1)} deg`);
            lines.push(`  all_integrals = [X:${r.yaw_right.all_integrals[0].toFixed(1)}, Y:${r.yaw_right.all_integrals[1].toFixed(1)}, Z:${r.yaw_right.all_integrals[2].toFixed(1)}] deg`);
        }
        lines.push('');
        lines.push('=== END ===');
        return lines.join('\n');
    }

    function resetCal() {
        STATE.step = 0;
        STATE.collecting = false;
        STATE.samples = [];
        STATE.results = { gravity_raw: null, gyro_bias: null, pitch_down: null, roll_right: null, yaw_right: null };
        document.getElementById('cal-output').style.display = 'none';
        document.getElementById('cal-start-btn').style.display = '';
        startStep();
    }

    // --- Helpers ---
    function avgAxis(samples, key) {
        const sum = [0, 0, 0];
        for (const s of samples) {
            for (let i = 0; i < 3; i++) sum[i] += s[key][i];
        }
        return sum.map(v => v / samples.length);
    }

    function indexOfMax(arr) {
        let idx = 0;
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] > arr[idx]) idx = i;
        }
        return idx;
    }

    // --- Init ---
    document.addEventListener('DOMContentLoaded', () => {
        const startBtn = document.getElementById('cal-start-btn');
        const resetBtn = document.getElementById('cal-reset-btn');
        const copyBtn = document.getElementById('cal-copy-btn');

        if (startBtn) startBtn.addEventListener('click', beginCapture);
        if (resetBtn) resetBtn.addEventListener('click', resetCal);
        if (copyBtn) copyBtn.addEventListener('click', () => {
            const text = document.getElementById('cal-output-text').textContent;
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
            });
        });

        startStep();
    });
})();
