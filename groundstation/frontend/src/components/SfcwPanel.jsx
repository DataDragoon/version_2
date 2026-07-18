import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';

export default function SfcwPanel({ isConnected, sdrConnected, sfcwRunning, sfcwStatus, sendSdr }) {
  const [startFreq, setStartFreq] = useState(1000);
  const [stopFreq, setStopFreq] = useState(5000);
  const [stepSize, setStepSize] = useState(10);
  const [settleTime, setSettleTime] = useState(1);
  const [dwellTime, setDwellTime] = useState(4);

  const canActivate = isConnected && sdrConnected;

  const sendParams = (overrides = {}) => {
    sendSdr({
      cmd: 'sfcw_set_params',
      start_freq_mhz: overrides.startFreq ?? startFreq,
      stop_freq_mhz: overrides.stopFreq ?? stopFreq,
      step_size_mhz: overrides.stepSize ?? stepSize,
      settle_time_ms: overrides.settleTime ?? settleTime,
      dwell_time_ms: overrides.dwellTime ?? dwellTime,
    });
  };

  const numSteps = Math.floor((stopFreq - startFreq) / stepSize) + 1;
  const bandwidth = (stopFreq - startFreq) * 1e6;
  const rangeRes = bandwidth > 0 ? (299792458 / (2 * bandwidth)) : Infinity;
  const maxRange = stepSize > 0 ? (299792458 / (2 * stepSize * 1e6)) : Infinity;
  const sweepTime = numSteps * (settleTime + dwellTime) / 1000;

  return (
    <>
      {/* Sweep Range */}
      <Section label="Sweep Range">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Start"
            value={startFreq}
            unit="MHz"
            onChange={(v) => { setStartFreq(v); sendParams({ startFreq: v }); }}
            min={47}
            max={6000}
          />
          <EditableField
            label="Stop"
            value={stopFreq}
            unit="MHz"
            onChange={(v) => { setStopFreq(v); sendParams({ stopFreq: v }); }}
            min={47}
            max={6000}
          />
        </div>
      </Section>

      {/* Step Configuration */}
      <Section label="Step Config">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Step Size"
            value={stepSize}
            unit="MHz"
            onChange={(v) => { setStepSize(v); sendParams({ stepSize: v }); }}
            min={0.1}
            max={500}
          />
          <EditableField
            label="Settle"
            value={settleTime}
            unit="ms"
            onChange={(v) => { setSettleTime(v); sendParams({ settleTime: v }); }}
            min={0.1}
            max={50}
          />
        </div>
        <EditableField
          label="Dwell"
          value={dwellTime}
          unit="ms"
          onChange={(v) => { setDwellTime(v); sendParams({ dwellTime: v }); }}
          min={0.5}
          max={200}
          hint="min 0.5 ms (1024 samples at 2 MSPS)"
        />
      </Section>

      {/* Sweep Info */}
      <Section label="Sweep Info">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Steps" value={numSteps} />
          <InfoTile label="Sweep" value={sweepTime < 1 ? `${(sweepTime * 1000).toFixed(0)} ms` : `${sweepTime.toFixed(1)} s`} />
          <InfoTile label="Δr" value={rangeRes < 1 ? `${(rangeRes * 100).toFixed(1)} cm` : `${rangeRes.toFixed(2)} m`} />
          <InfoTile label="R max" value={maxRange < 1000 ? `${maxRange.toFixed(1)} m` : `${(maxRange / 1000).toFixed(1)} km`} />
        </div>
      </Section>

      {/* Sweep Control */}
      <Section label="Sweep">
        <ToggleButton
          active={sfcwRunning}
          canActivate={canActivate}
          onToggle={() => sendSdr({ cmd: sfcwRunning ? 'sfcw_stop' : 'sfcw_start' })}
          activeLabel="Stop Sweep"
          idleLabel="Start Sweep"
          activeSubLabel={`Sweeping ${startFreq}–${stopFreq} MHz`}
          idleSubLabel={!sdrConnected ? 'SDR not connected' : `${numSteps} steps ready`}
          color="orange"
        />
      </Section>

    </>
  );
}

function EditableField({ label, value, unit, onChange, min, max, hint }) {
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
          ? 'border-[#D1855C]/40 bg-[#D1855C]/5 cursor-text'
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
      {hint && !editing && (
        <span className="text-[9px] text-[#333333] leading-tight">{hint}</span>
      )}
      {editing && (
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-[#D1855C] to-[#E5A986] rounded-full" />
      )}
    </div>
  );
}
