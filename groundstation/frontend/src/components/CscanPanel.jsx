import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';
import { orderedCellForIndex, gridStats, buildCscanGrid, gridRoverExtent } from '@/lib/cscanGrid';

const LIDAR_AVG_WINDOW = 20;

// What the automation is doing right now, in the operator's terms.
const PHASE_TEXT = {
  homing: 'Driving to the grid origin',
  moving: 'Moving to the next cell',
  settling: 'Settling',
  capturing: 'Sweeping',
};

export default function CscanPanel({
  isConnected, sdrConnected, sfcwRunning, scanData, scanCapturing, bgApplied, onBgAppliedChange,
  onScanAction, params, onParamsChange, scaleMode, onScaleModeChange, displayMode, onDisplayModeChange,
  scaleRange, onScaleRangeChange, lidarMm, lidarOffsetMm, bgRef, bgModel, bgCapturing,
  onCaptureBg, onLoadBgModel, onClearBg,
  roverConnected, roverStatus, sendRover, roverScan,
}) {
  const {
    hStep, hCount, vStep, vCount, maxDepth, gateStart, gateEnd, metric,
    scanMode, roverOriginRightMm, roverOriginBelowMm, roverSettleMs,
  } = params;

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

  // ── Rover mode ────────────────────────────────────────────────────────
  const roverMode = scanMode === 'rover';
  const roverLinked = roverConnected && !!roverStatus?.board_connected;
  const roverEstopped = !!roverStatus?.estop;
  const scanning = !!roverScan?.active;
  // In rover mode the session is the raster, so the button tracks the
  // automation rather than the bare sweep.
  const sessionActive = roverMode ? (scanning || sfcwRunning) : sfcwRunning;

  // The rover position the grid's top-left corner sits at, given where the
  // operator says the head is standing relative to it. Shown before the scan
  // starts so a wrong entry is visible against the soft limits, not discovered
  // by driving into the end of a rail that has no endstop.
  const originPreview = (roverMode && roverStatus)
    ? {
        x: roverStatus.x_mm - (Number(roverOriginRightMm) || 0),
        y: roverStatus.y_mm + (Number(roverOriginBelowMm) || 0),
      }
    : null;
  const extent = originPreview ? gridRoverExtent(params, originPreview) : null;
  const cfg = roverStatus?.config;
  const fitsLimits = !(extent && cfg && cfg.limits_enabled) || (
    extent.xMin >= cfg.x_min_mm && extent.xMax <= cfg.x_max_mm
    && extent.yMin >= cfg.y_min_mm && extent.yMax <= cfg.y_max_mm
  );

  // Where the next capture lands. The two modes walk the same grid in opposite
  // orders — bottom-left upwards by hand, top-left downwards under the rover.
  const nextIndex = scanning ? roverScan.index : captured;
  const next = nextIndex >= stats.total ? null : orderedCellForIndex(nextIndex, hCount, vCount, scanMode);
  const nextLabel = next
    ? `col ${next.ix + 1}/${hCount}, row ${next.iy + 1}/${vCount}  ·  (${(next.ix * hStep).toFixed(1)}, ${(next.iy * vStep).toFixed(1)}) cm`
    : 'Grid complete';
  const rowDir = next
    ? ((roverMode ? (vCount - 1 - next.iy) : next.iy) % 2 === 0 ? 'left → right' : 'right → left')
    : null;

  // Handing over from dynamic to manual should not jump the colours, so the
  // sliders start wherever the dynamic limits currently sit.
  const seedManualRange = () => {
    const grid = buildCscanGrid(scanData, params);
    if (!isFinite(grid.min) || !isFinite(grid.max)) return { min: scaleRange.min, max: scaleRange.max };
    return { min: Math.round(grid.min), max: Math.max(Math.round(grid.max), Math.round(grid.min) + 1) };
  };

  const startDisabled = !canActivate || (roverMode && (!roverLinked || roverEstopped || !fitsLimits));

  return (
    <>
      {/* Who drives the raster. Only the capture ORDER differs between the two —
          the sweep, the standoff provenance and the background subtraction are
          identical, so a grid captured either way is the same record. */}
      <Section label="Scan Mode">
        <div className="flex gap-2">
          {[
            { id: 'manual', label: 'Manual', hint: 'Place the head by hand' },
            { id: 'rover', label: 'Rover', hint: 'Gantry rasters the grid' },
          ].map((m) => {
            const disabled = (m.id === 'rover' && !roverLinked) || scanning;
            return (
              <button
                key={m.id}
                onClick={() => !disabled && update('scanMode', m.id)}
                disabled={disabled}
                className={cn(
                  'flex-1 flex flex-col gap-0.5 px-3 py-2.5 rounded-lg border text-left transition-all',
                  disabled ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
                    : scanMode === m.id
                      ? 'bg-[#4aff8a]/10 border-[#4aff8a]/30 text-[#4aff8a] cursor-pointer'
                      : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80 cursor-pointer',
                )}
              >
                <span className="text-xs font-semibold">{m.label}</span>
                <span className="text-[9px] leading-tight opacity-70">
                  {m.id === 'rover' && !roverLinked ? 'Controller not connected' : m.hint}
                </span>
              </button>
            );
          })}
        </div>
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
          {roverMode
            ? 'Origin is the top-left cell. The rover sweeps the top row left → right, drops one row, sweeps back, and snakes down.'
            : 'Raster starts bottom-left and snakes: row 1 left → right, row 2 right → left, and so on.'}
        </div>

        {/* Where the head is standing relative to the grid origin. The rover
            drives left and up by exactly this to reach the origin, in one move
            on both axes, before the raster starts. */}
        {roverMode && (
          <>
            <div className="px-1 pt-2 text-[9px] font-medium uppercase tracking-wider text-[#555555]">
              Current position from origin
            </div>
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="Right of origin"
                value={roverOriginRightMm}
                unit="mm"
                onChange={(v) => update('roverOriginRightMm', v)}
                min={-100000}
                max={100000}
              />
              <EditableField
                label="Below origin"
                value={roverOriginBelowMm}
                unit="mm"
                onChange={(v) => update('roverOriginBelowMm', v)}
                min={-100000}
                max={100000}
              />
            </div>
            <EditableField
              label="Settle before sweep"
              value={roverSettleMs}
              unit="ms"
              onChange={(v) => update('roverSettleMs', Math.round(v))}
              min={0}
              max={10000}
            />

            {originPreview && (
              <div className="grid grid-cols-2 gap-2">
                <InfoTile label="Origin at" value={`${originPreview.x.toFixed(0)}, ${originPreview.y.toFixed(0)} mm`} />
                <InfoTile
                  label="Rover span"
                  value={extent ? `${(extent.xMax - extent.xMin).toFixed(0)} × ${(extent.yMax - extent.yMin).toFixed(0)} mm` : '—'}
                />
              </div>
            )}
            {extent && (
              <div className={cn(
                'px-2 py-1.5 rounded-lg border text-[9px] leading-relaxed',
                fitsLimits
                  ? 'bg-[#0a0a0a]/60 border-white/5 text-white/40'
                  : 'bg-red-500/5 border-red-500/30 text-red-400',
              )}>
                Rover travels X {extent.xMin.toFixed(0)} → {extent.xMax.toFixed(0)} mm,
                {' '}Y {extent.yMax.toFixed(0)} → {extent.yMin.toFixed(0)} mm.
                {!fitsLimits && ' That is outside the soft limits — there are no endstops, so the scan is refused rather than clamped.'}
              </div>
            )}
            <div className="px-2 text-[9px] text-white/40 leading-relaxed">
              Measure where the head is now relative to the grid's top-left corner and
              enter it here. Nothing else knows where the grid is — this is what the
              rover drives back to before the first cell. Negative values are fine if
              the head is left of, or above, the origin.
            </div>
          </>
        )}
      </Section>

      {/* Session control — a continuous sweep by hand, the whole raster by rover */}
      <Section label="Session">
        <button
          onClick={() => onScanAction(sessionActive ? 'stop_session' : 'start_session')}
          disabled={sessionActive ? false : startDisabled}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            sessionActive
              ? roverMode
                ? 'bg-red-500/8 border-red-500/30 hover:border-red-500/50'
                : 'bg-orange-500/8 border-orange-500/30 hover:border-orange-500/50'
              : !startDisabled
                ? 'bg-[#6B9BD2]/8 border-[#6B9BD2]/30 hover:border-[#6B9BD2]/50'
                : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            sessionActive ? (roverMode ? 'bg-red-500/15' : 'bg-orange-500/15')
              : !startDisabled ? 'bg-[#6B9BD2]/15' : 'bg-white/5',
          )}>
            {sessionActive ? (
              <div className={cn('w-3 h-3 rounded-sm', roverMode ? 'bg-red-400' : 'bg-orange-400')} />
            ) : (
              <div className="w-3 h-3 rounded-full border-2 border-current text-[#6B9BD2]" />
            )}
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              {sessionActive
                ? (roverMode ? 'Stop Scan · E-Stop' : 'Stop Session')
                : (roverMode ? 'Start Rover Scan' : 'Start Session')}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {sessionActive
                ? (roverMode
                    ? (scanning
                        ? `${PHASE_TEXT[roverScan.phase] || 'Scanning'} — cell ${roverScan.index + 1}/${roverScan.total}`
                        : 'Sweeping — stop latches the E-stop')
                    : 'Sweeping continuously...')
                : !sdrConnected ? 'SDR not connected'
                : roverMode
                  ? !roverLinked ? 'Rover controller not connected'
                    : roverEstopped ? 'E-stop latched — clear it first'
                    : !fitsLimits ? 'Grid does not fit inside the soft limits'
                    : gridFull ? 'Grid full — start a new scan'
                    : `Raster ${stats.total - captured} cell${stats.total - captured === 1 ? '' : 's'} automatically`
                  : 'Start continuous sweep'}
            </span>
          </div>
        </button>

        {/* Progress along the raster, and whatever ended it. */}
        {roverMode && scanning && (
          <>
            <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#4aff8a] to-[#22d3ee] transition-all duration-300"
                style={{ width: `${Math.min(100, (roverScan.index / Math.max(1, roverScan.total)) * 100)}%` }}
              />
            </div>
            {roverScan.target && (
              <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-[#4aff8a]/5 border border-[#4aff8a]/20">
                <span className="text-[9px] font-medium uppercase tracking-wider text-[#555555]">Target</span>
                <span className="text-[10px] font-mono text-[#4aff8a]">
                  {roverScan.target.x_mm.toFixed(1)}, {roverScan.target.y_mm.toFixed(1)} mm
                </span>
              </div>
            )}
          </>
        )}
        {roverMode && !scanning && roverScan?.error && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/5">
            <span className="text-[10px] leading-relaxed text-red-400">{roverScan.error}</span>
          </div>
        )}
        {roverMode && !scanning && !roverScan?.error && roverScan?.message && (
          <div className="px-2 text-[10px] leading-relaxed text-[#4aff8a]/70">{roverScan.message}</div>
        )}
        {roverMode && roverEstopped && (
          <button
            onClick={() => sendRover?.({ cmd: 'rover_clear_estop' })}
            className="w-full px-3 py-2 rounded-lg text-xs font-semibold border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/15 transition-all"
          >
            Clear E-Stop
          </button>
        )}
        {roverMode && roverEstopped && (
          <div className="px-2 text-[9px] text-amber-400/60 leading-relaxed">
            Cutting the step train at speed is where a stepper loses steps, so the
            position is no longer trustworthy — re-declare it in the Rover panel
            before scanning again.
          </div>
        )}
      </Section>

      {/* Capture controls — by hand when the operator drives, automatic otherwise */}
      <Section label="Capture">
        {roverMode ? (
          <div className={cn(
            'flex items-center gap-3 w-full p-4 rounded-2xl border',
            scanning ? 'bg-[#4aff8a]/8 border-[#4aff8a]/30' : 'bg-[#0a0a0a]/50 border-white/5',
          )}>
            <div className={cn(
              'flex items-center justify-center w-10 h-10 rounded-xl shrink-0',
              scanning ? 'bg-[#4aff8a]/15' : 'bg-white/5',
            )}>
              {scanning ? (
                <div className="w-3 h-3 rounded-full border-2 border-[#4aff8a] border-t-transparent animate-spin" />
              ) : (
                <div className="w-3 h-3 rounded-full border-2 border-current text-[#555555]" />
              )}
            </div>
            <div className="flex flex-col gap-0.5 text-left min-w-0">
              <span className="text-sm font-semibold text-white">
                {scanning ? (PHASE_TEXT[roverScan.phase] || 'Scanning')
                  : gridFull ? 'Grid Complete' : 'Captured by the rover'}
              </span>
              <span className="text-xs text-[#555555] leading-relaxed">
                {scanning ? nextLabel
                  : gridFull ? `All ${stats.total} cells captured`
                  : `${captured} of ${stats.total} cells — start the scan to fill the rest`}
              </span>
            </div>
          </div>
        ) : (
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
        )}

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
            disabled={scanning}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              scanning
                ? 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
                : 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white',
            )}
          >
            New Scan
          </button>
          <button
            onClick={() => onScanAction('undo')}
            disabled={captured === 0 || scanning}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              captured > 0 && !scanning
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
