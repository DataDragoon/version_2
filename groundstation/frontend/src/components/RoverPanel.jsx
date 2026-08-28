import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Crosshair, Square } from 'lucide-react';
import { Section, InfoTile, ErrorBadge } from './Sidebar';

// The Pi drops a jog after JOG_HOLD_TIMEOUT (600 ms) without a hold, so the
// heartbeat has to be comfortably faster than that. 150 ms survives three lost
// frames before the rover coasts to a stop on its own.
const HOLD_INTERVAL_MS = 150;

const DIRS = {
  up:    { axis: 'y', dir:  1, icon: ChevronUp,    key: 'ArrowUp' },
  down:  { axis: 'y', dir: -1, icon: ChevronDown,  key: 'ArrowDown' },
  left:  { axis: 'x', dir: -1, icon: ChevronLeft,  key: 'ArrowLeft' },
  right: { axis: 'x', dir:  1, icon: ChevronRight, key: 'ArrowRight' },
};

export default function RoverPanel({
  roverConnected, roverStatus, sendRover, onClearTrail,
}) {
  const cfg = roverStatus?.config;
  const linked = roverConnected && roverStatus?.arduino_connected;

  const [posDraftX, setPosDraftX] = useState('0');
  const [posDraftY, setPosDraftY] = useState('0');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Which direction is currently held. A ref because the keyboard and pointer
  // handlers both need to see it synchronously, and because a stale closure
  // here would leave the rover jogging with nothing holding it.
  const heldRef = useRef(null);
  const timerRef = useRef(null);
  const [held, setHeld] = useState(null);

  const endJog = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (heldRef.current) {
      heldRef.current = null;
      setHeld(null);
      sendRover({ cmd: 'rover_jog_stop' });
    }
  }, [sendRover]);

  const beginJog = useCallback((name) => {
    if (heldRef.current === name) return;
    if (heldRef.current) endJog();
    const d = DIRS[name];
    if (!d) return;
    heldRef.current = name;
    setHeld(name);
    sendRover({ cmd: 'rover_jog_start', axis: d.axis, dir: d.dir });
    timerRef.current = setInterval(() => sendRover({ cmd: 'rover_jog_hold' }), HOLD_INTERVAL_MS);
  }, [sendRover, endJog]);

  // A pointer released outside the button, a tab switch, or the window losing
  // focus all have to end the jog -- otherwise the button's own pointerup never
  // fires and the only thing stopping the rover is the Pi's dead-man.
  useEffect(() => {
    const stop = () => endJog();
    const onVis = () => { if (document.hidden) endJog(); };
    window.addEventListener('blur', stop);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', stop);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.removeEventListener('visibilitychange', onVis);
      endJog();
    };
  }, [endJog]);

  // Arrow keys mirror the D-pad. Ignored while a text field has focus, and
  // repeat events are dropped -- key auto-repeat would otherwise restart the
  // jog dozens of times a second.
  useEffect(() => {
    if (!linked) return;
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const down = (e) => {
      if (e.repeat || typing(e.target)) return;
      const name = Object.keys(DIRS).find(k => DIRS[k].key === e.key);
      if (!name) return;
      e.preventDefault();
      beginJog(name);
    };
    const up = (e) => {
      const name = Object.keys(DIRS).find(k => DIRS[k].key === e.key);
      if (name && heldRef.current === name) endJog();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [linked, beginJog, endJog]);

  const setConfig = (patch) => sendRover({ cmd: 'rover_set_config', config: patch });

  const declarePosition = () => {
    const x = parseFloat(posDraftX);
    const y = parseFloat(posDraftY);
    if (isNaN(x) || isNaN(y)) return;
    sendRover({ cmd: 'rover_set_position', x_mm: x, y_mm: y });
    onClearTrail?.();
  };

  const openLoop = roverStatus && roverStatus.ack_expected === false;

  return (
    <>
      {/* ── Link ───────────────────────────────────────────────────────── */}
      <Section label="Rover Link">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile label="Server" value={roverConnected ? 'OK' : '—'} />
          <InfoTile label="Arduino" value={roverStatus?.arduino_connected ? 'OK' : '—'} />
        </div>
        {roverConnected && !roverStatus?.arduino_connected && (
          <p className="text-[10px] leading-relaxed text-[#666]">
            Waiting for the Arduino to dial in on port 8765.
          </p>
        )}
        {roverStatus?.last_error && <ErrorBadge message={roverStatus.last_error} />}
      </Section>

      {/* ── Position ───────────────────────────────────────────────────── */}
      <Section label="Position">
        <div className="grid grid-cols-2 gap-2">
          <BigTile label="X" value={roverStatus ? roverStatus.x_mm.toFixed(2) : '—'} unit="mm" />
          <BigTile label="Y" value={roverStatus ? roverStatus.y_mm.toFixed(2) : '—'} unit="mm" />
        </div>

        {roverStatus?.position_stale && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/25 bg-amber-500/5">
            <span className="text-[10px] leading-relaxed text-amber-400">
              Position restored from disk after a server restart. Nothing has verified
              it against the rig — measure and re-declare it below before scanning.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">
            Declare current position
          </span>
          <div className="grid grid-cols-2 gap-2">
            <RawInput label="X" value={posDraftX} onChange={setPosDraftX} onEnter={declarePosition} />
            <RawInput label="Y" value={posDraftY} onChange={setPosDraftY} onEnter={declarePosition} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <SmallButton onClick={declarePosition} disabled={!roverConnected} icon={Crosshair}>
              Set
            </SmallButton>
            <SmallButton
              onClick={() => {
                setPosDraftX('0'); setPosDraftY('0');
                sendRover({ cmd: 'rover_set_position', x_mm: 0, y_mm: 0 });
                onClearTrail?.();
              }}
              disabled={!roverConnected}
            >
              Zero Here
            </SmallButton>
          </div>
          <p className="text-[10px] leading-relaxed text-[#555]">
            This is the rig's only ground truth — there is no encoder. Declaring a
            position also clears the drift budget below.
          </p>
        </div>
      </Section>

      {/* ── Jog ────────────────────────────────────────────────────────── */}
      <Section label="Jog">
        <div className="flex flex-col items-center gap-2 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
          <div className="grid grid-cols-3 gap-1.5">
            <div />
            <JogKey name="up" held={held} onBegin={beginJog} onEnd={endJog} disabled={!linked} />
            <div />
            <JogKey name="left" held={held} onBegin={beginJog} onEnd={endJog} disabled={!linked} />
            <button
              onClick={() => sendRover({ cmd: 'rover_stop' })}
              disabled={!roverConnected}
              title="Stop jogging"
              className={cn(
                'flex items-center justify-center w-[52px] h-[52px] rounded-xl border transition-all',
                'border-white/5 bg-[#0d0d0d] text-[#555] hover:text-red-400 hover:border-red-500/30',
                'disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer',
              )}
            >
              <Square size={13} strokeWidth={2.4} />
            </button>
            <JogKey name="right" held={held} onBegin={beginJog} onEnd={endJog} disabled={!linked} />
            <div />
            <JogKey name="down" held={held} onBegin={beginJog} onEnd={endJog} disabled={!linked} />
            <div />
          </div>
          <p className="text-[10px] text-[#555] text-center leading-relaxed">
            Click and hold, or hold an arrow key. Release stops after the current
            {' '}{cfg ? cfg.jog_step_mm : '—'} mm step finishes — the Arduino has no abort command.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <NumTile
            label="Step" unit="mm" value={cfg?.jog_step_mm}
            onCommit={v => setConfig({ jog_step_mm: v })} disabled={!roverConnected}
          />
          <NumTile
            label="Speed" unit="mm/s" value={cfg?.speed_mm_s}
            onCommit={v => setConfig({ speed_mm_s: v })} disabled={!roverConnected}
          />
        </div>
        <p className="text-[10px] leading-relaxed text-[#555]">
          Speed is not sent to the Arduino — it is our estimate of how long a move
          takes, and it paces how fast the next one may be issued.
        </p>
      </Section>

      {/* ── Tracking ───────────────────────────────────────────────────── */}
      <Section label="Tracking">
        <div className="grid grid-cols-2 gap-2">
          <InfoTile
            label="Unconfirmed"
            value={roverStatus ? `${roverStatus.drift_budget_mm.toFixed(1)} mm` : '—'}
          />
          <InfoTile
            label="Moves"
            value={roverStatus ? `${roverStatus.moves_acked}/${roverStatus.moves_sent}` : '—'}
          />
        </div>
        {openLoop && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/25 bg-amber-500/5">
            <span className="text-[10px] leading-relaxed text-amber-400">
              <b>Open loop.</b> This board does not answer, so position is what we
              commanded, not what was confirmed. Every mm of travel adds to the
              unconfirmed budget until you re-declare the position.
            </span>
          </div>
        )}
        {roverStatus?.unsolicited > 0 && (
          <p className="text-[10px] leading-relaxed text-[#666]">
            {roverStatus.unsolicited} frame(s) arrived when no move was outstanding, so
            the board chatters on its own — read the acknowledged count with that in mind.
          </p>
        )}
      </Section>

      {/* ── Limits ─────────────────────────────────────────────────────── */}
      <Section label="Soft Limits">
        <Check
          label="Clamp travel to the envelope"
          checked={!!cfg?.limits_enabled}
          onChange={v => setConfig({ limits_enabled: v })}
          disabled={!roverConnected}
        />
        {cfg?.limits_enabled && (
          <div className="grid grid-cols-2 gap-2">
            <NumTile label="X min" unit="mm" value={cfg.x_min_mm} onCommit={v => setConfig({ x_min_mm: v })} />
            <NumTile label="X max" unit="mm" value={cfg.x_max_mm} onCommit={v => setConfig({ x_max_mm: v })} />
            <NumTile label="Y min" unit="mm" value={cfg.y_min_mm} onCommit={v => setConfig({ y_min_mm: v })} />
            <NumTile label="Y max" unit="mm" value={cfg.y_max_mm} onCommit={v => setConfig({ y_max_mm: v })} />
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-[#555]">
          A move into a limit is trimmed to the remaining travel, not rejected — jogging
          coasts exactly to the edge and stops there.
        </p>
      </Section>

      {/* ── Advanced ───────────────────────────────────────────────────── */}
      <Section label="Axis & Timing">
        <button
          onClick={() => setShowAdvanced(v => !v)}
          className="text-left text-[11px] text-[#666] hover:text-[#999] transition-colors cursor-pointer"
        >
          {showAdvanced ? '− Hide' : '+ Show'} advanced
        </button>
        {showAdvanced && (
          <div className="flex flex-col gap-2">
            <Check
              label="Invert X (left/right)"
              checked={!!cfg?.invert_x}
              onChange={v => setConfig({ invert_x: v })}
              disabled={!roverConnected}
            />
            <Check
              label="Invert Y (up/down)"
              checked={!!cfg?.invert_y}
              onChange={v => setConfig({ invert_y: v })}
              disabled={!roverConnected}
            />
            <p className="text-[10px] leading-relaxed text-[#555]">
              The panel is +X right, +Y up. The board drives left on negative X —
              which agrees — and up on negative Z, which does not, so Y ships
              inverted. These match the rig as measured; change one only if the
              marker stops following the actual motion.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <NumTile label="Overhead" unit="s" value={cfg?.move_overhead_s} onCommit={v => setConfig({ move_overhead_s: v })} />
              <NumTile label="Ack grace" unit="s" value={cfg?.ack_grace_s} onCommit={v => setConfig({ ack_grace_s: v })} />
              <NumTile label="Max move" unit="mm" value={cfg?.max_move_mm} onCommit={v => setConfig({ max_move_mm: v })} />
            </div>
            <Check
              label="Hold the line for the full move estimate"
              checked={!!cfg?.enforce_move_time}
              onChange={v => setConfig({ enforce_move_time: v })}
              disabled={!roverConnected}
            />
            <p className="text-[10px] leading-relaxed text-[#555]">
              Leave this on. An early reply may mean "received", not "finished", and
              a move the Arduino drops because it was busy is drift we cannot see.
            </p>
          </div>
        )}
      </Section>
    </>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────── */

function JogKey({ name, held, onBegin, onEnd, disabled }) {
  const { icon: Icon } = DIRS[name];
  const active = held === name;
  return (
    <button
      disabled={disabled}
      // Pointer capture keeps the release event on this button even if the
      // cursor slides off it mid-hold, which is the common way to leave a
      // jog running by accident.
      onPointerDown={e => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onBegin(name);
      }}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
      onLostPointerCapture={onEnd}
      onContextMenu={e => e.preventDefault()}
      className={cn(
        'flex items-center justify-center w-[52px] h-[52px] rounded-xl border select-none touch-none',
        'transition-all duration-150 cursor-pointer',
        'disabled:opacity-25 disabled:cursor-not-allowed',
        active
          ? 'bg-[#4aff8a]/15 border-[#4aff8a]/50 text-[#4aff8a] scale-95'
          : 'bg-[#0d0d0d] border-white/8 text-[#888] hover:border-white/20 hover:text-white',
      )}
    >
      <Icon size={20} strokeWidth={2.2} />
    </button>
  );
}

function BigTile({ label, value, unit }) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-xl bg-[#0a0a0a]/50 border border-white/5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-bold font-mono text-[#4aff8a]">{value}</span>
        <span className="text-[10px] font-semibold text-[#888888]">{unit}</span>
      </div>
    </div>
  );
}

function RawInput({ label, value, onChange, onEnter }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-[#111] border border-white/8 focus-within:border-[#D1855C]/40 transition-colors">
      <span className="text-[9px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onEnter?.(); }}
        className="bg-transparent text-sm font-mono text-white outline-none w-full"
        spellCheck={false}
      />
    </div>
  );
}

function SmallButton({ children, onClick, disabled, icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold',
        'transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed',
        'border-white/8 bg-[#0d0d0d] text-[#aaa] hover:border-[#D1855C]/40 hover:text-white',
      )}
    >
      {Icon && <Icon size={12} strokeWidth={2.2} />}
      {children}
    </button>
  );
}

/** A tile that shows a number and turns into a text input when clicked. */
function NumTile({ label, unit, value, onCommit, disabled }) {
  const [draft, setDraft] = useState(null);
  const shown = value === undefined || value === null ? '—' : String(value);

  const commit = () => {
    const n = parseFloat(draft);
    if (!isNaN(n)) onCommit(n);
    setDraft(null);
  };

  return (
    <div
      onClick={() => { if (!disabled && draft === null) setDraft(shown === '—' ? '' : shown); }}
      className={cn(
        'flex flex-col gap-1 p-3 rounded-xl border transition-all',
        disabled ? 'border-white/5 bg-[#0a0a0a]/40 opacity-40 cursor-not-allowed'
          : draft !== null ? 'border-[#D1855C]/40 bg-[#D1855C]/5 cursor-text'
            : 'border-white/5 bg-[#0a0a0a]/50 cursor-pointer hover:border-white/15',
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-[#555555]">{label}</span>
      <div className="flex items-baseline gap-1">
        {draft !== null ? (
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }}
            className="bg-transparent text-sm font-bold font-mono text-white outline-none w-12"
          />
        ) : (
          <span className="text-sm font-bold font-mono text-white">{shown}</span>
        )}
        <span className="text-[10px] font-semibold text-[#888888]">{unit}</span>
      </div>
    </div>
  );
}

function Check({ label, checked, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'flex items-center gap-2.5 p-3 rounded-xl border transition-all text-left',
        'cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed',
        checked ? 'border-[#4aff8a]/30 bg-[#4aff8a]/5' : 'border-white/5 bg-[#0a0a0a]/50 hover:border-white/15',
      )}
    >
      <div className={cn(
        'w-3.5 h-3.5 rounded shrink-0 border transition-all',
        checked ? 'bg-[#4aff8a] border-[#4aff8a]' : 'border-white/20',
      )} />
      <span className={cn('text-xs', checked ? 'text-white' : 'text-[#888]')}>{label}</span>
    </button>
  );
}
