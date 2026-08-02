import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile } from './Sidebar';

export default function AlignedPanel({ scanData, alignEnabled, onAlignEnabledChange, normEnabled, onNormEnabledChange, bgCaptured, onBgCapture, onBgClear, svdEnabled, svdK, svdStrength, onSvdEnabledChange, onSvdKChange, onSvdStrengthChange, isConnected, sdrConnected }) {
  const numPositions = scanData ? scanData.length : 0;
  const canCapture = isConnected && sdrConnected;

  return (
    <>
      <Section label="Status">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Positions" value={numPositions < 2 ? `${numPositions} (need ≥2)` : numPositions} />
        </div>
        <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
          Uses B-scan data. Processing: IFFT → peak align → normalized BG subtract → SVD.
        </div>
      </Section>

      <Section label="Peak Align">
        <button
          onClick={() => onAlignEnabledChange(!alignEnabled)}
          disabled={numPositions < 2}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            numPositions < 2
              ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              : alignEnabled
                ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {alignEnabled ? '● ALIGN ON' : 'ALIGN OFF'}
        </button>
        <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
          Aligns all scans to the farthest first peak (wall reflection), compensating for standoff variation.
        </div>
      </Section>

      <Section label="Background">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onBgCapture}
            disabled={!canCapture}
            className={cn(
              'px-3 py-2.5 rounded-lg text-xs font-medium transition-all',
              canCapture
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Capture BG
          </button>
          <button
            onClick={onBgClear}
            className="px-3 py-2.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Clear BG
          </button>
        </div>
        {bgCaptured && (
          <div className="flex items-center gap-2 px-2">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[10px] text-emerald-400/80 uppercase tracking-wider font-medium">Background active</span>
          </div>
        )}
        <button
          onClick={() => onNormEnabledChange(!normEnabled)}
          disabled={!bgCaptured}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
            !bgCaptured
              ? 'bg-white/2 border-white/5 text-white/20 cursor-not-allowed'
              : normEnabled
                ? 'bg-[#6B9BD2]/10 border-[#6B9BD2]/30 text-[#6B9BD2]'
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          )}
        >
          {normEnabled ? '● NORM ON' : 'NORM OFF'}
        </button>
        <div className="px-2 py-1 text-[9px] text-white/40 leading-relaxed">
          BG is peak-aligned before subtraction.{normEnabled ? ' Amplitude normalized per-scan.' : ''}
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
