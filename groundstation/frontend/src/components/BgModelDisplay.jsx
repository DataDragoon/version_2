import { useRef, useEffect, useState } from 'react';

export default function BgModelDisplay({ captures, capturing, sfcwProgress }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    ctx.scale(dpr, dpr);
    const w = size.w;
    const h = size.h;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (!captures || captures.length === 0) return;

    const distances = captures.map(c => c.lidar_standoff_mm);
    const minD = Math.min(...distances);
    const maxD = Math.max(...distances);
    const rangeD = maxD - minD || 1;

    const pad = { top: 40, bottom: 50, left: 60, right: 30 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Draw grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const numGridX = 5;
    for (let i = 0; i <= numGridX; i++) {
      const x = pad.left + (i / numGridX) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
    }

    // Draw axis labels
    ctx.fillStyle = '#555';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i <= numGridX; i++) {
      const x = pad.left + (i / numGridX) * plotW;
      const val = minD + (i / numGridX) * rangeD;
      ctx.fillText(`${val.toFixed(1)}`, x, pad.top + plotH + 20);
    }
    ctx.fillText('Standoff Distance (mm)', pad.left + plotW / 2, pad.top + plotH + 40);

    // Y axis: sample index
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < captures.length; i++) {
      const y = pad.top + (i / Math.max(1, captures.length - 1)) * plotH;
      ctx.fillStyle = '#555';
      ctx.fillText(`#${i + 1}`, pad.left - 10, y);
    }

    // Draw each capture as a dot with magnitude preview
    captures.forEach((cap, i) => {
      const x = pad.left + ((cap.lidar_standoff_mm - minD) / rangeD) * plotW;
      const y = captures.length === 1
        ? pad.top + plotH / 2
        : pad.top + (i / (captures.length - 1)) * plotH;

      // Draw dot
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#a78bfa';
      ctx.fill();

      // Draw small magnitude sparkline next to dot
      if (cap.h_cal_real && cap.h_cal_imag) {
        const numSteps = cap.h_cal_real.length;
        const sparkW = Math.min(80, plotW * 0.3);
        const sparkH = 16;
        const sparkX = x + 10;
        const sparkY = y - sparkH / 2;

        const mags = [];
        let maxMag = 0;
        for (let j = 0; j < numSteps; j++) {
          const mag = Math.sqrt(cap.h_cal_real[j] ** 2 + cap.h_cal_imag[j] ** 2);
          mags.push(mag);
          if (mag > maxMag) maxMag = mag;
        }

        if (maxMag > 0 && sparkX + sparkW < w - pad.right) {
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(167, 139, 250, 0.5)';
          ctx.lineWidth = 1;
          for (let j = 0; j < numSteps; j++) {
            const sx = sparkX + (j / (numSteps - 1)) * sparkW;
            const sy = sparkY + sparkH - (mags[j] / maxMag) * sparkH;
            if (j === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
        }
      }
    });

    // Title
    ctx.fillStyle = '#888';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${captures.length} capture${captures.length !== 1 ? 's' : ''} — ${rangeD.toFixed(1)} mm range`, pad.left, 12);

  }, [captures, size]);

  return (
    <div ref={containerRef} className="absolute inset-0 flex flex-col">
      {capturing && sfcwProgress && (
        <div className="absolute top-2 right-4 z-10 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#a78bfa]/10 border border-[#a78bfa]/30">
          <div className="w-2 h-2 rounded-full bg-[#a78bfa] animate-pulse" />
          <span className="text-[10px] font-medium text-[#a78bfa]">
            Capturing... {sfcwProgress.step}/{sfcwProgress.total}
          </span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}
