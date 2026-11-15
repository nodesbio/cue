/**
 * Lens pacing calibration — pure logic + shared constants.
 *
 * The orchestration (driving frames, showing the on-glass counter, the STOP
 * button) lives in the Calibrate UI because the RENDER phase needs a human in
 * the loop: the firmware emits no render-confirm frame, so the only way to
 * detect L's panel freeze is a person watching the glasses. This module owns
 * the parts worth testing in isolation: the ramp schedule and the two ceiling
 * analyses (link from the ACK ledger; render from the human STOP index).
 *
 * See calibrationStore.ts for why the two lenses need independent ceilings.
 */
import type { Side } from './calibrationStore';

/** Inter-frame intervals (ms) the calibration ramp steps DOWN through, slowest
 *  (safest) first. ~8 → 60 f/s. Matches the characterization harness so field
 *  numbers map 1:1 onto calibration numbers. */
export const RAMP_MS = [120, 90, 60, 40, 26, 16] as const;

/** Frames spent at each ramp stage. The ramp sends RAMP_MS.length * STAGE_FRAMES
 *  text frames per lens (default 160 total — matches the harness). */
export const STAGE_FRAMES = 27;

/** Total frames the ramp sends per lens (seq 1..TOTAL_FRAMES). */
export const TOTAL_FRAMES = RAMP_MS.length * STAGE_FRAMES;

/** ms/frame for a given 1-based frame index in the ramp. */
export function intervalForFrame(frame: number): number {
  const stage = Math.min(RAMP_MS.length - 1, Math.floor((frame - 1) / STAGE_FRAMES));
  return RAMP_MS[stage];
}

/** The ramp stage (0-based) a frame index falls in. */
export function stageForFrame(frame: number): number {
  return Math.min(RAMP_MS.length - 1, Math.floor((frame - 1) / STAGE_FRAMES));
}

/**
 * LINK ceiling, per side, from the ACK ledger (seqs the firmware actually
 * 0x4e-ACK'd). The ceiling is the interval of the LAST stage the lens got
 * through with no missing ACKs — i.e. the fastest pace whose whole stage was
 * clean. If a lens drops nothing, its link ceiling is the fastest ramp
 * interval (link is not the bottleneck). If it drops in the very first stage,
 * the ceiling is the slowest interval (link is badly degraded).
 *
 * "Clean stage" = every seq in [stageStart..stageEnd] present in `acked`,
 * bounded by how far the ramp actually reached (`reached`).
 */
export function linkCeilingMs(acked: Set<number>, reached: number): number {
  let lastCleanStage = -1;
  for (let st = 0; st < RAMP_MS.length; st++) {
    const start = st * STAGE_FRAMES + 1;
    const end = Math.min((st + 1) * STAGE_FRAMES, reached);
    if (start > reached) break; // ramp never got here
    let clean = true;
    for (let s = start; s <= end; s++) {
      if (!acked.has(s)) { clean = false; break; }
    }
    if (!clean) break;
    lastCleanStage = st;
  }
  // No clean stage at all ⇒ link choked immediately; pin to slowest interval.
  if (lastCleanStage < 0) return RAMP_MS[0];
  return RAMP_MS[lastCleanStage];
}

/**
 * RENDER ceiling, per side, from the human STOP. `stopFrame` is the frame
 * index showing on-glass when the user tapped STOP (the panel had just frozen).
 * The last pace the panel SUSTAINED is the stage BEFORE the one it froze in —
 * we back off one stage to stay safely below the edge. If the user never
 * stopped (watched it finish clean), render was never the bottleneck ⇒ fastest
 * interval. null stopFrame means the render phase was skipped.
 */
export function renderCeilingMs(stopFrame: number | null): number | null {
  if (stopFrame == null) return null;
  const frozeStage = stageForFrame(stopFrame);
  const safeStage = Math.max(0, frozeStage - 1); // back off below the edge
  return RAMP_MS[safeStage];
}

/**
 * The single committed scroll pace = the SLOWEST (largest ms) ceiling across
 * both lenses and both failure layers. Larger interval = safer. Render ceilings
 * that are null (phase skipped) are ignored. Guarantees ≥ the slowest ramp
 * interval is never exceeded — we never pace faster than the worst lens can go.
 */
export function committedPaceMs(
  link: Record<Side, number>,
  render: Record<Side, number | null>,
): number {
  const candidates = [link.L, link.R, render.L, render.R].filter(
    (v): v is number => v != null,
  );
  return Math.max(...candidates);
}
