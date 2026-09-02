# FPGA image: first-packet mark

`hostedxA9-first-packet-2026-09-02.rbf` — bladeRF 2.0 micro xA9 (5CEBA9F23C8).

Built 2026-09-02 11:17, Quartus 25.1std, 0 errors, all timing slacks positive
(worst +0.611 ns). 6,722 ALMs (6%), 274 M10K (22%).

## What it adds

The host cannot normally tell which RX buffer is the first one CAPTURED after a
retune. That is the entire reason `settle_count` exists, and why it has to be
found by experiment rather than known. This image marks that buffer in-band.

    NIOS profile_activate()          toggles RFFE GPO bit 24 on every retune
      -> rffe_gpio.o(24)             bits 31..24 are undecoded in the output
                                     direction (bladerf_p.vhd, "Reserved as
                                     input"), so nothing else reads them
      -> synchroniser + XOR edge     sys_clock -> rx_clock, one pulse per edge
      -> rx.vhd dsp_restart          MARK_FIRST_PACKET = true
      -> first metadata header       marked via the mini_exp2 bit
      -> host metadata.status        BLADERF_META_FLAG_RX_HW_MINIEXP2

A TOGGLE rather than a pulse: NIOS cannot emit a pulse short enough to matter at
the sample clock, but a level change gives exactly one clean edge per retune
however long NIOS takes.

## Why the mark rides on mini_exp2

It is the only bit that is both stamped into every metadata header by the FPGA
and passed through to the caller under SC16_Q11_META. `metadata.status` is
masked to exactly three bits in libbladeRF `sync.c:712-715` (UNDERFLOW,
MINIEXP1, MINIEXP2). The natural home would be the 8-bit `pkt_flags` field, but
that reaches `bladerf_metadata.flags` only under `BLADERF_FORMAT_PACKET_META`,
which the Python bindings do not expose and which changes the buffer layout.

COST: while this image is loaded, mini_exp2 reports the mark, NOT its physical
pin. The external-trigger use of that pin and this mark are mutually exclusive.
mini_exp1 is untouched.

## Load

    bladeRF-cli -L fpga/hostedxA9-first-packet-2026-09-02.rbf   # to flash
    bladeRF-cli -l fpga/hostedxA9-first-packet-2026-09-02.rbf   # volatile

## Use

    git checkout first_packet_flag
    engine.use_first_packet_flag = True

Prints per step:

    [sfcw] step 7 2420.000 MHz  FIRST PACKET of this frequency  fifo@103537112
           skipped 2 buffer(s) before the mark

`skipped N` is the quantity settle_count has been estimating.

## NOT verified on hardware

Everything checkable without a board was checked: compiles, simulates, builds,
timing closes, and the NIOS elf postdates the source edit. The one unproven link
is whether bit 24 actually drives `rffe_gpio.o(24)` in fabric -- that is read
from the `unpack -> rffe_gpo_t` comments, not measured.

If the mark never arrives you get, once per sweep:

    [sfcw] WARNING: no first-packet mark within 16 buffers at step 0

That means the NIOS->fabric handoff failed, and the mark bit is where to look.

## Source

bladeRF working tree, uncommitted at build time:
  pkt_retune2.c        bit-24 toggle in profile_activate()
  bladerf-hosted.vhd   synchroniser, edge detect, dsp_restart wiring
  rx.vhd               MARK_FIRST_PACKET, first_pending, mini_exp substitution
  bladerf-hosted.qip   registers divider_pipe/complex_div_pipe/seq_adder/
                       iq_dword_packer (needed because Quartus analyses entity
                       references inside a false generate block)
