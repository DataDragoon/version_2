import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

const LIDAR_AVG_WINDOW = 20;

export default function BscanPanel({ isConnected, sdrConnected, sfcwRunning, scanData, scanCapturing, bgCaptured, bgApplied, onBgAppliedChange, onScanAction, params, onParamsChange, svdEnabled, svdK, svdStrength, onSvdEnabledChange, onSvdKChange, onSvdStrengthChange, scaleMode, onScaleModeChange, displayMode, onDisplayModeChange, lidarMm, bgStandoffMm, onBgStandoffMmChange }) {
  const { stepSize, numPositions, wallStandoff, wallThickness, wallPermittivity } = params;

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const lidarBuf = useRef([]);
  const [lidarAvg, setLidarAvg] = useState(null);

  useEffect(() => {
    if (lidarMm == null) return;
    const buf = lidarBuf.current;
    buf.push(lidarMm);
    if (buf.length > LIDAR_AVG_WINDOW) buf.shift();
    const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
    setLidarAvg(avg);
  }, [lidarMm]);

  const handleAction = (action) => {
    if (action === 'capture_bg' && lidarAvg != null) {
      onBgStandoffMmChange(lidarAvg);
    } else if (action === 'clear_bg') {
      onBgStandoffMmChange(null);
    }
    onScanAction(action);
  };

  const deltaMm = (bgStandoffMm != null && lidarAvg != null) ? lidarAvg - bgStandoffMm : null;
  const deltaOk = deltaMm != null && Math.abs(deltaMm) <= 5;

  const canActivate = isConnected && sdrConnected;
  const captured = scanData.length;
  const apertureLength = stepSize * (numPositions - 1);

  return (
    <>
      {/* Session control — starts/stops continuous sweep */}
      <Section label="Session">
        <button
          onClick={() => onScanAction(sfcwRunning ? 'stop_session' : 'start_session')}
          disabled={!canActivate}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            sfcwRunning
              ? 'bg-orange-500/8 border-orange-500/30 hover:border-orange-500/50'
              : canActivate
                ? 'bg-[#6B9BD2]/8 border-[#6B9BD2]/30 hover:border-[#6B9BD2]/50'
                : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            sfcwRunning ? 'bg-orange-500/15' : canActivate ? 'bg-[#6B9BD2]/15' : 'bg-white/5',
          )}>
            {sfcwRunning ? (
              <div className="w-3 h-3 rounded-sm bg-orange-400" />
            ) : (
              <div className="w-3 h-3 rounded-full border-2 border-current text-[#6B9BD2]" />
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              {sfcwRunning ? 'Stop Session' : 'Start Session'}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {sfcwRunning ? 'Sweeping continuously...' :
               !sdrConnected ? 'SDR not connected' : 'Start continuous sweep'}
            </span>
          </div>
        </button>
      </Section>

      {/* Capture controls — only available when session is running */}
      <Section label="Capture">
        <button
          onClick={() => onScanAction('add_scan')}
          disabled={!sfcwRunning || scanCapturing || captured >= numPositions}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            sfcwRunning && !scanCapturing && captured < numPositions
              ? 'bg-[#6B9BD2]/8 border-[#6B9BD2]/30 hover:border-[#6B9BD2]/50'
              : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            sfcwRunning && !scanCapturing && captured < numPositions ? 'bg-[#6B9BD2]/15' : 'bg-white/5',
          )}>
            {scanCapturing ? (
              <div className="w-3 h-3 rounded-full border-2 border-[#6B9BD2] border-t-transparent animate-spin" />
            ) : (
              <svg className="w-4 h-4 text-[#6B9BD2]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              {scanCapturing ? 'Capturing...' : `Add Scan ${captured + 1}`}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {scanCapturing ? 'Waiting for next sweep' :
               captured >= numPositions ? 'Scan complete' :
               !sfcwRunning ? 'Start session first' :
               `At ${(captured * stepSize).toFixed(1)} cm`}
            </span>
          </div>
        </button>

        {captured > 0 && (
          <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#6B9BD2] to-[#8BB8E8] transition-all duration-300"
              style={{ width: `${(captured / numPositions) * 100}%` }}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onScanAction('new')}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            New Scan
          </button>
          <button
            onClick={() => onScanAction('undo')}
            disabled={captured === 0}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              captured > 0
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Undo Last
          </button>
        </div>
      </Section>

      <Section label="Aperture">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Step"
            value={stepSize}
            unit="cm"
            onChange={(v) => update('stepSize', v)}
            min={0.5}
            max={50}
          />
          <EditableField
            label="Positions"
            value={numPositions}
            unit="ct"
            onChange={(v) => update('numPositions', Math.round(v))}
            min={2}
            max={200}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Aperture" value={`${apertureLength.toFixed(1)} cm`} />
          <InfoTile label="Captured" value={`${captured} / ${numPositions}`} />
        </div>
        {captured > 0 && scanData[captured - 1].lidar_standoff_mm != null && (
          <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
            Last lidar standoff: {scanData[captured - 1].lidar_standoff_mm.toFixed(1)} mm
          </div>
        )}
      </Section>

      <Section label="Standoff">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-3 py-2 rounded-xl border border-white/8 bg-[#0a0a0a]/60">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Distance</span>
            <span className="text-base font-bold font-mono text-white">
              {lidarAvg != null ? lidarAvg.toFixed(1) : '—'} <span className="text-xs font-semibold text-[#888888]">mm</span>
            </span>
          </div>
          {bgStandoffMm != null && (
            <div className={cn(
              'flex items-baseline justify-between px-3 py-2 rounded-xl border',
              deltaOk
                ? 'border-green-500/30 bg-green-500/5'
                : 'border-red-500/30 bg-red-500/5'
            )}>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Delta</span>
              <span className={cn(
                'text-base font-bold font-mono',
                deltaOk ? 'text-green-400' : 'text-red-400'
              )}>
                {deltaMm != null ? (deltaMm >= 0 ? '+' : '') + deltaMm.toFixed(1) : '—'} <span className="text-xs font-semibold text-[#888888]">mm</span>
              </span>
            </div>
          )}
        </div>
      </Section>

      <Section label="Display">
        <div className="flex gap-2">
          <button
            onClick={() => onScaleModeChange(scaleMode === 'linear' ? 'db' : 'linear')}
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]"
          >
            {scaleMode === 'linear' ? 'Linear' : 'dB'}
          </button>
          <button
            onClick={() => onDisplayModeChange(displayMode === 'color' ? 'profile' : 'color')}
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]"
          >
            {displayMode === 'color' ? 'Color' : 'Profile'}
          </button>
        </div>
      </Section>

      <Section label="Background">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleAction('capture_bg')}
            disabled={!sfcwRunning}
            className={cn(
              'px-3 py-2.5 rounded-lg text-xs font-medium transition-all',
              sfcwRunning
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Capture BG
          </button>
          <button
            onClick={() => handleAction('clear_bg')}
            className="px-3 py-2.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Clear BG
          </button>
        </div>
        {bgCaptured && (
          <button
            onClick={() => onBgAppliedChange(!bgApplied)}
            className={cn(
              'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              bgApplied
                ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            {bgApplied ? '● BG Applied' : 'BG Not Applied'}
          </button>
        )}
      </Section>

      <Section label="Data">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onScanAction('export')}
            disabled={scanData.length === 0}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              scanData.length > 0
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Export
          </button>
          <button
            onClick={() => onScanAction('import')}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Import
          </button>
        </div>
      </Section>

      <Section label="SVD Filter">
        <button
          onClick={() => onSvdEnabledChange(!svdEnabled)}
          disabled={scanData.length < 2}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            scanData.length < 2
              ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              : svdEnabled
                ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {svdEnabled ? '● SVD ON' : 'SVD OFF'}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="k (remove)"
            value={svdK}
            unit=""
            onChange={(v) => onSvdKChange(Math.round(v))}
            min={1}
            max={Math.max(1, scanData.length - 1)}
          />
          <EditableField
            label="Strength"
            value={svdStrength}
            unit=""
            onChange={(v) => onSvdStrengthChange(v)}
            min={0.01}
            max={1}
          />
        </div>
      </Section>

      <Section label="Wall">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Standoff"
            value={wallStandoff}
            unit="cm"
            onChange={(v) => update('wallStandoff', v)}
            min={0}
            max={100}
          />
          <EditableField
            label="Thickness"
            value={wallThickness}
            unit="cm"
            onChange={(v) => update('wallThickness', v)}
            min={1}
            max={100}
          />
        </div>
        <div className="grid grid-cols-1 gap-2">
          <EditableField
            label="Permittivity εr"
            value={wallPermittivity}
            unit=""
            onChange={(v) => update('wallPermittivity', v)}
            min={1}
            max={20}
          />
        </div>
        <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
          v_wall = c/√εr = {(299792458 / Math.sqrt(wallPermittivity) / 1e6).toFixed(1)} m/ms.
          {' '}Display: {wallStandoff} cm standoff + {wallThickness} cm wall = {wallStandoff + wallThickness} cm total depth.
        </div>
      </Section>
    </>
  );
}

function EditableField({ label, value, unit, onChange, min, max }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => {
    setDraft(String(value));
    setEditing(true);
  };

  const commit = () => {
    const num = parseFloat(draft);
    if (!isNaN(num) && num >= min && num <= max) {
      onChange(num);
    }
    setEditing(false);
  };

  return (
    <div
      onClick={!editing ? startEdit : undefined}
      className={cn(
        'relative flex flex-col gap-0.5 p-3 rounded-xl border',
        'transition-all duration-300',
        editing
          ? 'border-[#6B9BD2]/40 bg-[#6B9BD2]/5 cursor-text'
          : 'border-white/8 bg-[#0a0a0a]/60 cursor-pointer hover:border-white/20 hover:bg-white/[0.02]',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      {editing ? (
        <div className="flex items-baseline gap-1">
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            className="bg-transparent text-base font-bold font-mono text-white outline-none w-14"
          />
          <span className="text-xs font-semibold text-[#888888]">{unit}</span>
        </div>
      ) : (
        <div className="flex items-baseline gap-1">
          <span className="text-base font-bold font-mono text-white">{value}</span>
          <span className="text-xs font-semibold text-[#888888]">{unit}</span>
        </div>
      )}
      {editing && (
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-[#6B9BD2] to-[#8BB8E8] rounded-full" />
      )}
    </div>
  );
}
