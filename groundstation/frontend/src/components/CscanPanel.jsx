import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';
import { cellForIndex, gridStats, buildCscanGrid } from '@/lib/cscanGrid';

const LIDAR_AVG_WINDOW = 20;

export default function CscanPanel({
  isConnected, sdrConnected, sfcwRunning, scanData, scanCapturing, bgApplied, onBgAppliedChange,
  onScanAction, params, onParamsChange, scaleMode, onScaleModeChange, displayMode, onDisplayModeChange,
  scaleRange, onScaleRangeChange, lidarMm, lidarOffsetMm, bgRef, bgModel, bgCapturing,
  onCaptureBg, onLoadBgModel, onClearBg,
}) {
  const { hStep, hCount, vStep, vCount, maxDepth, gateStart, gateEnd, metric } = params;

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
  const stats = gridStats(params);
  const gridFull = captured >= stats.total;

  // Where the next capture lands on the snake path.
  const next = gridFull ? null : cellForIndex(captured, hCount);
  const nextLabel = next
    ? `col ${next.ix + 1}/${hCount}, row ${next.iy + 1}/${vCount}  ·  (${(next.ix * hStep).toFixed(1)}, ${(next.iy * vStep).toFixed(1)}) cm`
    : 'Grid complete';
  const rowDir = next ? (next.iy % 2 === 0 ? 'left → right' : 'right → left') : null;

  // Handing over from dynamic to manual should not jump the colours, so the
  // sliders start wherever the dynamic limits currently sit.
  const seedManualRange = () => {
    const grid = buildCscanGrid(scanData, params);
    if (!isFinite(grid.min) || !isFinite(grid.max)) return { min: scaleRange.min, max: scaleRange.max };
    return { min: Math.round(grid.min), max: Math.max(Math.round(grid.max), Math.round(grid.min) + 1) };
  };

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

      {/* Scan grid — describes the rectangle to raster before any capture starts */}
      <Section label="Scan Grid">
        <div className="px-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">Horizontal</div>
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="H Positions"
            value={hCount}
            unit="ct"
            onChange={(v) => update('hCount', Math.round(v))}
            min={1}
            max={200}
          />
          <EditableField
            label="H Step"
            value={hStep}
            unit="cm"
            onChange={(v) => update('hStep', v)}
            min={0.5}
            max={50}
          />
        </div>
        <div className="px-1 pt-1 text-[9px] font-medium uppercase tracking-wider text-[#555555]">Vertical</div>
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="V Positions"
            value={vCount}
            unit="ct"
            onChange={(v) => update('vCount', Math.round(v))}
            min={1}
            max={200}
          />
          <EditableField
            label="V Step"
            value={vStep}
            unit="cm"
            onChange={(v) => update('vStep', v)}
            min={0.5}
            max={50}
          />
        </div>

        {/* Sweep rectangle stats */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <InfoTile label="Sweep W × H" value={`${stats.width.toFixed(1)} × ${stats.height.toFixed(1)} cm`} />
          <InfoTile label="Area" value={`${stats.area.toFixed(0)} cm²`} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Total Cells" value={`${stats.total}`} />
          <InfoTile label="Captured" value={`${captured} / ${stats.total}`} />
        </div>

        <div className="px-2 py-1.5 rounded-lg bg-[#0a0a0a]/60 border border-white/5 text-[9px] text-white/40 leading-relaxed">
          Raster starts bottom-left and snakes: row 1 left → right, row 2 right → left, and so on.
        </div>
      </Section>

      {/* Capture controls — only available when session is running */}
      <Section label="Capture">
        <button
          onClick={() => onScanAction('add_scan')}
          disabled={!sfcwRunning || scanCapturing || gridFull}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            sfcwRunning && !scanCapturing && !gridFull
              ? 'bg-[#22d3ee]/8 border-[#22d3ee]/30 hover:border-[#22d3ee]/50'
              : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            sfcwRunning && !scanCapturing && !gridFull ? 'bg-[#22d3ee]/15' : 'bg-white/5',
          )}>
            {scanCapturing ? (
              <div className="w-3 h-3 rounded-full border-2 border-[#22d3ee] border-t-transparent animate-spin" />
            ) : (
              <svg className="w-4 h-4 text-[#22d3ee]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              {scanCapturing ? 'Capturing...' : gridFull ? 'Grid Complete' : `Capture Cell ${captured + 1}`}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {scanCapturing ? 'Waiting for next sweep' :
               gridFull ? `All ${stats.total} cells captured` :
               !sfcwRunning ? 'Start session first' : nextLabel}
            </span>
          </div>
        </button>

        {!gridFull && rowDir && (
          <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-[#22d3ee]/5 border border-[#22d3ee]/20">
            <span className="text-[9px] font-medium uppercase tracking-wider text-[#555555]">Row {next.iy + 1} sweeps</span>
            <span className="text-[10px] font-mono text-[#22d3ee]">{rowDir}</span>
          </div>
        )}

        {captured > 0 && (
          <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#22d3ee] to-[#67e8f9] transition-all duration-300"
              style={{ width: `${Math.min(100, (captured / Math.max(1, stats.total)) * 100)}%` }}
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

        {captured > 0 && scanData[captured - 1].lidar_standoff_mm != null && (
          <div className="px-2 text-[9px] text-white/40 leading-relaxed">
            Last cell standoff: {scanData[captured - 1].lidar_standoff_mm.toFixed(1)} mm
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

      {/* Depth slice — the C-scan collapses the depth axis over this gate */}
      <Section label="Depth Slice">
        <SliderRow
          label="Gate start"
          value={gateStart}
          unit="cm"
          min={0}
          max={Math.max(gateEnd - 0.5, 0.5)}
          step={0.5}
          accent="cyan"
          onChange={(v) => update('gateStart', v)}
        />
        <SliderRow
          label="Gate end"
          value={gateEnd}
          unit="cm"
          min={Math.min(gateStart + 0.5, gateEnd)}
          max={Math.max(maxDepth, gateEnd)}
          step={0.5}
          accent="cyan"
          onChange={(v) => update('gateEnd', v)}
        />
        <div className="flex gap-2">
          {['peak', 'energy', 'mean'].map((m) => (
            <button
              key={m}
              onClick={() => update('metric', m)}
              className={cn(
                'flex-1 px-2 py-2 rounded-lg text-xs font-medium capitalize transition-all border',
                metric === m
                  ? 'bg-[#22d3ee]/10 border-[#22d3ee]/30 text-[#22d3ee]'
                  : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80'
              )}
            >
              {m}
            </button>
          ))}
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
          onChange={(v) => onParamsChange({
            ...params,
            maxDepth: v,
            gateEnd: Math.min(gateEnd, v),
            gateStart: Math.min(gateStart, Math.max(0, v - 0.5)),
          })}
          min={1}
          max={500}
        />
      </Section>

      {/* Colour scaling — dynamic tracks the data, manual pins both ends live */}
      <Section label="Scaling">
        <button
          onClick={() => onScaleRangeChange(scaleRange.dynamic
            ? { dynamic: false, ...seedManualRange() }
            : { ...scaleRange, dynamic: true })}
          className={cn(
            'w-full px-3 py-2.5 rounded-lg text-xs font-medium transition-all border',
            scaleRange.dynamic
              ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
              : 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b]'
          )}
        >
          {scaleRange.dynamic ? '● Dynamic Scaling' : 'Manual Scaling'}
        </button>
        <SliderRow
          label="Min"
          value={scaleRange.min}
          unit="dB"
          min={-140}
          max={0}
          step={1}
          accent="amber"
          disabled={scaleRange.dynamic}
          onChange={(v) => onScaleRangeChange({ ...scaleRange, min: Math.min(v, scaleRange.max - 1) })}
        />
        <SliderRow
          label="Max"
          value={scaleRange.max}
          unit="dB"
          min={-140}
          max={0}
          step={1}
          accent="amber"
          disabled={scaleRange.dynamic}
          onChange={(v) => onScaleRangeChange({ ...scaleRange, max: Math.max(v, scaleRange.min + 1) })}
        />
        <div className="px-2 text-[9px] text-white/40 leading-relaxed">
          {scaleRange.dynamic
            ? 'Colour limits track the captured cells. Turn off to pin them.'
            : 'Colour limits pinned — both the C-scan and B-scan panes update live.'}
        </div>
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
            ? 'Model background, inferred per cell from that cell’s own lidar standoff.'
            : bgRef
              ? 'Reference sweep, phase-aligned to each cell by lidar standoff.'
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

function SliderRow({ label, value, unit, min, max, step, onChange, disabled, accent = 'cyan' }) {
  const accentClass = accent === 'amber' ? 'accent-amber-500' : 'accent-cyan-500';
  return (
    <div className={cn('flex flex-col gap-1', disabled && 'opacity-35 pointer-events-none')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[#555555] font-medium">{label}</span>
        <span className="text-[10px] font-mono text-white/60">{value} {unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={cn('w-full h-1 rounded-full appearance-none bg-white/10 cursor-pointer', accentClass,
          disabled && 'cursor-not-allowed')}
      />
      <div className="flex justify-between text-[9px] font-mono text-white/30">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
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
