"""Rover (stepper gantry) control server -- ws://0.0.0.0:9002.

Topology
--------
The Arduino UNO is a WebSocket *client*: it dials into the Pi and waits to be
told where to go. The groundstation is a client too, on a different port. This
process is the server for both, and the single place rover position is tracked.

    groundstation --ws:9002--> rover_server --ws:8765--> Arduino UNO

Wire protocol to the Arduino is fixed -- the board is a black box we cannot
reflash right now, so this matches ~/stepper_testrig/stepper_testrig2.py exactly:
one text frame per move, ``"<x>,<z>"``, both RELATIVE millimetres, negative for
reverse. X is the horizontal axis, Z the vertical one. There is no stop command,
no position query, and no documented reply.

The board's sign convention, confirmed on the rig 2026-08-28:

    x < 0  ->  LEFT        x > 0  ->  RIGHT
    z < 0  ->  UP          z > 0  ->  DOWN

The groundstation uses +X right and +Y up (matching the C-scan grid, where the
vertical index grows upward), so X agrees with the board and Y is opposed. That
is the whole reason ``invert_y`` defaults to True -- see DEFAULT_CONFIG.

Everything below follows from those three absences.

How position is tracked, and why it cannot drift on our side
------------------------------------------------------------
There is no encoder and no position query, so the rover's position is *dead
reckoned* from what we commanded. Four separate drift mechanisms exist; three of
them are ours to eliminate and one is not:

1. **Accumulation drift** (ours). Summing floats forever loses low bits. All
   position state here is integer micrometres (``*_um``) and every move is
   quantised to a whole micrometre before it is sent, so the tracked position is
   exactly the sum of the integers we transmitted -- bit-exact, forever. mm are
   produced only at the display boundary.

2. **Command-loss drift** (ours). The Arduino has a small serial/socket buffer
   and no flow control we can see. Firing moves at it faster than it executes
   them is the classic way to have one silently dropped -- we would count it,
   the rig would not move, and every position afterwards is wrong with nothing
   to indicate it. So exactly ONE move is ever in flight (``_move_lock``), and
   the next is not sent until the previous one is resolved *and*
   ``estimated_move_time`` has elapsed (``enforce_move_time``). This is why
   click-and-hold is a train of small discrete moves rather than a velocity
   command: a velocity command is not in the Arduino's vocabulary, and
   integrating held-button wall-clock time into a distance would be a guess.
   Each jog tick advances position by exactly one quantum, or not at all.

3. **Rounding-at-the-edges drift** (ours). Soft limits clamp a move to the
   remaining travel rather than refusing it, and the clamped value -- not the
   requested one -- is what gets both sent and accumulated.

4. **Mechanical drift** (NOT ours): missed steps, belt slip, backlash, or the
   Arduino dropping a command anyway. Nothing in software can observe this. What
   we can do is *bound* it and say so, which is what the confirmed/commanded
   split below is for. It is cleared only by re-homing (``set_position``), which
   is the operator asserting ground truth.

Commanded vs confirmed
----------------------
``commanded_*_um`` advances the instant a move goes out. ``confirmed_*_um``
advances only when the Arduino says something back afterwards. We do not know
this board's reply format -- or whether it replies at all -- so any frame
arriving while a move is outstanding counts as an acknowledgement, and frames
arriving at any other time are counted as ``unsolicited`` and shown to the
operator. If unsolicited traffic is nonzero the ack signal is not trustworthy
and the panel says so.

A move that is never acknowledged still moves the commanded position (the belt
almost certainly did move) but adds its travel to ``unacked_travel_um`` -- a
drift *budget*: the total distance whose execution we never had confirmed. When
the ack format is eventually known, tightening this to hard confirmation is a
one-function change (``_looks_like_ack``) and nothing else moves.

Release latency
---------------
A move already handed to the Arduino cannot be recalled, so releasing a jog key
stops the train after the current quantum finishes. That is a physical property
of the interface, not an implementation shortcut -- it is why the jog quantum
defaults small.
"""

import argparse
import asyncio
import json
import os
import signal
import time
from collections import deque

import websockets

PORT = 9002
ARDUINO_PORT = 8765

UM = 1000.0  # micrometres per millimetre

# Dead-man: the groundstation repeats `rover_jog_hold` while a key is held. If
# holds stop arriving (tab closed, packet lost, mouseup swallowed) the jog stops
# on its own rather than running away.
JOG_HOLD_TIMEOUT = 0.6

