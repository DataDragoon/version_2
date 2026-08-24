# version0 — SFCW Radar Wall Imaging System

## Mission

Within-wall imaging using a Stepped-Frequency Continuous Wave (SFCW) radar.
The goal is to image what is inside the wall (rebar, pipes, voids, studs),
not what is beyond it.

---

## Hardware

| Component | Model | Interface | Role |
|-----------|-------|-----------|------|
| Compute | Raspberry Pi (with AI HAT+) | — | On-board control, sensor fusion, data capture |
| LiDAR | TF-LC02 | UART (serial) | Range/distance reference |
| IMU | BNO085 (was MPU-6500 until 2026-08-24) | I2C | Orientation, acceleration, gyro |
| SDR | bladeRF | USB | SFCW radar TX/RX |
| Antennas | 2x Vivaldi | SMA to bladeRF | Wideband TX and RX |
| Network | Ethernet/WiFi | LAN | Pi <-> PC link |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        LAN                                   │
│                                                             │
│  ┌─────────────────────┐          ┌──────────────────────┐ │
│  │   Raspberry Pi       │          │   PC (Groundstation) │ │
│  │                     │          │                      │ │
│  │  - Sensor capture   │  ◄────►  │  - Control panel     │ │
│  │  - Radar TX/RX      │  socket  │  - Debug tools       │ │
│  │  - Data streaming   │          │  - Heavy processing  │ │
│  │                     │          │  - 3D visualization  │ │
│  └─────────────────────┘          └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Operational Model

- **No direct input to the Pi.** All commands originate from the groundstation.
- **Pi streams data** (raw IQ, sensor logs) to groundstation.
- **Heavy processing** (image reconstruction, SAR focusing) runs on the PC.
- **Debug everything.** Every subsystem has a dedicated debug view on groundstation.

## Groundstation Debug Tools (planned)

- LiDAR distance log + live plot
- IMU orientation/accel live view
- 3D position visualizer (fused estimate)
- Radar TX/RX pattern viewer
- Raw IQ waterfall / spectrogram
- SFCW range profile display
- SAR image reconstruction view
- System health / link status

## Groundstation Control Panel (planned)

- Initiate scan
- Stop / pause / resume
- Configure radar parameters (freq range, step size, dwell time)
- Configure sensor sampling rates
- Trigger calibration routines
- Data recording start/stop

## Directory Structure

```
version0/
├── pi/                    # Code that runs on the Raspberry Pi
│   ├── sensors/           # LiDAR, IMU drivers/readers
│   ├── radar/             # bladeRF SFCW control
│   ├── comms/             # Network transport to groundstation
│   └── scripts/           # Startup, calibration, utilities
├── groundstation/         # Code that runs on the PC
│   ├── ui/                # Main GUI framework
│   ├── debug/             # All debug/visualization tools
│   ├── control/           # Command panel (start/stop/config)
│   ├── processing/        # Heavy compute (SAR, image recon)
│   └── comms/             # Network transport to Pi
├── shared/                # Code used by both Pi and PC
│   ├── protocols/         # Message formats, command definitions
│   └── config/            # Shared configuration constants
├── docs/                  # Additional documentation
├── CONTEXT.md             # THIS FILE — project global context
└── CLAUDE.md              # Claude Code project instructions
```

## Network Protocol (TBD)

Communication between Pi and groundstation. Likely ZeroMQ or raw TCP sockets
with a simple framed binary protocol. Requirements:
- Low-latency command delivery (groundstation -> Pi)
- High-throughput data streaming (Pi -> groundstation)
- Multiplexed channels (IQ data, sensor data, status)

## Radar Parameters

- Hardware: bladeRF xA9 (AD9361 RFIC)
- Frequency range: 1–3 GHz (configurable, max ~3.8 GHz)
- Step size: 10 MHz default
- Dwell time per step: 1 ms (PLL settle)
- TX power: 0.9 amplitude, gain 47 dB
- Antenna polarization: co-pol initially
- Phase coherence: Dual-channel reference method — TX2→RX2 short SMA cable
  provides phase reference. Signal (RX1) divided by reference (RX2) cancels
  random PLL phase offsets between TX and RX synthesizers at each step.
  AD9361 single-synth mode does NOT work (FDD requires both PLLs active).

## Wiring — BNO085 (I2C mode)

