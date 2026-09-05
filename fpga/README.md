# SignalTap-instrumented FPGA image

`hosted_signaltap.rbf` — bladeRF 2.0 micro (xA9, `5CEBA9F23C8`) hosted image with
nuand's `fifo_writer.stp` SignalTap instance compiled in.

Built 2026-09-05 from a **clean** clone of the bladeRF repo at commit `fb14f63a`
(`C:\Users\1109h\bladeRF_clean`, 0 tracked changes), so it does NOT contain the
uncommitted `rx.vhd` / `bladerf-hosted.vhd` edits sitting in the main working
tree.

    Fitter:      Successful, 9,272 / 113,560 ALMs (8%)
    Registers:   23,211
    Block RAM:   7,697,920 / 12,492,800 bits (62%) -- mostly the capture buffer
    Timing:      closed, every clock positive slack, zero TNS
    SignalTap:   1,373 taps connected inside rx:U_rx|fifo_writer:U_fifo_writer|

## Load it — over USB, NOT JTAG

    bladeRF-cli -e "load fpga fpga/hosted_signaltap.rbf" -e "version"

Confirm it reports `configured from host` rather than `configured from SPI
flash`. That means the instrumented image is live AND the USB link survived.

**Do not** program this with `quartus_pgm` over JTAG while the host has the
device open. Reconfiguring the FPGA underneath a live FX3 breaks the GPIF
handshake, the board stops enumerating, and recovery needs a full power cycle
with the JTAG ribbon *disconnected* — an active JTAG session also prevents the
FPGA falling back to its flash image. JTAG is for observing with SignalTap;
USB is for configuring.

Loaded into FPGA RAM, so a power cycle reverts to the flash image. Nothing here
can brick the board.

## What it taps

Clock is `fifo_writer|clock` (the `rx_clock` / AD9361 domain, ~40 MHz at
10 Msps), 8192 samples deep — roughly a **200 µs** window. Short enough that you
trigger on an event rather than browse; a 5 ms sweep step does not fit.

    fifo_data[63:0]            the packed 64-bit output word
    fifo_usedw[11:0]           FIFO fill level
    overflow_count[63:0]       cumulative sample drops
    overflow_duration[15:0]
    timestamp[63:0]
    in samples                 pre-packing I/Q + data_v per channel
    in sample controls         per-channel enable
    fifo_current.*             FSM state, including write_cycle and
                               fifo_12b_buf -- the SC12 packed-mode internals
    meta_fifo_data[127:0], meta_fifo_usedw[8:0]
    eight_bit_mode_en, enable, fifo_clear, dma_buf_size[9:0]

## Using SignalTap (on the Windows box, where the USB Blaster is)

    quartus_stpw C:\Users\1109h\bladeRF_clean\hdl\fpga\platforms\bladerf-micro\signaltap\fifo_writer.stp

Set Hardware to `USB-Blaster [USB-0]`, Device to the `5CEBA9`, and point the
SOF Manager at the matching `.sof` so node names resolve:

    C:\Users\1109h\bladeRF_clean\hdl\quartus\work\bladerf-micro-A9-hosted\output_files\hosted.sof

Then trigger on `enable` (rising edge) for a first capture, or
`overflow_count` (either edge) to catch a real sample drop.

## Rebuilding this

    cd hdl/quartus
    export QUARTUS_ROOT=/c/altera_lite/25.1std
    export QUARTUS_ROOTDIR="$QUARTUS_ROOT/quartus"
    export PATH="$QUARTUS_ROOTDIR/bin64:$QUARTUS_ROOT/nios2eds/bin:$QUARTUS_ROOT/nios2eds/sdk2/bin:$QUARTUS_ROOT/nios2eds/bin/gnu/H-x86_64-mingw32/bin:$QUARTUS_ROOTDIR/sopc_builder/bin:$PATH"
    bash build_bladerf.sh -b bladeRF-micro -r hosted -s A9 \
         -a ../fpga/platforms/bladerf-micro/signaltap/fifo_writer.stp -f

Note: Quartus 25.1std can no longer generate the Nios II system from scratch —
Qsys rejects `nios2.reset`, and `nios2-bsp-create-settings` fails with
"crt0.S source code not located in installed CPU module driver". Builds only
succeed because `hdl/quartus/work/bladerf-micro-A9-hosted/` already holds
`nios_system.qsys`, `nios_system.sopcinfo` and a prebuilt `bladeRF_nios_bsp/`
generated on 2026-08-22. Those are untracked and irreplaceable — back them up.
