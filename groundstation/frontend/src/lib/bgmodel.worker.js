const SPEED_OF_LIGHT = 299792458;

let training = false;

self.onmessage = (e) => {
  const { type, data } = e.data;
  if (type === 'train') {
    training = true;
    try {
      const result = train(data);
      self.postMessage({ type: 'complete', result });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
    training = false;
  } else if (type === 'stop') {
    training = false;
  }
};

function train({ samples, sfcwParams, config }) {
  const { startFreq, stopFreq } = sfcwParams;
  const startHz = startFreq * 1e6;
  const stopHz = stopFreq * 1e6;
  const numSteps = samples[0].h_cal_real.length;
  const epochs = config.epochs || 2000;
  const lr = config.learningRate || 0.001;
  const hiddenSize = config.hiddenSize || 64;

  const freqs = new Float64Array(numSteps);
  for (let i = 0; i < numSteps; i++) {
    freqs[i] = startHz + (i / (numSteps - 1)) * (stopHz - startHz);
  }

  // Normalize distances to [0, 1]
  const rawDistances = samples.map(s => s.lidar_standoff_mm);
  const dMin = Math.min(...rawDistances);
  const dMax = Math.max(...rawDistances);
  const dRange = dMax - dMin || 1;

  // Phase-unwind all samples to get residuals
  const residuals = [];
  const normDistances = [];
  for (const sample of samples) {
    const d = sample.lidar_standoff_mm / 1000;
    const normD = (sample.lidar_standoff_mm - dMin) / dRange;
    normDistances.push(normD);

    const resReal = new Float64Array(numSteps);
    const resImag = new Float64Array(numSteps);
    for (let i = 0; i < numSteps; i++) {
      const phase = 4 * Math.PI * freqs[i] * d / SPEED_OF_LIGHT;
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);
      resReal[i] = sample.h_cal_real[i] * cosP - sample.h_cal_imag[i] * sinP;
      resImag[i] = sample.h_cal_real[i] * sinP + sample.h_cal_imag[i] * cosP;
    }
    residuals.push({ real: resReal, imag: resImag });
  }

  // Output size: numSteps * 2 (real + imag interleaved)
  const outputSize = numSteps * 2;
  const nSamples = samples.length;

  // Build target matrix
  const targets = new Float64Array(nSamples * outputSize);
  for (let s = 0; s < nSamples; s++) {
    for (let i = 0; i < numSteps; i++) {
      targets[s * outputSize + i] = residuals[s].real[i];
      targets[s * outputSize + numSteps + i] = residuals[s].imag[i];
    }
  }

  // Normalize targets
  let tMean = 0;
  for (let i = 0; i < targets.length; i++) tMean += targets[i];
  tMean /= targets.length;
  let tStd = 0;
  for (let i = 0; i < targets.length; i++) tStd += (targets[i] - tMean) ** 2;
  tStd = Math.sqrt(tStd / targets.length) || 1;
  const normTargets = new Float64Array(targets.length);
  for (let i = 0; i < targets.length; i++) normTargets[i] = (targets[i] - tMean) / tStd;

  // MLP: input(1) -> hidden1(hiddenSize) -> hidden2(hiddenSize) -> output(outputSize)
  // Xavier initialization
  const w1 = initWeights(hiddenSize, 1);
  const b1 = new Float64Array(hiddenSize);
  const w2 = initWeights(hiddenSize, hiddenSize);
  const b2 = new Float64Array(hiddenSize);
  const w3 = initWeights(outputSize, hiddenSize);
  const b3 = new Float64Array(outputSize);

  // Adam optimizer state
  const adam = {
    m_w1: new Float64Array(w1.length), v_w1: new Float64Array(w1.length),
    m_b1: new Float64Array(b1.length), v_b1: new Float64Array(b1.length),
    m_w2: new Float64Array(w2.length), v_w2: new Float64Array(w2.length),
    m_b2: new Float64Array(b2.length), v_b2: new Float64Array(b2.length),
    m_w3: new Float64Array(w3.length), v_w3: new Float64Array(w3.length),
    m_b3: new Float64Array(b3.length), v_b3: new Float64Array(b3.length),
    t: 0,
  };

  const losses = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    if (!training) break;

    let epochLoss = 0;

    // Forward + backward for all samples (full batch)
    const grad_w1 = new Float64Array(w1.length);
    const grad_b1 = new Float64Array(b1.length);
    const grad_w2 = new Float64Array(w2.length);
    const grad_b2 = new Float64Array(b2.length);
    const grad_w3 = new Float64Array(w3.length);
    const grad_b3 = new Float64Array(b3.length);

    for (let s = 0; s < nSamples; s++) {
      const x = normDistances[s];

      // Forward: layer 1
      const z1 = new Float64Array(hiddenSize);
      const a1 = new Float64Array(hiddenSize);
      for (let j = 0; j < hiddenSize; j++) {
        z1[j] = w1[j] * x + b1[j];
        a1[j] = z1[j] > 0 ? z1[j] : 0; // ReLU
      }

      // Forward: layer 2
      const z2 = new Float64Array(hiddenSize);
      const a2 = new Float64Array(hiddenSize);
      for (let j = 0; j < hiddenSize; j++) {
        let sum = b2[j];
        for (let k = 0; k < hiddenSize; k++) sum += w2[j * hiddenSize + k] * a1[k];
        z2[j] = sum;
        a2[j] = sum > 0 ? sum : 0; // ReLU
      }

      // Forward: output layer
      const out = new Float64Array(outputSize);
      for (let j = 0; j < outputSize; j++) {
        let sum = b3[j];
        for (let k = 0; k < hiddenSize; k++) sum += w3[j * hiddenSize + k] * a2[k];
        out[j] = sum;
      }

      // Loss (MSE)
      const target = normTargets.subarray(s * outputSize, (s + 1) * outputSize);
      const dOut = new Float64Array(outputSize);
      for (let j = 0; j < outputSize; j++) {
        const diff = out[j] - target[j];
        epochLoss += diff * diff;
        dOut[j] = 2 * diff / (nSamples * outputSize);
      }

      // Backward: output layer
      for (let j = 0; j < outputSize; j++) {
        grad_b3[j] += dOut[j];
        for (let k = 0; k < hiddenSize; k++) {
          grad_w3[j * hiddenSize + k] += dOut[j] * a2[k];
        }
      }

      // Backward: layer 2
      const da2 = new Float64Array(hiddenSize);
      for (let k = 0; k < hiddenSize; k++) {
        let sum = 0;
        for (let j = 0; j < outputSize; j++) sum += w3[j * hiddenSize + k] * dOut[j];
        da2[k] = z2[k] > 0 ? sum : 0;
      }
      for (let j = 0; j < hiddenSize; j++) {
        grad_b2[j] += da2[j];
        for (let k = 0; k < hiddenSize; k++) {
          grad_w2[j * hiddenSize + k] += da2[j] * a1[k];
        }
      }

      // Backward: layer 1
      const da1 = new Float64Array(hiddenSize);
      for (let k = 0; k < hiddenSize; k++) {
        let sum = 0;
        for (let j = 0; j < hiddenSize; j++) sum += w2[j * hiddenSize + k] * da2[j];
        da1[k] = z1[k] > 0 ? sum : 0;
      }
      for (let j = 0; j < hiddenSize; j++) {
        grad_b1[j] += da1[j];
        grad_w1[j] += da1[j] * x;
      }
    }

    epochLoss /= nSamples * outputSize;

    // Adam update
    adam.t++;
    adamUpdate(w1, grad_w1, adam.m_w1, adam.v_w1, adam.t, lr);
    adamUpdate(b1, grad_b1, adam.m_b1, adam.v_b1, adam.t, lr);
    adamUpdate(w2, grad_w2, adam.m_w2, adam.v_w2, adam.t, lr);
    adamUpdate(b2, grad_b2, adam.m_b2, adam.v_b2, adam.t, lr);
    adamUpdate(w3, grad_w3, adam.m_w3, adam.v_w3, adam.t, lr);
    adamUpdate(b3, grad_b3, adam.m_b3, adam.v_b3, adam.t, lr);

    losses.push(epochLoss);

    if (epoch % 50 === 0 || epoch === epochs - 1) {
      self.postMessage({
        type: 'progress',
        epoch,
        totalEpochs: epochs,
        loss: epochLoss,
      });
    }
  }

  return {
    weights: {
      w1: Array.from(w1), b1: Array.from(b1),
      w2: Array.from(w2), b2: Array.from(b2),
      w3: Array.from(w3), b3: Array.from(b3),
    },
    architecture: { inputSize: 1, hiddenSize, outputSize, activation: 'relu' },
    normalization: { dMin, dMax, dRange, tMean, tStd },
    sfcwParams: { startFreq, stopFreq, numSteps },
    freqs: Array.from(freqs),
    numSamples: nSamples,
    finalLoss: losses[losses.length - 1],
    losses,
  };
}

function initWeights(rows, cols) {
  const n = rows * cols;
  const scale = Math.sqrt(2.0 / (rows + cols));
  const w = new Float64Array(n);
  // Deterministic pseudo-random init (seeded LCG)
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    const u1 = (seed >>> 0) / 4294967296;
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    const u2 = (seed >>> 0) / 4294967296;
    // Box-Muller
    const z = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
    w[i] = z * scale;
  }
  return w;
}

function adamUpdate(params, grads, m, v, t, lr) {
  const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;
  const bc1 = 1 - Math.pow(beta1, t);
  const bc2 = 1 - Math.pow(beta2, t);
  for (let i = 0; i < params.length; i++) {
    m[i] = beta1 * m[i] + (1 - beta1) * grads[i];
    v[i] = beta2 * v[i] + (1 - beta2) * grads[i] * grads[i];
    const mHat = m[i] / bc1;
    const vHat = v[i] / bc2;
    params[i] -= lr * mHat / (Math.sqrt(vHat) + eps);
  }
}