LOG_LINES = 60

# If the board stays silent through this many moves in a row we stop waiting out
# `ack_grace_s` on every one of them -- see Rover._ack_expected.
ACK_GIVEUP = 3

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rover_state.json')

DEFAULT_CONFIG = {
    'jog_step_mm': 1.0,       # distance per jog tick
    'speed_mm_s': 10.0,       # ESTIMATE only -- used to time out a move, never sent
    'move_overhead_s': 0.15,  # fixed per-move cost (parse, accel/decel) in the estimate
    'ack_grace_s': 1.0,       # how long past the estimate we wait for a reply
    'enforce_move_time': True,
    # Sign conventions live here rather than in firmware we cannot reflash.
    # Both are measured facts about this rig, not preferences (2026-08-28):
    # the board drives LEFT on negative x, which already agrees with the
    # groundstation's +X-is-right, and UP on negative z, which opposes its
    # +Y-is-up -- hence Y is inverted and X is not.
    'invert_x': False,
    'invert_y': True,
    'limits_enabled': False,
    'x_min_mm': 0.0,
    'x_max_mm': 300.0,
    'y_min_mm': 0.0,
    'y_max_mm': 300.0,
    'max_move_mm': 500.0,     # refuses an obviously-fat-fingered single move
}


def _fmt_mm(um):
    """Format micrometres as the Arduino expects to read them.

    stepper_testrig2.py sent ``str(float(...))`` -- so "1.0", "-0.5". Anything
    that parses is presumably fine, but the board is a black box and this is the
    form it has actually been driven with, so reproduce it exactly.
    """
    return repr(round(um / UM, 3))


