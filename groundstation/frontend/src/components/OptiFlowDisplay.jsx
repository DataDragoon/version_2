import { useRef, useEffect } from 'react';

export default function OptiFlowDisplay({ piIp, optiflowData, isConnected }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    if (isConnected && piIp) {
      img.src = `http://${piIp}:8080/stream`;
    } else {
      img.src = '';
    }

    return () => { img.src = ''; };
  }, [isConnected, piIp]);

  useEffect(() => {
    if (!optiflowData || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const container = canvas.parentElement;

    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    canvas.width = containerW * devicePixelRatio;
    canvas.height = containerH * devicePixelRatio;
    canvas.style.width = containerW + 'px';
    canvas.style.height = containerH + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    ctx.clearRect(0, 0, containerW, containerH);

    if (!optiflowData.vectors || optiflowData.vectors.length === 0) return;

    // Match the letterboxed region that object-contain produces
    const natW = imgRef.current?.naturalWidth || 1920;
    const natH = imgRef.current?.naturalHeight || 1080;
    const scale = Math.min(containerW / natW, containerH / natH);
    const imgW = natW * scale;
    const imgH = natH * scale;
    const offsetX = (containerW - imgW) / 2;
    const offsetY = (containerH - imgH) / 2;

    const scaleX = imgW / natW;
    const scaleY = imgH / natH;
    const vectorScale = 5;

    ctx.strokeStyle = '#4aff8a';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = '#4aff8a';

    for (const v of optiflowData.vectors) {
      const x = offsetX + v.x * scaleX;
      const y = offsetY + v.y * scaleY;
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

    const cx = offsetX + imgW / 2;
    const cy = offsetY + imgH / 2;
    const mx = optiflowData.mean_flow[0] * vectorScale * 3 * scaleX;
    const my = optiflowData.mean_flow[1] * vectorScale * 3 * scaleY;

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
  }, [optiflowData]);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <img
        ref={imgRef}
        alt=""
        className="absolute inset-0 w-full h-full object-contain scale-y-[-1]"
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none scale-y-[-1]"
      />
    </div>
  );
}
