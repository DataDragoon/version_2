// C-scan grid geometry.
//
// A C-scan is a rectangular raster of B-scan positions over the wall. Capture
// follows a boustrophedon ("snake") path so the operator never has to lift and
// return: start at the bottom-left cell, sweep right along the bottom row, step
// up one row, sweep back right-to-left, step up, sweep left-to-right, and so on
// until the grid is full.
//
//   iy=2  ┌───◄───◄───◄───┐
//   iy=1  └───►───►───►───┘
//   iy=0  ┌───◄───◄───◄───┘        (iy=0 captured first, left-to-right)
//         ix=0 ............ hCount-1
//
// Each captured position stores its own grid_ix / grid_iy, so the plan view
// stays correct even if the grid dimensions are edited part-way through a scan.

// Snake path: capture order index -> grid cell. Row 0 is the bottom row and
// runs left-to-right; every subsequent row reverses.
export function cellForIndex(index, hCount) {
  const h = Math.max(1, hCount);
  const iy = Math.floor(index / h);
  const along = index % h;
  return { ix: iy % 2 === 0 ? along : h - 1 - along, iy };
}

// Inverse of cellForIndex.
export function indexForCell(ix, iy, hCount) {
  const h = Math.max(1, hCount);
  const along = iy % 2 === 0 ? ix : h - 1 - ix;
  return iy * h + along;
}

// Physical offset of a cell from the bottom-left corner of the grid, in cm.
export function cellPosition(ix, iy, hStep, vStep) {
  return { xCm: ix * hStep, yCm: iy * vStep };
}

// Everything the panel shows about the swept rectangle.
export function gridStats({ hCount, hStep, vCount, vStep }) {
  const h = Math.max(1, hCount);
  const v = Math.max(1, vCount);
  const width = hStep * (h - 1);
  const height = vStep * (v - 1);
  return {
    total: h * v,
    width,
    height,
    area: width * height,
    // Sampling is only meaningful once there is more than one line in that axis.
    hSampled: h > 1,
    vSampled: v > 1,
  };
}

// Gated intensity of one position's range profile, in dB. This is the value a
// C-scan cell is coloured by: the depth axis collapsed to a single number over
// the slice the operator selected.
export function gatedIntensity(magnitudes, distances, gateStartM, gateEndM, metric) {
  if (!magnitudes || !distances) return -Infinity;
  let peak = -Infinity;
  let sumLin = 0;
  let sumDb = 0;
  let count = 0;

  for (let j = 0; j < magnitudes.length && j < distances.length; j++) {
    if (distances[j] < gateStartM || distances[j] > gateEndM) continue;
    const db = magnitudes[j];
    if (db > peak) peak = db;
    const lin = Math.pow(10, db / 20);
    sumLin += lin * lin;
    sumDb += db;
    count++;
  }
  if (count === 0) return -Infinity;

  if (metric === 'energy') return 10 * Math.log10(sumLin / count + 1e-12);
  if (metric === 'mean') return sumDb / count;
  return peak;
}

// Fill the grid with gated intensities. Returns a hCount x vCount array indexed
// [iy * hCount + ix], holding null where nothing has been captured yet. A cell
// that was captured but has no range bin inside the gate keeps its entry with a
// non-finite value, so the display can tell "empty" from "gated out".
export function buildCscanGrid(scanData, params) {
  const { hCount, vCount, gateStart, gateEnd, metric } = params;
  const h = Math.max(1, hCount);
  const v = Math.max(1, vCount);
  const cells = new Array(h * v).fill(null);
  const gateStartM = gateStart / 100;
  const gateEndM = gateEnd / 100;

  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < scanData.length; i++) {
    const pos = scanData[i];
    // Positions imported from a v4 (linear) B-scan carry no grid indices, so
    // lay them out along the snake path the current grid describes.
    const cell = (pos.grid_ix != null && pos.grid_iy != null)
      ? { ix: pos.grid_ix, iy: pos.grid_iy }
      : cellForIndex(i, h);
    if (cell.ix < 0 || cell.ix >= h || cell.iy < 0 || cell.iy >= v) continue;

    const value = gatedIntensity(pos.magnitudes, pos.distances, gateStartM, gateEndM, metric);
    cells[cell.iy * h + cell.ix] = { value, pos, order: i };
    if (!isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return { cells, hCount: h, vCount: v, min, max, filled: cells.filter(Boolean).length };
}

// ── Rover raster ───────────────────────────────────────────────────────────
//
// Driven by the gantry rather than by hand, the natural origin is the TOP-LEFT
// corner: the rover sweeps the top row left-to-right, drops one row, sweeps
// back right-to-left, and so on downwards. That is the mirror image of the
// hand-held order above, which starts bottom-left and climbs.
//
//   row 0 (iy = vCount-1)  ORIGIN ──►───►───►──┐   captured first
//   row 1 (iy = vCount-2)  ┌──◄───◄───◄────────┘
//   row 2 (iy = vCount-3)  └──►───►───►──┐
//
// Cell coordinates stay in the display's frame (iy = 0 is the bottom row) so
// the plan view, the export and everything downstream are identical whichever
// way the raster was driven. Only the capture ORDER differs.
export function roverCellForIndex(index, hCount, vCount) {
  const h = Math.max(1, hCount);
  const v = Math.max(1, vCount);
  const row = Math.floor(index / h);      // 0 = top row = the origin's row
  const along = index % h;
  return { ix: row % 2 === 0 ? along : h - 1 - along, iy: v - 1 - row };
}

// Capture order for whichever mode is driving the raster.
export function orderedCellForIndex(index, hCount, vCount, scanMode) {
  return scanMode === 'rover'
    ? roverCellForIndex(index, hCount, vCount)
    : cellForIndex(index, hCount);
}

// Rover-frame target of a grid cell, in mm.
//
// `origin` is where the rover has to stand for the grid's top-left corner, in
// the rover's own frame (x grows right, y grows up). The grid extends right and
// DOWNWARD from there, so a cell's y is below the origin by however many rows
// it sits above the bottom of the grid. Steps are cm in the params and mm on
// the rover, hence the tens.
export function cellRoverTarget(ix, iy, params, origin) {
  const v = Math.max(1, params.vCount);
  return {
    x_mm: origin.x + ix * params.hStep * 10,
    y_mm: origin.y - (v - 1 - iy) * params.vStep * 10,
  };
}

// The rectangle the rover has to reach, in its own frame. Used to check the
// grid fits inside the soft limits before a single move is issued -- there are
// no endstops, so finding out half way through is not an option.
export function gridRoverExtent(params, origin) {
  const stats = gridStats(params);
  return {
    xMin: origin.x,
    xMax: origin.x + stats.width * 10,
    yMin: origin.y - stats.height * 10,
    yMax: origin.y,
  };
}
