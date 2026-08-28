import { useRef, useEffect } from 'react';

const BG = '#000000';
const ACCENT = '#4aff8a';       // commanded position -- what we believe
const CONFIRM = '#22d3ee';      // confirmed position -- what the board acked
const ORIGIN = '#D1855C';
const GRID = '#141414';
const AXIS = '#2a2a2a';

const PAD = { top: 26, bottom: 40, left: 56, right: 24 };
const MIN_SPAN_MM = 40;   // never zoom in tighter than this, or a stationary rover fills the pane

/** Chooses a round grid pitch giving roughly `target` divisions across `span`. */
function niceStep(span, target = 8) {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return mult * mag;
}

/**
 * View window in mm. Soft limits, when enabled, ARE the travel envelope, so the
 * view is pinned to them and the picture stops jumping around as the rover
 * moves. Without limits there is no known envelope, so it fits the trail and
 * grows only outward -- a view that shrank back down would make a returning
 * rover look like it was accelerating.
 */
function computeView(w, h, status, trail, held) {
  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = Math.max(1, h - PAD.top - PAD.bottom);

  let xLo, xHi, yLo, yHi;
  const cfg = status?.config;
  if (cfg?.limits_enabled) {
    xLo = cfg.x_min_mm; xHi = cfg.x_max_mm;
    yLo = cfg.y_min_mm; yHi = cfg.y_max_mm;
  } else {
    xLo = xHi = yLo = yHi = 0;
    const pts = trail.length ? trail : [{ x: 0, y: 0 }];
    for (const p of pts) {
      if (p.x < xLo) xLo = p.x; if (p.x > xHi) xHi = p.x;
      if (p.y < yLo) yLo = p.y; if (p.y > yHi) yHi = p.y;
    }
    if (held) {
      xLo = Math.min(xLo, held.xLo); xHi = Math.max(xHi, held.xHi);
      yLo = Math.min(yLo, held.yLo); yHi = Math.max(yHi, held.yHi);
    }
  }

  // Square the aspect so 1 mm across reads the same as 1 mm up -- the whole
  // point of a plan view is that a square raster looks square.
  let spanX = Math.max(xHi - xLo, MIN_SPAN_MM);
  let spanY = Math.max(yHi - yLo, MIN_SPAN_MM);
  const cxm = (xLo + xHi) / 2;
  const cym = (yLo + yHi) / 2;
  const margin = 1.18;
  spanX *= margin; spanY *= margin;
  const scale = Math.min(plotW / spanX, plotH / spanY);
  spanX = plotW / scale; spanY = plotH / scale;

  return {
    scale,
    xLo: cxm - spanX / 2, xHi: cxm + spanX / 2,
    yLo: cym - spanY / 2, yHi: cym + spanY / 2,
    plotW, plotH,
    sx: (mm) => PAD.left + (mm - (cxm - spanX / 2)) * scale,
    sy: (mm) => PAD.top + plotH - (mm - (cym - spanY / 2)) * scale,
    held: { xLo, xHi, yLo, yHi },
  };
}

