import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

export default function SarPanel({ bscanData, sarParams, onSarParamsChange, sarResult, sarProgress, svdEnabled, svdK, svdStrength, onSvdEnabledChange, onSvdKChange, onSvdStrengthChange, wallStandoff, wallThickness, wallPermittivity, onWallParamsChange }) {
  const { pixelsX, pixelsZ, window: windowType } = sarParams;

  const update = (key, value) => {
    onSarParamsChange({ ...sarParams, [key]: value });
  };

  const numPositions = bscanData ? bscanData.length : 0;

  return (
    <>
      <Section label="Status">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Positions" value={numPositions < 2 ? `${numPositions} (need ≥2)` : numPositions} />
          {sarResult && <InfoTile label="Time" value={`${sarResult.computeTimeMs} ms`} />}
        </div>
        {sarResult && (
          <div className="grid grid-cols-2 gap-2">
            <InfoTile label="Grid" value={`${sarResult.pixelsX}×${sarResult.pixelsZ}`} />
            <InfoTile label="Mode" value={sarResult.coherent ? 'coherent' : 'incoherent'} />
          </div>
        )}
        {sarProgress !== null && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-medium">Reconstructing...</span>
              <span className="text-[10px] font-mono text-white/60">{Math.round(sarProgress * 100)}%</span>
            </div>
            <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-[width] duration-100"
                style={{ width: `${sarProgress * 100}%` }}
              />
            </div>
          </div>
        )}
        <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
          Uses B-scan panel settings: dist range, wall model, SVD filter.
        </div>
      </Section>

      <Section label="Window">
        <div className="flex gap-2">
          <button
            onClick={() => update('window', 'blackman-harris')}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              windowType === 'blackman-harris'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Blackman-Harris
          </button>
          <button
            onClick={() => update('window', 'hanning')}
            className={cn(
              'flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border',
              windowType === 'hanning'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            Hanning
          </button>
        </div>
      </Section>

      <Section label="Image Grid">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Lateral px"
            value={pixelsX}
            unit="px"
            onChange={(v) => update('pixelsX', Math.round(v))}
            min={20}
            max={500}
          />
          <EditableField
            label="Depth px"
            value={pixelsZ}
            unit="px"
            onChange={(v) => update('pixelsZ', Math.round(v))}
            min={20}
            max={500}
          />
        </div>
      </Section>


      <Section label="Wall">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Standoff"
            value={wallStandoff}
            unit="cm"
            onChange={(v) => onWallParamsChange('wallStandoff', v)}
            min={0}
            max={100}
          />
          <EditableField
            label="Thickness"
            value={wallThickness}
            unit="cm"
            onChange={(v) => onWallParamsChange('wallThickness', v)}
            min={1}
            max={100}
          />
        </div>
        <div className="grid grid-cols-1 gap-2">
          <EditableField
            label="Permittivity εr"
            value={wallPermittivity}
            unit=""
            onChange={(v) => onWallParamsChange('wallPermittivity', v)}
            min={1}
            max={20}
          />
        </div>
        <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
          v_wall = c/√εr = {(299792458 / Math.sqrt(wallPermittivity) / 1e6).toFixed(1)} m/ms.
          {' '}Depth: {wallStandoff + wallThickness} cm.
        </div>
      </Section>

      <Section label="SVD Filter">
        <button
          onClick={() => onSvdEnabledChange(!svdEnabled)}
          disabled={numPositions < 2}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            numPositions < 2
              ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              : svdEnabled
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
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
            max={Math.max(1, numPositions - 1)}
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
          ? 'border-emerald-500/40 bg-emerald-500/5 cursor-text'
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
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-emerald-500 to-emerald-300 rounded-full" />
      )}
    </div>
  );
}