class Rover:
    def __init__(self, persist=True):
        self.persist = persist
        self.clients = set()
        self.arduino = None
        self.arduino_since = None

        # --- dead-reckoned position, integer micrometres (see module docstring)
        self.commanded_x_um = 0
        self.commanded_y_um = 0
        self.confirmed_x_um = 0
        self.confirmed_y_um = 0
        self.origin_x_um = 0
        self.origin_y_um = 0

        # --- drift accounting, reset by set_position (re-homing)
        self.unacked_travel_um = 0
        self.moves_sent = 0
        self.moves_acked = 0
        self.moves_timed_out = 0
        self.unsolicited = 0
        self.position_stale = False   # restored from disk, not verified against the rig

        self.config = dict(DEFAULT_CONFIG)

        self.log = deque(maxlen=LOG_LINES)

        self._move_lock = asyncio.Lock()
        self._ack_event = asyncio.Event()
        self._pending_move = False
        self._moving = False
        # Whether this board is believed to reply at all. Starts optimistic and
        # is switched off after ACK_GIVEUP silent moves, because otherwise a
        # board that never answers costs `ack_grace_s` of dead time on EVERY
        # jog quantum -- 1 mm/s jogging on a rig that can do ten times that.
        # Any frame from the board turns it back on, so a link that starts
        # silent and later speaks is picked up without a restart.
        self._ack_expected = True
        self._silent_streak = 0
        self._jog = None              # {'axis','dir','deadline'} while held
        self._jog_task = None
        self._loop = None
        self._last_error = None

        self._load_state()

    # ── persistence ─────────────────────────────────────────────────────────
    # Config and last-known position survive a server restart. A restart does
    # not move the rig, so throwing the position away would force a needless
    # re-home; but the process cannot know the rig was untouched either, so a
    # restored position comes back flagged stale until the operator confirms it.

    def _load_state(self):
        if not self.persist:
            return
        try:
            with open(STATE_FILE) as f:
                saved = json.load(f)
        except (OSError, ValueError):
            return
        cfg = saved.get('config') or {}
        for k, v in cfg.items():
            if k in self.config and isinstance(v, type(self.config[k])):
                self.config[k] = v
            elif k in self.config and isinstance(self.config[k], float):
                try:
                    self.config[k] = float(v)
                except (TypeError, ValueError):
                    pass
        pos = saved.get('position') or {}
        for attr in ('commanded_x_um', 'commanded_y_um', 'confirmed_x_um',
                     'confirmed_y_um', 'origin_x_um', 'origin_y_um',
                     'unacked_travel_um'):
            if isinstance(pos.get(attr), int):
                setattr(self, attr, pos[attr])
        self.position_stale = True
        self._note(f"state restored from disk (position flagged stale) -- "
                   f"x={self.x_um / UM:.3f} y={self.y_um / UM:.3f} mm")

    def _save_state(self):
        if not self.persist:
            return
        try:
            tmp = STATE_FILE + '.tmp'
            with open(tmp, 'w') as f:
                json.dump({
                    'config': self.config,
                    'position': {
                        'commanded_x_um': self.commanded_x_um,
                        'commanded_y_um': self.commanded_y_um,
                        'confirmed_x_um': self.confirmed_x_um,
                        'confirmed_y_um': self.confirmed_y_um,
                        'origin_x_um': self.origin_x_um,
                        'origin_y_um': self.origin_y_um,
                        'unacked_travel_um': self.unacked_travel_um,
                    },
                    'saved_at': time.time(),
                }, f)
            os.replace(tmp, STATE_FILE)
        except OSError as e:
            self._note(f"WARNING: could not save state ({e})")

    # ── derived position ────────────────────────────────────────────────────

    @property
    def x_um(self):
        return self.commanded_x_um - self.origin_x_um

    @property
    def y_um(self):
        return self.commanded_y_um - self.origin_y_um

    # ── logging ─────────────────────────────────────────────────────────────

    def _note(self, line):
        stamped = {'t': time.time(), 'line': line}
        self.log.append(stamped)
        print(f"[rover] {line}", flush=True)

    # ── status ──────────────────────────────────────────────────────────────

    def status(self):
        return {
            'arduino_connected': self.arduino is not None,
            'arduino_since': self.arduino_since,
            'moving': self._moving,
            'jog': None if self._jog is None else {'axis': self._jog['axis'], 'dir': self._jog['dir']},
            'x_mm': round(self.x_um / UM, 4),
            'y_mm': round(self.y_um / UM, 4),
            'machine_x_mm': round(self.commanded_x_um / UM, 4),
            'machine_y_mm': round(self.commanded_y_um / UM, 4),
            'confirmed_x_mm': round((self.confirmed_x_um - self.origin_x_um) / UM, 4),
            'confirmed_y_mm': round((self.confirmed_y_um - self.origin_y_um) / UM, 4),
            'drift_budget_mm': round(self.unacked_travel_um / UM, 4),
            'moves_sent': self.moves_sent,
            'moves_acked': self.moves_acked,
            'moves_timed_out': self.moves_timed_out,
            'unsolicited': self.unsolicited,
            'ack_expected': self._ack_expected,
            'position_stale': self.position_stale,
            'last_error': self._last_error,
            'config': dict(self.config),
        }

    async def broadcast(self):
        if not self.clients:
            return
        msg = json.dumps({'type': 'rover_status', **self.status()})
        dead = set()
        for c in self.clients:
            try:
                await c.send(msg)
            except websockets.ConnectionClosed:
                dead.add(c)
        self.clients -= dead

    async def broadcast_error(self, message):
        if not self.clients:
            return
        msg = json.dumps({'type': 'rover_error', 'message': message})
        dead = set()
        for c in self.clients:
            try:
                await c.send(msg)
            except websockets.ConnectionClosed:
                dead.add(c)
        self.clients -= dead

    async def broadcast_log(self, entry):
        if not self.clients:
            return
        msg = json.dumps({'type': 'rover_log', **entry})
        dead = set()
        for c in self.clients:
            try:
                await c.send(msg)
            except websockets.ConnectionClosed:
                dead.add(c)
        self.clients -= dead

    # ── Arduino link ────────────────────────────────────────────────────────

    def _looks_like_ack(self, text):
        """Whether a frame from the board counts as "that move is done".

        The reply format is undocumented, so today this is "it said anything at
        all while a move was outstanding". Narrow this once the firmware's
        vocabulary is known -- it is the only place that judgement lives.
        """
        return True

    async def arduino_handler(self, ws):
        if self.arduino is not None:
            self._note("second Arduino connected -- replacing the previous link")
            try:
                await self.arduino.close()
            except Exception:
                pass
        self.arduino = ws
        self.arduino_since = time.time()
        self._note("Arduino connected")
        await self.broadcast()
        try:
            async for message in ws:
                text = str(message).strip()
                entry = {'t': time.time(), 'line': f"arduino: {text}"}
                self.log.append(entry)
                print(f"[rover] {entry['line']}", flush=True)
                if not self._ack_expected:
                    self._ack_expected = True
                    self._note("Arduino started replying -- waiting for "
                               "acknowledgements again")
                if self._pending_move and self._looks_like_ack(text):
                    self._ack_event.set()
                else:
                    # Not a reply to anything we asked -- so the board chatters
                    # on its own and "it spoke" is not proof a move finished.
                    # Surfaced in the panel so the ack count is read with that
                    # in mind rather than trusted blindly.
                    self.unsolicited += 1
                await self.broadcast_log(entry)
        except websockets.ConnectionClosed:
            pass
        finally:
            if self.arduino is ws:
                self.arduino = None
                self.arduino_since = None
                self.stop_jog()
                self._note("Arduino disconnected")
                await self.broadcast()

    # ── motion ──────────────────────────────────────────────────────────────

    def _clamp_to_limits(self, dx_um, dy_um):
        """Trim a move to what the soft limits allow, in whole micrometres.

        Trimming rather than rejecting is deliberate: jogging into a limit
        should coast to the edge and stop there, not stop one quantum short and
        leave the last fraction of travel unreachable. The trimmed value is what
        gets sent AND what gets accumulated, so the two can never disagree.
        """
        if not self.config['limits_enabled']:
            return dx_um, dy_um
        x_lo = int(round(self.config['x_min_mm'] * UM))
        x_hi = int(round(self.config['x_max_mm'] * UM))
        y_lo = int(round(self.config['y_min_mm'] * UM))
        y_hi = int(round(self.config['y_max_mm'] * UM))
        nx = max(x_lo, min(x_hi, self.x_um + dx_um))
        ny = max(y_lo, min(y_hi, self.y_um + dy_um))
        return nx - self.x_um, ny - self.y_um

    def _estimated_move_time(self, dx_um, dy_um):
        speed = max(0.1, float(self.config['speed_mm_s']))
        travel_mm = (abs(dx_um) + abs(dy_um)) / UM
        return travel_mm / speed + float(self.config['move_overhead_s'])

    async def move_rel(self, dx_mm, dy_mm, source='move'):
        """Send one relative move and wait for it to resolve. Returns a dict."""
        if self.arduino is None:
            raise RuntimeError("Arduino is not connected")

        cap = float(self.config['max_move_mm'])
        if abs(dx_mm) > cap or abs(dy_mm) > cap:
            raise ValueError(f"move exceeds max_move_mm ({cap} mm)")

        dx_um = int(round(dx_mm * UM))
        dy_um = int(round(dy_mm * UM))
        dx_um, dy_um = self._clamp_to_limits(dx_um, dy_um)
        if dx_um == 0 and dy_um == 0:
            return {'moved': False, 'reason': 'at limit'}

        async with self._move_lock:
            # Re-clamp: another move may have run while we queued for the lock.
            dx_um, dy_um = self._clamp_to_limits(dx_um, dy_um)
            if dx_um == 0 and dy_um == 0:
                return {'moved': False, 'reason': 'at limit'}
            ws = self.arduino
            if ws is None:
                raise RuntimeError("Arduino is not connected")

            wire_x = -dx_um if self.config['invert_x'] else dx_um
            wire_y = -dy_um if self.config['invert_y'] else dy_um
            frame = f"{_fmt_mm(wire_x)},{_fmt_mm(wire_y)}"

            self._ack_event.clear()
            self._pending_move = True
            self._moving = True
            t0 = time.monotonic()
            try:
                await ws.send(frame)
            except Exception as e:
                self._pending_move = False
                self._moving = False
                raise RuntimeError(f"send failed: {e}")

            # Position advances now, not on ack: the belt is moving whether or
            # not the board ever tells us so, and a readout that lagged every
            # move by its ack would be wrong for the whole duration of the move.
            self.commanded_x_um += dx_um
            self.commanded_y_um += dy_um
            self.moves_sent += 1
            entry = {'t': time.time(), 'line': f"pi -> uno: {frame}  ({source})"}
            self.log.append(entry)
            print(f"[rover] {entry['line']}", flush=True)
            await self.broadcast_log(entry)
            await self.broadcast()

            est = self._estimated_move_time(dx_um, dy_um)
            acked = False
            if self._ack_expected:
                try:
                    await asyncio.wait_for(self._ack_event.wait(),
                                           est + float(self.config['ack_grace_s']))
                    acked = True
                except asyncio.TimeoutError:
                    acked = False
            self._pending_move = False

            if acked:
                self.moves_acked += 1
                self.confirmed_x_um += dx_um
                self.confirmed_y_um += dy_um
                self._silent_streak = 0
            else:
                self.moves_timed_out += 1
                self.unacked_travel_um += abs(dx_um) + abs(dy_um)
                self._silent_streak += 1
                if self.moves_timed_out == 1:
                    self._note("no reply from the Arduino within the move estimate -- "
                               "running open loop, position is commanded not confirmed")
                if self._ack_expected and self._silent_streak >= ACK_GIVEUP:
                    self._ack_expected = False
                    self._note(f"{ACK_GIVEUP} moves with no reply -- this board does not "
                               "acknowledge; pacing on the move-time estimate alone")

            # Even a prompt ack may mean "received", not "finished". Holding the
            # line for the full estimated travel time is what keeps us from
            # overrunning a board whose buffering we cannot see.
            if self.config['enforce_move_time']:
                remaining = est - (time.monotonic() - t0)
                if remaining > 0:
                    await asyncio.sleep(remaining)

            self._moving = False
            self._save_state()
            await self.broadcast()
            return {'moved': True, 'acked': acked, 'dx_um': dx_um, 'dy_um': dy_um}

    # ── jog (click and hold) ────────────────────────────────────────────────

    def start_jog(self, axis, direction):
        if axis not in ('x', 'y'):
            raise ValueError("axis must be 'x' or 'y'")
        direction = 1 if direction >= 0 else -1
        # Each jog gets its own dict, and its loop runs only while `self._jog`
        # is still that exact object. A press arriving in the moments while the
        # previous loop is winding down therefore always gets a live loop of its
        # own -- reusing one task and testing `.done()` would drop the new jog
        # into the gap between the old loop's last statement and its completion.
        jog = {'axis': axis, 'dir': direction,
               'deadline': time.monotonic() + JOG_HOLD_TIMEOUT}
        self._jog = jog
        self._jog_task = asyncio.create_task(self._jog_loop(jog))

    def hold_jog(self):
        if self._jog is not None:
            self._jog['deadline'] = time.monotonic() + JOG_HOLD_TIMEOUT

    def stop_jog(self):
        """Ends the jog train. The move currently in flight still completes --
        it is already inside the Arduino and there is no command to recall it."""
        self._jog = None

    async def _jog_loop(self, jog):
        # `self._jog is jog` is the liveness test throughout: it goes false when
        # the operator releases the key, when a newer jog supersedes this one, or
        # when this loop itself decides to stop.
        while self._jog is jog:
            if time.monotonic() > jog['deadline']:
                self._note("jog hold timed out -- stopping")
                break
            step = float(self.config['jog_step_mm']) * jog['dir']
            dx = step if jog['axis'] == 'x' else 0.0
            dy = step if jog['axis'] == 'y' else 0.0
            try:
                res = await self.move_rel(dx, dy, source='jog')
            except Exception as e:
                self._last_error = str(e)
                self._note(f"jog aborted: {e}")
                await self.broadcast_error(str(e))
                break
            if not res.get('moved'):
                self._note(f"jog stopped: {res.get('reason')}")
                break
        # Only retire the jog this loop was actually driving -- a newer one may
        # already have taken the slot while the last move was finishing.
        if self._jog is jog:
            self._jog = None
        await self.broadcast()

    # ── homing / origin ─────────────────────────────────────────────────────

    def set_position(self, x_mm, y_mm):
        """Declare where the rover physically is right now.

        This is the only ground truth the system has, so it is also where the
        drift budget is cleared: everything accumulated since the last
        declaration has just been superseded by the operator's measurement.
        Machine coordinates (total commanded travel since the server started)
        are deliberately untouched, so re-homing never erases the record of how
        far the rig has actually been driven.
        """
        self.origin_x_um = self.commanded_x_um - int(round(x_mm * UM))
        self.origin_y_um = self.commanded_y_um - int(round(y_mm * UM))
        self.confirmed_x_um = self.commanded_x_um
        self.confirmed_y_um = self.commanded_y_um
        self.unacked_travel_um = 0
        self.position_stale = False
        self._note(f"position declared: x={x_mm} y={y_mm} mm (drift budget cleared)")
        self._save_state()

    def set_config(self, updates):
        for k, v in updates.items():
            if k not in self.config:
                continue
            cur = self.config[k]
            if isinstance(cur, bool):
                self.config[k] = bool(v)
            elif isinstance(cur, float):
                self.config[k] = float(v)
            else:
                self.config[k] = v
        if self.config['jog_step_mm'] <= 0:
            self.config['jog_step_mm'] = DEFAULT_CONFIG['jog_step_mm']
        self._save_state()


