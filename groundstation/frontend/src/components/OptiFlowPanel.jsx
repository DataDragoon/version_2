import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

export default function OptiFlowPanel({ isConnected, optiflowData, lidarMm, gyroComp, onGyroCompChange, sendOptiflow }) {
  const d = optiflowData;
  const fmt = (v, decimals = 1) => v !== null && v !== undefined ? v.toFixed(decimals) : '—';

  const hasList = lidarMm !== null && lidarMm !== undefined;

  const F_PX = 1148;
  const canComputeReal = hasList && d?.position;
  const mmPerPx = hasList ? lidarMm / F_PX : 0;
  const posXcm = canComputeReal ? ((d.position[0] * mmPerPx) / 10).toFixed(2) : '—';
  const posYcm = canComputeReal ? ((d.position[1] * mmPerPx) / 10).toFixed(2) : '—';

  return (
    <>
      <Section label="Flow">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Keypoints" value={d?.keypoints ?? '—'} />
          <InfoTile label="FPS" value={d?.fps ?? '—'} />
          <InfoTile label="dX (px)" value={fmt(d?.mean_flow?.[0], 2)} />
          <InfoTile label="dY (px)" value={fmt(d?.mean_flow?.[1], 2)} />
        </div>
      </Section>

      <Section label="Position">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="X (px)" value={fmt(d?.position?.[0])} />
          <InfoTile label="Y (px)" value={fmt(d?.position?.[1])} />
          <InfoTile label="X (cm)" value={posXcm} />
          <InfoTile label="Y (cm)" value={posYcm} />
        </div>
      </Section>

      <Section label="LiDAR">
        <div className="flex flex-col gap-2">
          <InfoTile label="cm" value={hasList ? (lidarMm / 10).toFixed(1) : '—'} />
          <InfoTile label="m" value={hasList ? (lidarMm / 1000).toFixed(3) : '—'} />
        </div>
      </Section>

      <Section label="Gyro Compensation">
        <button
          onClick={() => onGyroCompChange(!gyroComp)}
          disabled={!isConnected}
          className={cn(
            'w-full py-3 rounded-2xl text-xs font-semibold uppercase tracking-widest',
            'border transition-all duration-200 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            gyroComp
              ? 'bg-[#4aff8a]/12 text-[#4aff8a] border-[#4aff8a]/30'
              : 'bg-[#0a0a0a]/50 text-[#666666] border-white/5 hover:bg-white/8',
          )}
        >
          {gyroComp ? 'Compensation ON' : 'Compensation OFF'}
        </button>
      </Section>

      <Section label="Controls">
        <button
          onClick={() => sendOptiflow({ cmd: 'reset_origin' })}
          disabled={!isConnected}
          className={cn(
            'w-full py-3 rounded-2xl text-xs font-semibold uppercase tracking-widest',
            'border border-white/5 bg-[#0a0a0a]/50 text-[#888] transition-all duration-200 cursor-pointer',
            'hover:border-white/15 hover:bg-white/[0.03] hover:text-white',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          Reset Origin
        </button>
      </Section>
    </>
  );
}
