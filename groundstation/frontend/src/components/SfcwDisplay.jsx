import { useRef, useEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
// Windows and CFAR are shared with the Imaging Bench so both panels run one
// implementation — see lib/imagingEffects.js.
import {
  computeCFAR, kaiserWindow, hanningWindow, rectangularWindow,
  CFAR_GUARD, CFAR_TRAIN, CFAR_ALPHA,
} from '@/lib/imagingEffects';

const BG = '#000000';
const GRID_COLOR = '#1a1a1a';
const TRACE_COLOR = '#D1855C';
const CFAR_COLOR = 'rgba(78, 205, 196, 0.6)';
const CFAR_FILL = 'rgba(78, 205, 196, 0.06)';
const NOISE_FILL = 'rgba(255, 255, 255, 0.02)';
const LINEAR_TRACE = '#6B9BD2';

function jet(t) {
  t = Math.max(0, Math.min(1, t));
  return [
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)))),
  ];
}

const SPEED_OF_LIGHT = 299_792_458;

// Radix-2 FFT (in-place, decimation-in-time)
function fft(re, im) {
  const n = re.length;
  // Bit-reverse permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + halfLen] * curRe - im[i + j + halfLen] * curIm;
        const vIm = re[i + j + halfLen] * curIm + im[i + j + halfLen] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + halfLen] = uRe - vRe;
        im[i + j + halfLen] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function ifft(re, im) {
  const n = re.length;
  // Conjugate
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  // Conjugate and scale
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function computeRangeProfile(hCalReal, hCalImag, windowFn, zeroPadFactor) {
  const numSteps = hCalReal.length;
  const nfft = nextPow2(numSteps * zeroPadFactor);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);

  const win = windowFn(numSteps);
  for (let i = 0; i < numSteps; i++) {
    re[i] = hCalReal[i] * win[i];
    im[i] = hCalImag[i] * win[i];
  }

  ifft(re, im);

  const half = nfft >> 1;
  const magnitudeDb = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    magnitudeDb[i] = 20 * Math.log10(mag + 1e-12);
  }
  return { magnitudeDb, nfft };
}

