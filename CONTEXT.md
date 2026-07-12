# version0 — SFCW Radar Wall Imaging System

## Mission

Through-wall imaging using a Stepped-Frequency Continuous Wave (SFCW) radar,
with OptiFlow-based positioning for coherent aperture synthesis.

---

## Hardware

| Component | Model | Interface | Role |
|-----------|-------|-----------|------|
| Compute | Raspberry Pi (with AI HAT+) | — | On-board control, sensor fusion, data capture |
| Camera | Raspberry Pi NoIR Camera v3 | CSI | Optical flow input (OptiFlow positioning) |
| LiDAR | TF-LC02 | UART (serial) | Range/distance reference |
| IMU | MPU-6500 | I2C | Orientation, acceleration, gyro |
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
│  │  - OptiFlow compute │          │  - Heavy processing  │ │
│  │  - Data streaming   │          │  - 3D visualization  │ │
│  └─────────────────────┘          └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Operational Model

- **No direct input to the Pi.** All commands originate from the groundstation.
- **Pi streams data** (raw IQ, sensor logs, camera frames) to groundstation.
- **Heavy processing** (image reconstruction, SAR focusing) runs on the PC.
- **Debug everything.** Every subsystem has a dedicated debug view on groundstation.

## Groundstation Debug Tools (planned)

- LiDAR distance log + live plot
- IMU orientation/accel live view
- Camera direct view (raw NoIR feed)
- OptiFlow vector field visualization
- OptiFlow-derived position (2D/3D)
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
│   ├── sensors/           # LiDAR, IMU, camera drivers/readers
│   ├── radar/             # bladeRF SFCW control
│   ├── optiflow/          # Optical flow positioning (AI HAT+)
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
- Multiplexed channels (IQ data, sensor data, camera, status)

## Radar Parameters (TBD)

- Frequency range: depends on bladeRF model (likely 300 MHz - 3.8 GHz)
- Step size: TBD based on range resolution needs
- Dwell time per step: TBD
- TX power: TBD
- Antenna polarization: co-pol initially

## Wiring — MPU-6500 (I2C mode)

| MPU-6500 Pin | Raspberry Pi | Notes |
|---|---|---|
| VIN | Pin 2 (5V) | Powers onboard regulator |
| 3V3 | NC | Regulator output, leave unconnected |
| GND | Pin 6 (GND) | Common ground |
| SCL | Pin 5 (GPIO 3) | I2C1 clock |
| SDA | Pin 3 (GPIO 2) | I2C1 data |
| SDD/SAO | GND | I2C address = 0x68 |
| NCS | Pin 1 (3.3V) | High = I2C mode |
| CSB | Pin 1 (3.3V) | High = I2C mode |

## Current Status

- [x] Project scaffolded
- [x] Context documented
- [ ] Hardware connections (IMU wiring defined, not yet physical)
- [x] IMU driver (MPU-6500 over I2C)
- [ ] Other sensor drivers
- [ ] BladeRF SFCW implementation
- [ ] OptiFlow pipeline
- [ ] Groundstation UI
- [ ] Network protocol
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
