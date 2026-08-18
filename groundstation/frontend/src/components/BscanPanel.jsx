import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

const LIDAR_AVG_WINDOW = 20;

export default function BscanPanel({ isConnected, sdrConnected, sfcwRunning, scanData, scanCapturing, bgApplied, onBgAppliedChange, onScanAction, params, onParamsChange, scaleMode, onScaleModeChange, displayMode, onDisplayModeChange, lidarMm, lidarOffsetMm, bgRef, bgModel, bgCapturing, onCaptureBg, onLoadBgModel, onClearBg }) {
  const { stepSize, numPositions, maxDepth } = params;

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const lidarBuf = useRef([]);
  const [lidarAvg, setLidarAvg] = useState(null);
  const [modelList, setModelList] = useState(null);
  const [modelListOpen, setModelListOpen] = useState(false);

  useEffect(() => {
    if (lidarMm == null) return;
    const buf = lidarBuf.current;
    buf.push(lidarMm);
    if (buf.length > LIDAR_AVG_WINDOW) buf.shift();
    const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
    setLidarAvg(avg);
  }, [lidarMm]);

  const fetchModels = useCallback(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => { setModelList(Array.isArray(data) ? data : []); setModelListOpen(true); })
      .catch(() => setModelList([]));
  }, []);

  const loadModel = useCallback((filename) => {
    fetch(`/api/models/${filename}`)
      .then(r => r.json())
      .then(model => { onLoadBgModel(model); setModelListOpen(false); })
      .catch(err => console.error('Failed to load model:', err));
  }, [onLoadBgModel]);

  // Both the model and the captured reference live in standoff, so compare the
  // live lidar on the same basis the sweeps are tagged with.
  const standoffNow = lidarAvg != null ? lidarAvg - (lidarOffsetMm || 0) : null;

  // Reference: how far the current standoff has drifted from where it was taken.
  const deltaMm = (bgRef && bgRef.lidar_standoff_mm != null && standoffNow != null)
    ? standoffNow - bgRef.lidar_standoff_mm : null;
  const deltaOk = deltaMm != null && Math.abs(deltaMm) <= 5;

  // Model: Akima inference clamps outside the captured span, so flag it.
  const modelSpan = (bgModel && Array.isArray(bgModel.d) && bgModel.d.length > 1)
    ? { min: bgModel.d[0], max: bgModel.d[bgModel.d.length - 1] } : null;
  const outOfSpan = modelSpan != null && standoffNow != null
    && (standoffNow < modelSpan.min || standoffNow > modelSpan.max);

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
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Standoff</span>
            <span className="text-base font-bold font-mono text-white">
              {standoffNow != null ? standoffNow.toFixed(1) : '—'} <span className="text-xs font-semibold text-[#888888]">mm</span>
            </span>
          </div>
          {deltaMm != null && (
            <div className={cn(
              'flex items-baseline justify-between px-3 py-2 rounded-xl border',
              deltaOk
                ? 'border-green-500/30 bg-green-500/5'
                : 'border-red-500/30 bg-red-500/5'
            )}>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Delta vs BG</span>
              <span className={cn(
                'text-base font-bold font-mono',
                deltaOk ? 'text-green-400' : 'text-red-400'
              )}>
                {(deltaMm >= 0 ? '+' : '') + deltaMm.toFixed(1)} <span className="text-xs font-semibold text-[#888888]">mm</span>
              </span>
            </div>
          )}
          {modelSpan && (
            <div className={cn(
              'flex items-baseline justify-between px-3 py-2 rounded-xl border',
              outOfSpan ? 'border-red-500/30 bg-red-500/5' : 'border-white/8 bg-[#0a0a0a]/60'
            )}>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">Model span</span>
              <span className={cn('text-xs font-bold font-mono', outOfSpan ? 'text-red-400' : 'text-white')}>
                {modelSpan.min.toFixed(0)} – {modelSpan.max.toFixed(0)} mm
              </span>
            </div>
          )}
          {outOfSpan && (
            <div className="px-2 text-[9px] text-red-400/70 leading-relaxed">
              Standoff is outside the captured span — the model clamps to the nearest end.
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
        <EditableField
          label="Max Depth"
          value={maxDepth}
          unit="cm"
          onChange={(v) => update('maxDepth', v)}
          min={1}
          max={500}
        />
      </Section>

      {/* Background — same two mutually exclusive sources as the SFCW panel */}
      <Section label="Background">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onCaptureBg}
            disabled={!sfcwRunning || bgCapturing}
            className={cn(
              'px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
              bgRef
                ? 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b]'
                : sfcwRunning && !bgCapturing
                  ? 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                  : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            {bgCapturing ? 'Capturing...' : bgRef ? 'BG Ref Active' : 'Capture BG'}
          </button>
          <button
            onClick={onClearBg}
            disabled={!bgRef && !bgModel && !bgCapturing}
            className={cn(
              'px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
              bgRef || bgModel || bgCapturing
                ? 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Clear BG
          </button>
        </div>

        <button
          onClick={fetchModels}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            bgModel
              ? 'bg-[#a78bfa]/10 border-[#a78bfa]/30 text-[#a78bfa]'
              : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {bgModel ? `Model: ${bgModel.name || 'loaded'}` : 'Load Model'}
        </button>
        {modelListOpen && modelList && (
          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto rounded-lg border border-white/10 bg-[#0a0a0a] p-2">
            {modelList.length === 0 && (
              <span className="text-[10px] text-white/30 px-1">No models saved</span>
            )}
            {modelList.map((m) => (
              <button
                key={m.filename}
                onClick={() => loadModel(m.filename)}
                className="flex items-baseline justify-between gap-2 text-left px-2 py-1.5 rounded text-[11px] text-white/70 hover:bg-white/10 hover:text-white transition-all"
              >
                <span className="truncate">{m.name || m.filename}</span>
                {m.suppressionDb != null ? (
                  <span className={cn('font-mono shrink-0 text-[10px]',
                    m.suppressionDb > 15 ? 'text-green-400/70'
                    : m.suppressionDb > 8 ? 'text-yellow-400/70' : 'text-red-400/70')}>
                    {m.suppressionDb.toFixed(1)} dB
                  </span>
                ) : (
                  <span className="font-mono shrink-0 text-[10px] text-white/25">legacy</span>
                )}
              </button>
            ))}
            <button
              onClick={() => setModelListOpen(false)}
              className="text-[10px] text-white/30 hover:text-white/60 mt-1 px-1"
            >
              Cancel
            </button>
          </div>
        )}

        {(bgRef || bgModel) && (
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
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          {bgModel
            ? 'Model background, inferred per position from that position’s own lidar standoff.'
            : bgRef
              ? 'Reference sweep, phase-aligned to each position by lidar standoff.'
              : 'Capture a reference sweep or load a model to subtract the background.'}
        </div>
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