export default function SfcwDisplay({ sfcwResult, sfcwProgress, sfcwRunning, rangeScale, hideWaterfall, defaultScaleMode, onRangeScaleToggle, scaleRange, onScaleRangeChange, onDynamicScale }) {
  const rangeCanvasRef = useRef(null);
  const waterfallCanvasRef = useRef(null);
  const animRef = useRef(null);
  const latestResult = useRef(null);
  const [crosshairTrace, setCrosshairTrace] = useState(null);
  const [crosshairWaterfall, setCrosshairWaterfall] = useState(null);

  // Scale mode: 'db' or 'linear'
  const [scaleMode, setScaleMode] = useState(defaultScaleMode || 'db');

  // Windowing state
  const [windowType, setWindowType] = useState('rectangular');
  const [kaiserBeta, setKaiserBeta] = useState(3);
  const hCalRef = useRef(null);

  // Range compensation state
  const [rangeComp, setRangeComp] = useState(0); // exponent: 0=off, 2=R², 4=R⁴

  // Averaging state
  const avgBuffer = useRef([]);
  const [avgCount, setAvgCount] = useState(1);
  const [averaged, setAveraged] = useState(null);

  // Waterfall history buffer
  const waterfallHistory = useRef([]);
  const WATERFALL_MAX_ROWS = 100;

  // Parallel ring buffer of the raw complex sweeps behind those rows, untouched
  // by window / range-comp / averaging / dB conversion. The Imaging Bench needs
  // complex data (phase-as-hue, coherence, coherent integration, dispersion,
  // raw S21), and the scalar waterfall rows have thrown all of that away.
  // Pushed in the same effect as waterfallHistory so row i lines up with row i.
  // It deliberately survives a scaleMode flip, which does wipe waterfallHistory
  // — the raw sweeps are unit-agnostic, so there is nothing to invalidate. That
  // one case is the only way the two buffers can differ in length.
  const rawHistory = useRef([]);
  // Mirrored into state purely so the EXPORT button can enable/disable itself;
  // the buffer itself is never read through React.
  const [rawCount, setRawCount] = useState(0);

  // Zoom/pan state for trace chart
  const [traceView, setTraceView] = useState({ xMin: 0, xMax: 1, yMin: -60, yMax: 40, autoY: true });
  const traceDrag = useRef(null);

  // CFAR params
  const [cfarGuard, setCfarGuard] = useState(CFAR_GUARD);
  const [cfarTrain, setCfarTrain] = useState(CFAR_TRAIN);
  const [cfarAlpha, setCfarAlpha] = useState(CFAR_ALPHA);
  const [cfarEnabled, setCfarEnabled] = useState(true);

  // Recomputed profile state
  const [recomputed, setRecomputed] = useState(null);

  // Session-wide Y-axis tracking (only expands, never shrinks within a session)
  const sessionY = useRef({ min: Infinity, max: -Infinity });

  // Manual amplitude scaling pins both panes to the same limits. Undefined
  // scaleRange (the C-scan / BG-model live-sweep instances) means dynamic.
  const manualScale = !!(scaleRange && !scaleRange.dynamic);

  // The live dynamic limits are published upward so the panel can seed its
  // manual fields from whatever is on screen at the moment it is switched.
  const reportScale = useRef(null);
  useEffect(() => { reportScale.current = onDynamicScale || null; }, [onDynamicScale]);

  // Store raw h_cal when it arrives
  useEffect(() => {
    if (!sfcwResult) return;
    latestResult.current = sfcwResult;
    if (sfcwResult.h_cal_real && sfcwResult.h_cal_imag) {
      hCalRef.current = {
        real: sfcwResult.h_cal_real,
        imag: sfcwResult.h_cal_imag,
        step_size: sfcwResult.step_size,
        range_offset: sfcwResult.range_offset,
        num_steps: sfcwResult.num_steps,
        start_freq: sfcwResult.start_freq,
        stop_freq: sfcwResult.stop_freq,
        timestamp: sfcwResult.timestamp,
        phase_coherence: sfcwResult.phase_coherence,
      };
    }
  }, [sfcwResult]);

  // Clear averaging buffer when window params change so new window takes effect instantly
  useEffect(() => {
    avgBuffer.current = [];
    setAveraged(null);
  }, [windowType, kaiserBeta, rangeComp]);

  // Recompute range profile client-side when window params change
  useEffect(() => {
    const hCal = hCalRef.current;
    if (!hCal) return;

    const winFn = windowType === 'kaiser'
      ? (n) => kaiserWindow(n, kaiserBeta)
      : windowType === 'hanning'
        ? hanningWindow
        : rectangularWindow;

    const { magnitudeDb, nfft } = computeRangeProfile(
      hCal.real, hCal.imag, winFn, 4
    );

    const maxRange = SPEED_OF_LIGHT / (2 * hCal.step_size);
    const half = nfft >> 1;
    const allDistances = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      allDistances[i] = (i / nfft) * maxRange - hCal.range_offset;
    }

    let startIdx = 0;
    while (startIdx < half && allDistances[startIdx] < 0) startIdx++;
    const distances = allDistances.slice(startIdx);
    const clippedMag = magnitudeDb.slice(startIdx);

    // R^n range compensation (STC) — use true physical distance (add back offset)
    if (rangeComp > 0) {
      for (let i = 0; i < clippedMag.length; i++) {
        const r = distances[i] + hCal.range_offset;
        if (r > 0.01) {
          clippedMag[i] += rangeComp * 10 * Math.log10(r);
        }
      }
    }

    setRecomputed({ magnitudes: clippedMag, distances });
  }, [windowType, kaiserBeta, rangeComp, sfcwResult]);

  // Averaging — uses recomputed data
  useEffect(() => {
    const mags = recomputed ? recomputed.magnitudes : (sfcwResult && sfcwResult.magnitudes);
    if (!mags) return;

    avgBuffer.current.push(Array.from(mags));
    if (avgBuffer.current.length > avgCount) {
      avgBuffer.current = avgBuffer.current.slice(-avgCount);
    }

    if (avgBuffer.current.length > 0) {
      const len = avgBuffer.current[0].length;
      const avg = new Float64Array(len);
      for (let i = 0; i < len; i++) {
        let sum = 0;
        for (let j = 0; j < avgBuffer.current.length; j++) {
          sum += avgBuffer.current[j][i];
        }
        avg[i] = sum / avgBuffer.current.length;
      }
      setAveraged(avg);
    }
  }, [recomputed, sfcwResult, avgCount]);

  const drawChart = useCallback((canvas, opts) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    const result = latestResult.current;
    if (!result || !result.magnitudes || result.magnitudes.length === 0) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No sweep data', w / 2, h / 2);
      return;
    }

    const {
      mags, dists, view, traceColor, title, crosshair,
      showCFAR, isDb, sessionY, manual, manualMin, manualMax, onScale
    } = opts;
    const n = mags.length;
    const pad = { top: 24, bottom: 36, left: 52, right: 16 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Determine Y range: pinned limits win, else session-wide extremes
    let yMin = view.yMin;
    let yMax = view.yMax;
    if (manual) {
      yMin = manualMin;
      yMax = manualMax;
    } else if (view.autoY && sessionY) {
      // Update session extremes with current frame data
      for (let i = 0; i < n; i++) {
        if (mags[i] < sessionY.current.min) sessionY.current.min = mags[i];
        if (mags[i] > sessionY.current.max) sessionY.current.max = mags[i];
      }
      // Use session extremes with margin
      const range = sessionY.current.max - sessionY.current.min;
      const margin = range * 0.05 || 1;
      yMin = sessionY.current.min - margin;
      yMax = sessionY.current.max + margin;
    } else if (view.autoY) {
      let dataMin = Infinity, dataMax = -Infinity;
      const startIdx = Math.max(0, Math.floor(view.xMin * (n - 1)));
      const endIdx = Math.min(n - 1, Math.ceil(view.xMax * (n - 1)));
      for (let i = startIdx; i <= endIdx; i++) {
        if (mags[i] < dataMin) dataMin = mags[i];
        if (mags[i] > dataMax) dataMax = mags[i];
      }
      const margin = (dataMax - dataMin) * 0.1 || 1;
      yMin = dataMin - margin;
      yMax = dataMax + margin;
    }

    // Publish the live limits so the panel can hand them to manual mode.
    if (!manual && onScale) onScale({ min: yMin, max: yMax, isDb });

    const xToPixel = (frac) => pad.left + ((frac - view.xMin) / (view.xMax - view.xMin)) * plotW;
    const yToPixel = (val) => pad.top + ((yMax - val) / (yMax - yMin)) * plotH;
    const pixelToX = (px) => view.xMin + ((px - pad.left) / plotW) * (view.xMax - view.xMin);

    // Grid
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      const val = yMax - (i / yTicks) * (yMax - yMin);
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(isDb ? `${val.toFixed(0)} dB` : val.toExponential(1), pad.left - 6, y + 3);
    }

    const maxDist = dists[dists.length - 1];
    const minDist = dists[0];
    const distRange = maxDist - minDist;
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const frac = view.xMin + (i / xTicks) * (view.xMax - view.xMin);
      const x = pad.left + (i / xTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      const dist = minDist + frac * distRange;
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${dist.toFixed(2)} m`, x, h - pad.bottom + 14);
    }

    // CFAR threshold + noise shading
    let cfarThreshold = null;
    if (showCFAR && isDb) {
      cfarThreshold = computeCFAR(mags, cfarGuard, cfarTrain, cfarAlpha);

      // Shade below CFAR as noise floor
      ctx.beginPath();
      ctx.moveTo(pad.left, h - pad.bottom);
      for (let i = 0; i < n; i++) {
        const frac = i / (n - 1);
        if (frac < view.xMin || frac > view.xMax) continue;
        const x = xToPixel(frac);
        const y = yToPixel(cfarThreshold[i]);
        if (frac === view.xMin || i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(xToPixel(view.xMax), h - pad.bottom);
      ctx.lineTo(pad.left, h - pad.bottom);
      ctx.closePath();
      ctx.fillStyle = NOISE_FILL;
      ctx.fill();

      // CFAR threshold line
      ctx.beginPath();
      ctx.strokeStyle = CFAR_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      let started = false;
      for (let i = 0; i < n; i++) {
        const frac = i / (n - 1);
        if (frac < view.xMin || frac > view.xMax) continue;
        const x = xToPixel(frac);
        const y = yToPixel(cfarThreshold[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Trace
    ctx.beginPath();
    ctx.strokeStyle = traceColor;
    ctx.lineWidth = 1.5;
    let first = true;
    for (let i = 0; i < n; i++) {
      const frac = i / (n - 1);
      if (frac < view.xMin || frac > view.xMax) continue;
      const x = xToPixel(frac);
      const y = yToPixel(mags[i]);
      const clampedY = Math.max(pad.top, Math.min(h - pad.bottom, y));
      if (first) { ctx.moveTo(x, clampedY); first = false; }
      else ctx.lineTo(x, clampedY);
    }
    ctx.stroke();

    // CFAR detections
    if (cfarThreshold && isDb) {
      for (let i = 1; i < n - 1; i++) {
        if (mags[i] > cfarThreshold[i] && mags[i] > mags[i - 1] && mags[i] > mags[i + 1]) {
          const frac = i / (n - 1);
          if (frac < view.xMin || frac > view.xMax) continue;
          const x = xToPixel(frac);
          const y = yToPixel(mags[i]);
          if (y < pad.top || y > h - pad.bottom) continue;

          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fillStyle = CFAR_FILL;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = CFAR_COLOR;
          ctx.fill();

          const dist = minDist + frac * distRange;
          ctx.fillStyle = CFAR_COLOR;
          ctx.font = '8px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${dist.toFixed(2)}m`, x, y - 10);
        }
      }
    }

    // Crosshair
    if (crosshair) {
      const { x: mx } = crosshair;
      const relX = pixelToX(mx);
      if (relX >= view.xMin && relX <= view.xMax) {
        const idx = Math.round(relX * (n - 1));
        const clampedIdx = Math.max(0, Math.min(n - 1, idx));
        const cx = xToPixel(clampedIdx / (n - 1));
        const cy = yToPixel(mags[clampedIdx]);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffffff44';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, pad.top);
        ctx.lineTo(cx, h - pad.bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        const dist = minDist + (clampedIdx / (n - 1)) * distRange;
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        const label = isDb ? `${dist.toFixed(2)} m  ${mags[clampedIdx].toFixed(1)} dB` : `${dist.toFixed(2)} m  ${mags[clampedIdx].toExponential(2)}`;
        ctx.fillText(label, cx + 8, Math.max(pad.top + 12, cy - 4));
      }
    }

    // Title
    ctx.fillStyle = traceColor;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(title, pad.left, 14);
    if (manual) {
      const tw = ctx.measureText(title).width;
      ctx.fillStyle = '#f59e0b';
      ctx.font = '9px monospace';
      ctx.fillText('MANUAL', pad.left + tw + 8, 14);
    }
    if (result.range_resolution) {
      ctx.fillStyle = '#444444';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`Δr=${(result.range_resolution * 100).toFixed(1)}cm`, w - pad.right, 14);
    }

    // Phase coherence (dB chart only)
    if (isDb && result.phase_coherence) {
      const pc = result.phase_coherence;
      const color = pc.coherent ? '#4ade80' : '#ef4444';
      ctx.fillStyle = color;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(
        `φ σ=${pc.phase_std_deg.toFixed(1)}° ${pc.coherent ? '● COHERENT' : '● INCOHERENT'}`,
        w - pad.right, 26
      );
    }

    return { pad, plotW, plotH, yMin, yMax };
  }, [cfarGuard, cfarTrain, cfarAlpha, cfarEnabled]);

  const drawWaterfall = useCallback((canvas, dists, view, crosshair, isDb, manual, manualMin, manualMax) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    const history = waterfallHistory.current;
    if (history.length === 0) {
      ctx.fillStyle = '#333333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Waterfall — waiting for sweeps', w / 2, h / 2);
      return;
    }

    const pad = { top: 24, bottom: 36, left: 52, right: 20 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const n = history[0].length;
    const numRows = history.length;

    // Find visible bin range from view
    const startBin = Math.max(0, Math.floor(view.xMin * (n - 1)));
    const endBin = Math.min(n - 1, Math.ceil(view.xMax * (n - 1)));
    const visibleBins = endBin - startBin + 1;

    // Colour range: pinned limits win, else dynamic over all visible history
    let vMin = Infinity, vMax = -Infinity;
    if (manual) {
      vMin = manualMin;
      vMax = manualMax;
    } else {
      for (let row = 0; row < numRows; row++) {
        for (let bin = startBin; bin <= endBin; bin++) {
          const v = history[row][bin];
          if (v < vMin) vMin = v;
          if (v > vMax) vMax = v;
        }
      }
    }
    if (!isFinite(vMin)) vMin = 0;
    if (!isFinite(vMax)) vMax = 1;
    if (vMax - vMin < 1e-6) { vMin -= 0.5; vMax += 0.5; }

    // Draw colormap
    const cellW = plotW / visibleBins;
    const cellH = plotH / WATERFALL_MAX_ROWS;

    for (let row = 0; row < numRows; row++) {
      for (let bin = startBin; bin <= endBin; bin++) {
        const t = (history[row][bin] - vMin) / (vMax - vMin);
        const [r, g, b] = jet(t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const x = pad.left + (bin - startBin) * cellW;
        const y = pad.top + (numRows - 1 - row) * cellH;
        ctx.fillRect(x, y, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
      }
    }

    // X-axis labels (distance)
    const maxDist = dists[dists.length - 1];
    const minDist = dists[0];
    const distRange = maxDist - minDist;
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const frac = view.xMin + (i / xTicks) * (view.xMax - view.xMin);
      const x = pad.left + (i / xTicks) * plotW;
      ctx.fillStyle = '#555555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${(minDist + frac * distRange).toFixed(2)} m`, x, h - pad.bottom + 14);
    }

    // Y-axis label
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Sweep #', 0, 0);
    ctx.restore();

    // Title
    ctx.fillStyle = '#D1855C';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    const wfTitle = isDb ? 'WATERFALL (dB)' : 'WATERFALL (LINEAR)';
    ctx.fillText(wfTitle, pad.left, 14);
    if (manual) {
      const tw = ctx.measureText(wfTitle).width;
      ctx.fillStyle = '#f59e0b';
      ctx.font = '9px monospace';
      ctx.fillText('MANUAL', pad.left + tw + 8, 14);
    }

    ctx.fillStyle = '#444444';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${numRows} sweeps`, w - pad.right, 14);

    // Color bar
    const barW = 12;
    const barH = plotH;
    const barX = w - pad.right + 6;
    const barY = pad.top;
    for (let i = 0; i < barH; i++) {
      const t = 1 - i / barH;
      const [r, g, b] = jet(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(barX, barY + i, barW, 1);
    }
    ctx.fillStyle = manual ? '#f59e0b' : '#555555';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    if (isDb) {
      ctx.fillText(`${vMax.toFixed(0)} dB`, barX, barY - 4);
      ctx.fillText(`${vMin.toFixed(0)} dB`, barX, barY + barH + 10);
    } else {
      ctx.fillText(vMax.toExponential(1), barX, barY - 4);
      ctx.fillText(vMin.toExponential(1), barX, barY + barH + 10);
    }

    // Crosshair
    if (crosshair) {
      const relX = (crosshair.x - pad.left) / plotW;
      if (relX >= 0 && relX <= 1) {
        const frac = view.xMin + relX * (view.xMax - view.xMin);
        const dist = minDist + frac * distRange;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffffff44';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(crosshair.x, pad.top);
        ctx.lineTo(crosshair.x, h - pad.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${dist.toFixed(2)} m`, crosshair.x + 8, crosshair.y - 4);
      }
    }
  }, []);

  // Push new data into waterfall history
  useEffect(() => {
    const dbMags = averaged || (recomputed ? recomputed.magnitudes : (sfcwResult && sfcwResult.magnitudes));
    if (!dbMags) return;
    const row = scaleMode === 'db' ? Array.from(dbMags) : Array.from(dbMags).map(db => Math.pow(10, db / 20));
    waterfallHistory.current.push(row);
    if (waterfallHistory.current.length > WATERFALL_MAX_ROWS) {
      waterfallHistory.current.shift();
    }

    // Same push, same cap — the raw complex sweep behind this row.
    const hCal = hCalRef.current;
    if (hCal && hCal.real && hCal.imag) {
      rawHistory.current.push({
        real: Float32Array.from(hCal.real),
        imag: Float32Array.from(hCal.imag),
        num_steps: hCal.num_steps,
        step_size: hCal.step_size,
        range_offset: hCal.range_offset,
        start_freq: hCal.start_freq,
        stop_freq: hCal.stop_freq,
        timestamp: hCal.timestamp,
        phase_coherence: hCal.phase_coherence,
      });
      if (rawHistory.current.length > WATERFALL_MAX_ROWS) {
        rawHistory.current.shift();
      }
    }
    setRawCount(rawHistory.current.length);
  }, [averaged, recomputed, sfcwResult]);

  // Clear waterfall when scale mode changes. rawHistory is intentionally left
  // alone — see its declaration.
  useEffect(() => {
    waterfallHistory.current = [];
  }, [scaleMode]);

  // Drop the raw buffer on unmount so a panel switch does not leak sweeps into
  // the next session.
  useEffect(() => () => { rawHistory.current = []; }, []);

  useEffect(() => {
    const render = () => {
      const result = latestResult.current;
      if (result && (recomputed || result.magnitudes)) {
        const dists = recomputed ? Array.from(recomputed.distances) : result.distances;
        const dbMags = averaged || (recomputed ? recomputed.magnitudes : result.magnitudes);
        const isDb = scaleMode === 'db';
        const mags = isDb ? dbMags : Array.from(dbMags).map(db => Math.pow(10, db / 20));
        const traceColor = isDb ? TRACE_COLOR : LINEAR_TRACE;
        const title = isDb ? 'RANGE PROFILE (dB)' : 'RANGE PROFILE (LINEAR)';

        // Apply range scale to view
        let view = traceView;
        if (rangeScale && dists.length > 0) {
          const maxDist = dists[dists.length - 1];
          const minDist = dists[0];
          const distRange = maxDist - minDist;
          const xMin = Math.max(0, (rangeScale.min - minDist) / distRange);
          const xMax = Math.min(1, (rangeScale.max - minDist) / distRange);
          view = { ...traceView, xMin, xMax };
        }

        drawChart(rangeCanvasRef.current, {
          mags, dists, view, traceColor,
          title, crosshair: crosshairTrace,
          showCFAR: cfarEnabled && isDb, isDb, sessionY,
          manual: manualScale,
          manualMin: scaleRange ? scaleRange.min : 0,
          manualMax: scaleRange ? scaleRange.max : 1,
          onScale: reportScale.current,
        });
        drawWaterfall(
          waterfallCanvasRef.current, dists, view, crosshairWaterfall, isDb,
          manualScale,
          scaleRange ? scaleRange.min : 0,
          scaleRange ? scaleRange.max : 1,
        );
      }
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [drawChart, drawWaterfall, traceView, crosshairTrace, crosshairWaterfall, cfarEnabled, averaged, recomputed, scaleMode, rangeScale, manualScale, scaleRange]);

  // Zoom handler
  const handleWheel = (e) => {
    if (rangeScale) return; // disable manual zoom when range scale is active
    e.preventDefault();
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const pad = { left: 52, right: 16 };
    const plotW = rect.width - pad.left - pad.right;
    const mx = e.clientX - rect.left;
    const relX = (mx - pad.left) / plotW;
    const frac = traceView.xMin + relX * (traceView.xMax - traceView.xMin);

    const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
    const newXMin = frac - (frac - traceView.xMin) * zoomFactor;
    const newXMax = frac + (traceView.xMax - frac) * zoomFactor;

    setTraceView(v => ({
      ...v,
      xMin: Math.max(0, newXMin),
      xMax: Math.min(1, newXMax),
    }));
  };

  // Pan handler
  const handleMouseDown = (e) => {
    if (rangeScale) return;
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pad = { left: 52, right: 16 };
    const plotW = rect.width - pad.left - pad.right;
    const mx = e.clientX - rect.left;
    if (mx < pad.left || mx > rect.width - pad.right) return;
    traceDrag.current = { startX: e.clientX, startView: { ...traceView } };

    const onMove = (me) => {
      if (!traceDrag.current) return;
      const dx = me.clientX - traceDrag.current.startX;
      const xRange = traceDrag.current.startView.xMax - traceDrag.current.startView.xMin;
      const shift = -(dx / plotW) * xRange;
      const newMin = Math.max(0, traceDrag.current.startView.xMin + shift);
      const newMax = Math.min(1, traceDrag.current.startView.xMax + shift);
      if (newMax - newMin > 0.001) {
        setTraceView(v => ({ ...v, xMin: newMin, xMax: newMax }));
      }
    };
    const onUp = () => {
      traceDrag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Snapshot the raw ring buffer to disk for the Imaging Bench. Same
  // Blob/anchor pattern as the C-scan export in App.jsx.
  const handleExportWaterfall = useCallback(() => {
    const buf = rawHistory.current;
    if (buf.length === 0) return;
    const ref = buf[buf.length - 1];
    const r8 = (arr) => Array.from(arr, v => Math.round(v * 1e8) / 1e8);
    const stamp = new Date().toISOString();
    const snapshot = {
      version: 1,
      type: 'waterfall_snapshot',
      timestamp: stamp,
      common: {
        num_steps: ref.num_steps,
        step_size: ref.step_size,
        start_freq: ref.start_freq,
        stop_freq: ref.stop_freq,
        range_offset: ref.range_offset,
      },
      displayState: { scaleMode, windowType, kaiserBeta, rangeComp, avgCount },
      sweeps: buf.map(sw => ({
        t: sw.timestamp,
        real: r8(sw.real),
        imag: r8(sw.imag),
        phase_coherence: sw.phase_coherence || null,
      })),
    };
    const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `waterfall_${stamp.replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [scaleMode, windowType, kaiserBeta, rangeComp, avgCount]);

  return (
    <div className="flex flex-col w-full h-full">
      {/* Progress bar */}
      {sfcwRunning && sfcwProgress && (
        <div className="absolute top-0 left-0 right-0 z-10 h-0.5">
          <div
            className="h-full bg-gradient-to-r from-[#D1855C] to-[#E5A986] transition-all duration-200"
            style={{ width: `${(sfcwProgress.step / sfcwProgress.total) * 100}%` }}
          />
        </div>
      )}

      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-3 px-3 py-1.5 border-b border-white/5 bg-black/40 shrink-0">
        {/* Window selector + Kaiser beta */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-white/40 uppercase tracking-wider">Win</span>
          <select
            value={windowType}
            onChange={(e) => setWindowType(e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white/70 outline-none"
          >
            <option value="rectangular">Rectangular</option>
            <option value="kaiser">Kaiser</option>
            <option value="hanning">Hanning</option>
          </select>
        </div>

        {windowType === 'kaiser' && (
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-white/40">β</span>
            <input
              type="range"
              min={2}
              max={14}
              step={0.5}
              value={kaiserBeta}
              onChange={(e) => setKaiserBeta(Number(e.target.value))}
              className="w-20 h-1 accent-primary cursor-pointer"
            />
            <span className="text-[10px] text-white/60 font-mono w-6">{kaiserBeta.toFixed(1)}</span>
          </div>
        )}

        <div className="w-px h-3 bg-white/10" />

        {/* Range compensation */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-white/40 uppercase tracking-wider">R^n</span>
          <select
            value={rangeComp}
            onChange={(e) => setRangeComp(Number(e.target.value))}
            className="bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white/70 outline-none"
          >
            <option value={0}>Off</option>
            <option value={2}>R²</option>
            <option value={3}>R³</option>
            <option value={4}>R⁴</option>
          </select>
        </div>

        <div className="w-px h-3 bg-white/10" />

        {/* Averaging */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-white/40 uppercase tracking-wider">Avg</span>
          <select
            value={avgCount}
            onChange={(e) => { setAvgCount(Number(e.target.value)); avgBuffer.current = []; }}
            className="bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white/70 outline-none"
          >
            {[1, 2, 4, 8, 16, 32].map(v => (
              <option key={v} value={v}>{v === 1 ? 'Off' : `${v}x`}</option>
            ))}
          </select>
        </div>

        <div className="w-px h-3 bg-white/10" />

        {/* CFAR toggle */}
        <button
          onClick={() => setCfarEnabled(!cfarEnabled)}
          className={cn(
            'px-2 py-0.5 rounded text-[9px] uppercase tracking-wider font-medium transition-all',
            cfarEnabled ? 'bg-[#4ecdc4]/20 text-[#4ecdc4] border border-[#4ecdc4]/30' : 'bg-white/5 text-white/30 border border-white/10'
          )}
        >
          CFAR
        </button>

        {cfarEnabled && (
          <>
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-white/30">G</span>
              <input type="number" min={1} max={20} value={cfarGuard}
                onChange={e => setCfarGuard(Number(e.target.value))}
                className="w-7 bg-white/5 border border-white/10 rounded px-1 py-0.5 text-[10px] text-white/70 outline-none"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-white/30">T</span>
              <input type="number" min={1} max={64} value={cfarTrain}
                onChange={e => setCfarTrain(Number(e.target.value))}
                className="w-7 bg-white/5 border border-white/10 rounded px-1 py-0.5 text-[10px] text-white/70 outline-none"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-white/30">α</span>
              <input type="number" min={1} max={20} value={cfarAlpha}
                onChange={e => setCfarAlpha(Number(e.target.value))}
                className="w-7 bg-white/5 border border-white/10 rounded px-1 py-0.5 text-[10px] text-white/70 outline-none"
              />
              <span className="text-[9px] text-white/20">dB</span>
            </div>
          </>
        )}

        <div className="flex-1" />

        {/* Reset scale */}
        <button
          onClick={() => {
            sessionY.current = { min: Infinity, max: -Infinity };
            if (manualScale && onScaleRangeChange) onScaleRangeChange({ ...scaleRange, dynamic: true });
          }}
          className="px-2 py-0.5 rounded text-[9px] text-white/40 border border-white/10 hover:text-white/70 hover:border-white/20 transition-all"
        >
          Reset Scale
        </button>

        {/* Reset zoom */}
        <button
          onClick={() => setTraceView({ xMin: 0, xMax: 1, yMin: 0, yMax: 1, autoY: true })}
          className="px-2 py-0.5 rounded text-[9px] text-white/40 border border-white/10 hover:text-white/70 hover:border-white/20 transition-all"
        >
          Reset Zoom
        </button>
      </div>

      {/* Range Profile (trace) */}
      <div className="relative flex-1 min-h-0">
        <canvas
          ref={rangeCanvasRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setCrosshairTrace({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          }}
          onMouseLeave={() => setCrosshairTrace(null)}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
        />
        {/* Scale toggle button */}
        <button
          onClick={() => {
            setScaleMode(m => m === 'db' ? 'linear' : 'db');
            sessionY.current = { min: Infinity, max: -Infinity };
            // Pinned limits are in the units we are leaving — drop back to dynamic.
            if (manualScale && onScaleRangeChange) onScaleRangeChange({ ...scaleRange, dynamic: true });
          }}
          className={cn(
            'absolute bottom-10 left-14 px-2 py-1 rounded text-[9px] font-medium uppercase tracking-wider transition-all border z-10',
            scaleMode === 'db'
              ? 'bg-[#D1855C]/20 text-[#D1855C] border-[#D1855C]/30'
              : 'bg-[#6B9BD2]/20 text-[#6B9BD2] border-[#6B9BD2]/30'
          )}
        >
          {scaleMode === 'db' ? 'dB' : 'LIN'}
        </button>
        {/* Range scale toggle button (only in bscan mode) */}
        {onRangeScaleToggle && (
          <button
            onClick={onRangeScaleToggle}
            className="absolute bottom-10 left-28 px-2 py-1 rounded text-[9px] font-medium uppercase tracking-wider transition-all border z-10 bg-white/10 text-white/70 border-white/20 hover:text-white hover:border-white/40"
          >
            {rangeScale.max <= 0.5 ? '0.3m' : '3m'}
          </button>
        )}
      </div>

      {/* Waterfall */}
      {!hideWaterfall && (
        <div className="relative border-t border-white/5" style={{ flex: '0 0 45%' }}>
          <canvas
            ref={waterfallCanvasRef}
            className="absolute inset-0 w-full h-full cursor-crosshair"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setCrosshairWaterfall({ x: e.clientX - rect.left, y: e.clientY - rect.top });
            }}
            onMouseLeave={() => setCrosshairWaterfall(null)}
          />
          {/* Snapshot the raw complex ring buffer for the Imaging Bench */}
          <button
            onClick={handleExportWaterfall}
            title={rawCount > 0 ? `Export ${rawCount} raw sweeps` : 'No sweeps buffered'}
            className={cn(
              'absolute bottom-10 left-14 px-2 py-1 rounded text-[9px] font-medium uppercase tracking-wider transition-all border z-10',
              rawCount > 0
                ? 'bg-white/10 text-white/70 border-white/20 hover:text-white hover:border-white/40'
                : 'bg-white/5 text-white/20 border-white/10 opacity-40 pointer-events-none'
            )}
          >
            Export
          </button>
        </div>
      )}
    </div>
  );
}