function draw(canvas, status, trail, heldRef, pulse) {
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
  if (w < 120 || h < 120) return;

  const V = computeView(w, h, status, trail, heldRef.current);
  heldRef.current = V.held;

  // ── grid + ticks ──────────────────────────────────────────────────────
  const step = niceStep(V.xHi - V.xLo);
  ctx.font = '10px monospace';
  ctx.lineWidth = 1;

  ctx.strokeStyle = GRID;
  ctx.fillStyle = '#4a4a4a';
  ctx.textAlign = 'center';
  for (let mm = Math.ceil(V.xLo / step) * step; mm <= V.xHi; mm += step) {
    const px = Math.round(V.sx(mm)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, PAD.top + V.plotH);
    ctx.stroke();
    ctx.fillText(mm.toFixed(step < 1 ? 1 : 0), px, PAD.top + V.plotH + 14);
  }
  ctx.textAlign = 'right';
  for (let mm = Math.ceil(V.yLo / step) * step; mm <= V.yHi; mm += step) {
    const py = Math.round(V.sy(mm)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, py);
    ctx.lineTo(PAD.left + V.plotW, py);
    ctx.stroke();
    ctx.fillText(mm.toFixed(step < 1 ? 1 : 0), PAD.left - 8, py + 3);
  }

  ctx.fillStyle = '#3a3a3a';
  ctx.textAlign = 'center';
  ctx.fillText('X — LEFT / RIGHT (mm)', PAD.left + V.plotW / 2, h - 8);
  ctx.save();
  ctx.translate(13, PAD.top + V.plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Y — UP / DOWN (mm)', 0, 0);
  ctx.restore();

  // ── zero axes ─────────────────────────────────────────────────────────
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  if (V.xLo <= 0 && V.xHi >= 0) {
    const px = Math.round(V.sx(0)) + 0.5;
    ctx.beginPath(); ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + V.plotH); ctx.stroke();
  }
  if (V.yLo <= 0 && V.yHi >= 0) {
    const py = Math.round(V.sy(0)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.left, py); ctx.lineTo(PAD.left + V.plotW, py); ctx.stroke();
  }

  // ── soft-limit envelope ───────────────────────────────────────────────
  const cfg = status?.config;
  if (cfg?.limits_enabled) {
    const x0 = V.sx(cfg.x_min_mm), x1 = V.sx(cfg.x_max_mm);
    const y0 = V.sy(cfg.y_max_mm), y1 = V.sy(cfg.y_min_mm);
    ctx.strokeStyle = '#ffffff22';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
    ctx.fillStyle = '#3a3a3a';
    ctx.textAlign = 'left';
    ctx.fillText('SOFT LIMITS', x0 + 4, y0 - 5);
  }

  // ── origin ────────────────────────────────────────────────────────────
  const ox = V.sx(0), oy = V.sy(0);
  ctx.strokeStyle = ORIGIN;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ox - 6, oy); ctx.lineTo(ox + 6, oy);
  ctx.moveTo(ox, oy - 6); ctx.lineTo(ox, oy + 6);
  ctx.stroke();

  if (!status) return;

  // ── trail ─────────────────────────────────────────────────────────────
  if (trail.length > 1) {
    ctx.strokeStyle = `${ACCENT}44`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    trail.forEach((p, i) => {
      const px = V.sx(p.x), py = V.sy(p.y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  // ── confirmed position, drawn only when it lags the commanded one ─────
  // The gap between the two IS the unconfirmed travel, so showing it as a
  // separate ghost marker makes the drift budget a distance on screen rather
  // than a number to interpret.
  const cx = status.confirmed_x_mm, cy = status.confirmed_y_mm;
  const px = status.x_mm, py = status.y_mm;
  if (Math.abs(cx - px) > 1e-6 || Math.abs(cy - py) > 1e-6) {
    const gx = V.sx(cx), gy = V.sy(cy);
    ctx.strokeStyle = `${CONFIRM}99`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(gx, gy, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(V.sx(px), V.sy(py)); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── current position ──────────────────────────────────────────────────
  const mx = V.sx(px), my = V.sy(py);
  const glow = status.moving ? 0.35 + 0.45 * pulse : 0.25;
  ctx.fillStyle = `${ACCENT}${Math.round(glow * 255).toString(16).padStart(2, '0')}`;
  ctx.beginPath(); ctx.arc(mx, my, 13, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.beginPath(); ctx.arc(mx, my, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `${ACCENT}55`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, my); ctx.lineTo(PAD.left + V.plotW, my);
  ctx.moveTo(mx, PAD.top); ctx.lineTo(mx, PAD.top + V.plotH);
  ctx.stroke();

  // ── jog direction arrow ───────────────────────────────────────────────
  if (status.jog) {
    const dx = status.jog.axis === 'x' ? status.jog.dir : 0;
    const dy = status.jog.axis === 'y' ? status.jog.dir : 0;
    const len = 26 + 6 * pulse;
    const ax = mx + dx * len, ay = my - dy * len;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mx + dx * 9, my - dy * 9); ctx.lineTo(ax, ay); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax + dx * 6, ay - dy * 6);
    ctx.lineTo(ax - dx * 4 + dy * 5, ay + dy * 4 + dx * 5);
    ctx.lineTo(ax - dx * 4 - dy * 5, ay + dy * 4 - dx * 5);
    ctx.closePath();
    ctx.fillStyle = ACCENT;
    ctx.fill();
  }

  // ── readout ───────────────────────────────────────────────────────────
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = ACCENT;
  ctx.fillText(`X ${px.toFixed(3)}   Y ${py.toFixed(3)} mm`, PAD.left, PAD.top - 10);
  if (status.drift_budget_mm > 0) {
    ctx.fillStyle = '#facc15';
    ctx.textAlign = 'right';
    ctx.fillText(`UNCONFIRMED ${status.drift_budget_mm.toFixed(1)} mm`, PAD.left + V.plotW, PAD.top - 10);
  }
}

export default function RoverDisplay({ status, trail }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const heldRef = useRef(null);
  // Props go through refs so the rAF loop is started once and never restarted.
  // rover_status arrives several times a second and every one is a fresh object,
  // so a loop keyed on prop identity would be torn down and rebuilt that often,
  // resetting the pulse phase and making the marker stutter instead of breathe.
  const statusRef = useRef(status);
  const trailRef = useRef(trail);
  statusRef.current = status;
  trailRef.current = trail;

  useEffect(() => {
    let start = null;
    const render = (t) => {
      if (start === null) start = t;
      const pulse = 0.5 + 0.5 * Math.sin((t - start) / 200);
      draw(canvasRef.current, statusRef.current, trailRef.current, heldRef, pulse);
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, []);

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    </div>
  );
}