# ── groundstation socket ────────────────────────────────────────────────────

async def client_handler(rover, ws):
    rover.clients.add(ws)
    try:
        await ws.send(json.dumps({'type': 'rover_status', **rover.status()}))
        await ws.send(json.dumps({'type': 'rover_log_history', 'lines': list(rover.log)}))
        async for raw in ws:
            try:
                cmd = json.loads(raw)
            except ValueError:
                continue
            await dispatch(rover, ws, cmd)
    except websockets.ConnectionClosed:
        pass
    finally:
        rover.clients.discard(ws)
        if not rover.clients:
            # Nobody is holding the key any more, by definition.
            rover.stop_jog()


async def dispatch(rover, ws, cmd):
    action = cmd.get('cmd')
    try:
        if action == 'rover_get_status':
            await ws.send(json.dumps({'type': 'rover_status', **rover.status()}))

        elif action == 'rover_set_position':
            rover.set_position(float(cmd.get('x_mm', 0)), float(cmd.get('y_mm', 0)))
            await rover.broadcast()

        elif action == 'rover_set_config':
            rover.set_config(cmd.get('config') or {})
            await rover.broadcast()

        elif action == 'rover_jog_start':
            rover.start_jog(cmd.get('axis'), int(cmd.get('dir', 1)))
            await rover.broadcast()

        elif action == 'rover_jog_hold':
            rover.hold_jog()

        elif action == 'rover_jog_stop':
            rover.stop_jog()
            await rover.broadcast()

        elif action == 'rover_step':
            # One quantum, for a click without a hold.
            axis = cmd.get('axis')
            direction = 1 if int(cmd.get('dir', 1)) >= 0 else -1
            step = float(cmd.get('mm', rover.config['jog_step_mm'])) * direction
            dx = step if axis == 'x' else 0.0
            dy = step if axis == 'y' else 0.0
            asyncio.create_task(_guarded(rover, rover.move_rel(dx, dy, source='step')))

        elif action == 'rover_move_rel':
            asyncio.create_task(_guarded(rover, rover.move_rel(
                float(cmd.get('dx_mm', 0)), float(cmd.get('dy_mm', 0)), source='move')))

        elif action == 'rover_stop':
            rover.stop_jog()
            rover._note("stop requested -- the in-flight move still finishes "
                        "(the Arduino has no abort command)")
            await rover.broadcast()

        elif action == 'rover_clear_error':
            rover._last_error = None
            await rover.broadcast()

    except Exception as e:
        rover._last_error = str(e)
        await ws.send(json.dumps({'type': 'rover_error', 'message': str(e)}))
        await rover.broadcast()


