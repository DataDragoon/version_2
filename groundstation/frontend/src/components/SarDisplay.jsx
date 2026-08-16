import { useRef, useEffect, useCallback, useState } from 'react';

const BG = '#000000';

function jet(t) {
  t = Math.max(0, Math.min(1, t));
  return [
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)))),
    Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)))),
  ];
}

function drawSar(canvas, sarResult, crosshair, scaleMode, dynRange) {
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

  if (!sarResult || !sarResult.image) {
    ctx.fillStyle = '#333333';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No SAR image — need ≥2 B-scan positions', w / 2, h / 2);
    return;
  }

  const { image, pixelsX, pixelsZ, depthMax, apertureLength } = sarResult;

  const pad = { top: 24, bottom: 36, left: 50, right: 40 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const isLinear = scaleMode === 'linear';
  let valMin = Infinity;
  let valMax = -Infinity;

  const displayVals = new Float64Array(image.length);
  for (let i = 0; i < image.length; i++) {
    const v = isLinear ? Math.pow(10, image[i] / 20) : image[i];
    displayVals[i] = v;
    if (v < valMin) valMin = v;
    if (v > valMax) valMax = v;
  }
  if (!isFinite(valMin)) valMin = isLinear ? 0 : -90;
  if (!isFinite(valMax)) valMax = isLinear ? 1 : -20;
  if (valMax - valMin < (isLinear ? 0.001 : 1)) { valMin -= isLinear ? 0.0005 : 0.5; valMax += isLinear ? 0.0005 : 0.5; }
  if (dynRange && !isLinear && (valMax - valMin) > dynRange) {
    valMin = valMax - dynRange;
  }

  const cellW = plotW / pixelsZ;
  const cellH = plotH / pixelsX;

  for (let xi = 0; xi < pixelsX; xi++) {
    for (let zi = 0; zi < pixelsZ; zi++) {
      const val = displayVals[zi * pixelsX + xi];
      const t = (val - valMin) / (valMax - valMin);
      const [r, g, b] = jet(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(pad.left + zi * cellW, pad.top + xi * cellH, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
    }
  }

  // Grid
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.4;
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (i / xTicks) * plotW;
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
  }
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (i / yTicks) * plotH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  // X-axis labels (depth)
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (i / xTicks) * plotW;
    const depth = (i / xTicks) * depthMax;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${(depth * 100).toFixed(1)} cm`, x, h - pad.bottom + 14);
  }

  // Y-axis labels (position)
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (i / yTicks) * plotH;
    const pos = (i / yTicks) * apertureLength;
    ctx.fillStyle = '#555555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${(pos * 100).toFixed(1)} cm`, pad.left - 6, y + 3);
  }

  // Axis titles
  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Depth (cm)', pad.left + plotW / 2, h - pad.bottom + 28);

  ctx.save();
  ctx.translate(12, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Position (cm)', 0, 0);
  ctx.restore();

  // Title
  ctx.fillStyle = '#4ade80';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`SAR IMAGE (${isLinear ? 'linear' : 'dB'})`, pad.left, 14);

  ctx.fillStyle = '#444444';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${pixelsX}×${pixelsZ} | ${sarResult.numPositions} pos`, w - pad.right, 14);

  // Color bar
  const barW = 12;
  const barX = w - pad.right + 8;
  for (let i = 0; i < plotH; i++) {
    const t = 1 - i / plotH;
    const [r, g, b] = jet(t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(barX, pad.top + i, barW, 1);
  }
  ctx.fillStyle = '#555555';
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(isLinear ? valMax.toFixed(3) : `${valMax.toFixed(0)}`, barX, pad.top - 4);
  ctx.fillText(isLinear ? valMin.toFixed(3) : `${valMin.toFixed(0)}`, barX, pad.top + plotH + 10);

  // Crosshair
  if (crosshair) {
    const relX = (crosshair.x - pad.left) / plotW;
    const relY = (crosshair.y - pad.top) / plotH;
    if (relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1) {
      const zi = Math.min(pixelsZ - 1, Math.floor(relX * pixelsZ));
      const xi = Math.min(pixelsX - 1, Math.floor(relY * pixelsX));
      const depth = relX * depthMax;
      const pos = relY * apertureLength;

      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(crosshair.x, pad.top); ctx.lineTo(crosshair.x, h - pad.bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad.left, crosshair.y); ctx.lineTo(w - pad.right, crosshair.y); ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      const dbVal = image[zi * pixelsX + xi];
      const valLabel = isLinear ? Math.pow(10, dbVal / 20).toFixed(4) : `${dbVal.toFixed(1)}dB`;
      const label = `pos ${(pos * 100).toFixed(1)}cm, depth ${(depth * 100).toFixed(1)}cm, ${valLabel}`;
      const labelX = crosshair.x + 10 > w - 220 ? crosshair.x - 220 : crosshair.x + 10;
      ctx.fillText(label, labelX, crosshair.y - 8);
    }
  }
}

export default function SarDisplay({ sarResult, sarProgress, scaleMode, dynRange }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);

  const draw = useCallback(() => {
    drawSar(canvasRef.current, sarResult, crosshair, scaleMode || 'db', dynRange);
  }, [sarResult, crosshair, scaleMode, dynRange]);

  useEffect(() => {
    const render = () => {
      draw();
      animRef.current = requestAnimationFrame(render);
    };
    animRef.current = requestAnimationFrame(render);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [draw]);

  return (
    <div className="flex flex-col w-full h-full">
      {sarProgress !== null && (
        <div className="absolute top-0 left-0 right-0 z-10 h-0.5">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-200"
            style={{ width: `${sarProgress * 100}%` }}
          />
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setCrosshair({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          }}
          onMouseLeave={() => setCrosshair(null)}
        />
      </div>
    </div>
  );
}
