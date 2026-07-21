import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';

export default function BscanPanel({ isConnected, sdrConnected, sfcwRunning, sfcwResult, scanData, onScanAction, params, onParamsChange }) {
  const { stepSize, numPositions } = params;

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const captured = scanData.length;
  const apertureLength = stepSize * (numPositions - 1);
  const canCapture = isConnected && sdrConnected && sfcwRunning && sfcwResult && captured < numPositions;

  return (
    <>
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
      </Section>

      <Section label="Scan Info">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Aperture" value={`${apertureLength.toFixed(1)} cm`} />
          <InfoTile label="Captured" value={`${captured} / ${numPositions}`} />
        </div>
      </Section>

      <Section label="Capture">
        <button
          onClick={() => onScanAction('capture')}
          disabled={!canCapture}
          className={cn(
            'group relative flex items-center gap-3 w-full p-4 rounded-2xl border',
            'transition-all duration-500 cursor-pointer',
            'disabled:cursor-not-allowed disabled:opacity-40',
            canCapture
              ? 'bg-[#6B9BD2]/8 border-[#6B9BD2]/30 hover:border-[#6B9BD2]/50'
              : 'bg-[#0a0a0a]/50 border-white/5',
          )}
        >
          <div className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl shrink-0 transition-all duration-500',
            canCapture ? 'bg-[#6B9BD2]/15' : 'bg-white/5',
          )}>
            <div className="w-3 h-3 rounded-full border-2 border-current text-[#6B9BD2]" />
          </div>
          <div className="flex flex-col gap-0.5 text-left min-w-0">
            <span className="text-sm font-semibold text-white">
              Capture Position {captured + 1}
            </span>
            <span className="text-xs text-[#555555] leading-relaxed">
              {!sfcwRunning ? 'Start SFCW sweep first' :
               !sfcwResult ? 'Waiting for sweep data...' :
               captured >= numPositions ? 'Scan complete' :
               `At ${(captured * stepSize).toFixed(1)} cm`}
            </span>
          </div>
        </button>

        {/* Progress bar */}
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