async def _guarded(rover, coro):
    """Runs a move that was fired off without a client awaiting it, so a failure
    still reaches the operator instead of dying inside a detached task."""
    try:
        await coro
    except Exception as e:
        rover._last_error = str(e)
        rover._note(f"move failed: {e}")
        await rover.broadcast_error(str(e))
        await rover.broadcast()


async def main():
    parser = argparse.ArgumentParser(description='Rover / stepper gantry control server')
    parser.add_argument('--port', type=int, default=PORT,
                        help=f'groundstation WebSocket port (default: {PORT})')
    parser.add_argument('--arduino-port', type=int, default=ARDUINO_PORT,
                        help=f'port the Arduino dials in on (default: {ARDUINO_PORT})')
    parser.add_argument('--no-persist', action='store_true',
                        help='do not load or save rover_state.json')
    args = parser.parse_args()

    rover = Rover(persist=not args.no_persist)
    rover._loop = asyncio.get_running_loop()

    stop = asyncio.get_running_loop().create_future()

    def request_stop():
        if not stop.done():
            stop.set_result(None)

    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGINT, request_stop)
    loop.add_signal_handler(signal.SIGTERM, request_stop)

    print(f"[rover] groundstation server on ws://0.0.0.0:{args.port}")
    print(f"[rover] waiting for Arduino on ws://0.0.0.0:{args.arduino_port}")

    async with websockets.serve(lambda ws: client_handler(rover, ws), '0.0.0.0', args.port), \
               websockets.serve(rover.arduino_handler, '0.0.0.0', args.arduino_port,
                                ping_interval=20, ping_timeout=20):
        await stop

    rover._save_state()
    print("\n[rover] stopped.")


if __name__ == '__main__':
    asyncio.run(main())
