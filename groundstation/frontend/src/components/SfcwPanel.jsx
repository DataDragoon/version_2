import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Section, InfoTile, ToggleButton } from './Sidebar';

const BUFFER_SAMPLES = 1024;
const SAMPLE_RATE = 2_000_000;
const BUFFER_TIME_MS = (BUFFER_SAMPLES / SAMPLE_RATE) * 1000;

export default function SfcwPanel({ isConnected, sdrConnected, sfcwRunning, sfcwStatus, sendSdr, params, onParamsChange, coherenceResult, bgSubtractMode }) {
  const { startFreq, stopFreq, stepSize, settleTime, numBuffers, tx1Gain, rx1Gain, rangeOffset } = params;
  const [coherenceRunning, setCoherenceRunning] = useState(false);

  useEffect(() => {
    if (coherenceResult) setCoherenceRunning(false);
  }, [coherenceResult]);

  const update = (key, value) => {
    onParamsChange({ ...params, [key]: value });
  };

  const canActivate = isConnected && sdrConnected;

  const sendParams = (overrides = {}) => {
    sendSdr({
      cmd: 'sfcw_set_params',
      start_freq_mhz: overrides.startFreq ?? startFreq,
      stop_freq_mhz: overrides.stopFreq ?? stopFreq,
      step_size_mhz: overrides.stepSize ?? stepSize,
      settle_time_ms: overrides.settleTime ?? settleTime,
      num_buffers: overrides.numBuffers ?? numBuffers,
      tx1_gain: overrides.tx1Gain ?? tx1Gain,
      rx1_gain: overrides.rx1Gain ?? rx1Gain,
      range_offset: overrides.rangeOffset ?? rangeOffset,
    });
  };

  const numSteps = Math.floor((stopFreq - startFreq) / stepSize) + 1;
  const bandwidth = (stopFreq - startFreq) * 1e6;
  const rangeRes = bandwidth > 0 ? (299792458 / (2 * bandwidth)) : Infinity;
  const maxRange = stepSize > 0 ? (299792458 / (2 * stepSize * 1e6)) : Infinity;
  const captureTimeMs = numBuffers * BUFFER_TIME_MS;
  const sweepTime = numSteps * (settleTime + captureTimeMs) / 1000;

  return (
    <>
      {/* Sweep Range */}
      <Section label="Sweep Range">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="Start"
            value={startFreq}
            unit="MHz"
            onChange={(v) => { update('startFreq', v); sendParams({ startFreq: v }); }}
            min={47}
            max={6000}
          />
          <EditableField
            label="Stop"
            value={stopFreq}
            unit="MHz"
            onChange={(v) => { update('stopFreq', v); sendParams({ stopFreq: v }); }}
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
            onChange={(v) => { update('stepSize', v); sendParams({ stepSize: v }); }}
            min={0.1}
            max={500}
          />
          <EditableField
            label="Settle"
            value={settleTime}
            unit="ms"
            onChange={(v) => { update('settleTime', v); sendParams({ settleTime: v }); }}
            min={0.1}
            max={50}
          />
        </div>
        <div className="flex flex-col gap-1">
          <EditableField
            label="Buffers"
            value={numBuffers}
            unit="x1024 smp"
            onChange={(v) => { update('numBuffers', v); sendParams({ numBuffers: v }); }}
            min={1}
            max={64}
          />
          <span className="text-[9px] text-[#333333] leading-tight px-1">
            {captureTimeMs.toFixed(2)} ms capture per step ({(numBuffers * BUFFER_SAMPLES).toLocaleString()} samples)
          </span>
        </div>
        <EditableField
          label="Range Offset"
          value={rangeOffset}
          unit="m"
          onChange={(v) => { update('rangeOffset', v); sendParams({ rangeOffset: v }); }}
          min={0}
          max={10}
        />
      </Section>

      {/* Gains */}
      <Section label="Gains">
        <div className="grid grid-cols-2 gap-2">
          <EditableField
            label="TX1"
            value={tx1Gain}
            unit="dB"
            onChange={(v) => { update('tx1Gain', v); sendParams({ tx1Gain: v }); }}
            min={0}
            max={30}
          />
          <EditableField
            label="RX1"
            value={rx1Gain}
            unit="dB"
            onChange={(v) => { update('rx1Gain', v); sendParams({ rx1Gain: v }); }}
            min={0}
            max={60}
          />
        </div>
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
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={() => sendSdr({ cmd: 'sfcw_capture_bg' })}
            disabled={!sfcwRunning}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-medium transition-all',
              sfcwRunning
                ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
                : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
            )}
          >
            Capture BG
          </button>
          <button
            onClick={() => sendSdr({ cmd: 'sfcw_clear_bg' })}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white transition-all"
          >
            Clear BG
          </button>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">BG Sub</span>
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            <button
              onClick={() => sendSdr({ cmd: 'sfcw_bg_mode', mode: 'complex' })}
              className={cn(
                'px-2 py-1 text-[10px] font-medium transition-all',
                bgSubtractMode === 'complex'
                  ? 'bg-white/15 text-white'
                  : 'bg-white/2 text-white/40 hover:text-white/70'
              )}
            >
              Complex
            </button>
            <button
              onClick={() => sendSdr({ cmd: 'sfcw_bg_mode', mode: 'magnitude' })}
              className={cn(
                'px-2 py-1 text-[10px] font-medium transition-all',
                bgSubtractMode === 'magnitude'
                  ? 'bg-white/15 text-white'
                  : 'bg-white/2 text-white/40 hover:text-white/70'
              )}
            >
              Magnitude
            </button>
          </div>
        </div>
      </Section>

      {/* Coherence Diagnostics */}
      <Section label="Coherence Test">
        <button
          onClick={() => {
            setCoherenceRunning(true);
            sendSdr({ cmd: 'sfcw_coherence_test' });
          }}
          disabled={sfcwRunning || coherenceRunning || !canActivate}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all',
            !sfcwRunning && !coherenceRunning && canActivate
              ? 'bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
              : 'bg-white/2 border border-white/5 text-white/20 cursor-not-allowed'
          )}
        >
          {coherenceRunning ? 'Running (3 sweeps)...' : 'Run Coherence Test'}
        </button>
        {coherenceResult && (
          <div className="mt-2 space-y-1">
            <div className="grid grid-cols-2 gap-2">
              <InfoTile
                label="Repeatability"
                value={coherenceResult.avg_repeatability?.toFixed(3)}
              />
              <InfoTile
                label="Correlation"
                value={coherenceResult.avg_correlation?.toFixed(3)}
              />
            </div>
            <div className="text-[9px] text-[#555] px-1 space-y-0.5">
              <div>Repeatability: {coherenceResult.repeatability?.map(r => r.toFixed(3)).join(', ')}</div>
              <div>Correlation: {coherenceResult.correlation?.map(c => c.toFixed(3)).join(', ')}</div>
              <div className="text-[#777] mt-1">1.0 = perfect, {'>'} 0.9 = good</div>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

function EditableField({ label, value, unit, onChange, min, max }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const committedRef = useRef(false);

  const startEdit = () => {
    setDraft(String(value));
    setEditing(true);
    committedRef.current = false;
  };

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
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
      {editing && (
        <div className="absolute bottom-0 left-3 right-3 h-px bg-gradient-to-r from-[#D1855C] to-[#E5A986] rounded-full" />
      )}
    </div>
  );
}