Replaced the MPU-6500 on 2026-08-24 (same I2C1 bus). Confirmed by probe: I2C address
`0x4A` (`i2cdetect -y 1`), SCL/SDA on the same Pin 5 / Pin 3 (GPIO 3 / GPIO 2) I2C1 bus the
MPU-6500 used. **Exact VCC/GND header pins and whether RST/PS0/PS1 are wired to anything on
the Pi are not confirmed** — no GPIO shows as driving a reset line for it (`gpioinfo`), so
either those pins are strapped on-board (normal for most BNO085 breakouts, which fix
PS0/PS1 for I2C app mode and leave RST pulled up) or genuinely floating. During bring-up the
chip briefly got stuck in a state where control-channel queries worked but sensor feature
reports wouldn't enable — a power cycle fixed it (see the CLAUDE.md IMU section) — so it
does need real power, not just I2C soft reset, to leave that state. Fill in the actual VCC
pin and RST/PS status here next time the wiring is physically checked instead of leaving
this as a known gap.

## Wiring — TF-LC02 LiDAR (UART)

| TF-LC02 Pin | Raspberry Pi | Notes |
|---|---|---|
| VCC | Pin 2 (5V) | Shares 5V rail with IMU |
| GND | Pin 6 (GND) | Common ground |
| TX | Pin 10 (GPIO 15 / RXD) | LiDAR TX → Pi RX |
| RX | Pin 8 (GPIO 14 / TXD) | Pi TX → LiDAR RX |

UART enabled via `raspi-config`, serial console disabled. Device: `/dev/serial0`.

## IMU Calibration & Orientation

**Stale as of 2026-08-24 — measured for the MPU-6500, not re-verified for the BNO085 that
replaced it.** Confirmed on the bench: the BNO085's raw gravity reading lands on a different
axis than the MPU-6500's did, so the mapping below is known wrong until re-run through the
calibration discovery tool. See `imu_calibration.py`'s module docstring and the CLAUDE.md
IMU section for specifics.

MPU-6500 mounting orientation (determined via calibration tool):
- IMU +X = physical UP (gravity reads +1g on X when level)
- IMU Y = pitch axis (pitch down = gyro -Y)
- IMU Z = roll/forward axis (roll right = gyro +Z)

Body frame convention (right-hand):
- Body X = FORWARD
- Body Y = LEFT
- Body Z = UP

Data sent over WebSocket (port 9001) is in body frame:
- `accel`: [forward, left, up] in g
- `gyro`: [roll_rate, pitch_rate, yaw_rate] in deg/s
- Positive: roll right, pitch up, yaw right

Startup calibration: 2s stationary capture → gyro/accel bias saved to `pi/sensors/imu_cal.json`.
Use `--skip-cal` flag on `stream.py` to reuse previous calibration.

## Network Ports

| Service | Port | Protocol | Direction |
|---------|------|----------|-----------|
| Sensor stream (IMU + LiDAR) | 9001 | WebSocket | Pi → Browser |
| SDR control + IQ stream | 9003 | WebSocket | Pi ↔ Browser |
| Groundstation UI | 5000 | HTTP | PC local |

## Current Status

- [x] Project scaffolded
- [x] Context documented
- [x] Hardware connections (IMU + LiDAR wired and tested)
- [x] IMU driver (BNO085 over I2C, was MPU-6500)
- [x] LiDAR driver (TF-LC02 over UART)
- [x] Combined sensor WebSocket stream (port 9001)
- [x] Groundstation UI — IMU + LiDAR debug panel
- [x] IMU calibration (gyro bias + accel bias at startup, persisted to imu_cal.json)
- [ ] IMU axis remapping (IMU frame → body frame: forward/left/up) — done for MPU-6500,
      confirmed wrong for BNO085, needs re-discovery
- [x] Madgwick AHRS orientation filter (quaternion-based, groundstation 3D view)
- [x] IMU calibration discovery tool (groundstation panel)
- [x] BladeRF driver + AquaSense calibration panel (signal generator + oscilloscope)
- [ ] BladeRF SFCW implementation
- [ ] Network protocol (formal)
- [ ] Integration testing
- [ ] SAR image reconstruction

---

## Maintenance Rules

**This file and CLAUDE.md must be kept up to date by Claude (or any AI assistant)
as the project evolves.** Whenever a session produces key information — design
decisions, hardware discoveries, protocol specs, calibration data, wiring
pinouts, architectural changes, or anything a future session would need — update
these files before the session ends. They are the persistent memory of this
project across sessions, collaborators, and machines.
