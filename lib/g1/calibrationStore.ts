/**
 * Per-pair lens pacing calibration.
 *
 * The two G1 lenses fail at DIFFERENT layers, so no single hardcoded frame
 * interval is correct for every pair or every charge level (characterized
 * 2026-11-15):
 *
 *   • R is LINK-limited — its BLE radio starts dropping text frames (ACK gaps)
 *     at ~16 f/s. Measurable purely in software via the 0x4e ACK ledger.
 *   • L is RENDER-limited — its display commits cleanly only to ~8 f/s; above
 *     that the panel freezes while the link keeps ACKing. The firmware exposes
 *     NO render-confirm frame (G1Core lines 225-226), so this ceiling is
 *     INVISIBLE to software and can only be captured with a human in the loop
 *     (the "Calibrate" UI: user taps STOP when the on-glass counter freezes).
 *
 * Both ceilings also drift with battery (lower cell voltage ⇒ slower MCU/BLE),
 * so we store the battery level at calibration time and can prompt a recal when
 * charge has moved materially. The live scroll path reads `paceMs` — the single
 * safe lockstep interval = max(render ceiling, link floor) across both lenses.
 *
 * Keyed by serial, mirroring batteryStore.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Side = 'L' | 'R';

export type Calibration = {
  /** Committed safe inter-frame interval (ms) for the live scroll path =
   *  max(renderCeilingMs, linkCeilingMs) across both lenses. Larger = slower. */
  paceMs: number;
  /** Per-side link ceiling (ms/frame) where BLE ACK gaps began. Auto-measured. */
  linkCeilingMs: Record<Side, number>;
  /** Per-side render ceiling (ms/frame) where the panel froze. Human-confirmed
   *  via the Calibrate UI; null if that phase was skipped. */
  renderCeilingMs: Record<Side, number | null>;
  /** Battery % per side at calibration time — for drift detection / recal. */
  battAtCalib: Record<Side, number | null>;
  at: number;
};

const KEY = (serial: string) => `g1_calibration_${serial}`;

/** Battery drift (percentage points) beyond which calibration is considered
 *  stale and the UI should suggest recalibrating. */
export const RECAL_BATTERY_DELTA = 25;

export async function saveCalibration(serial: string, cal: Calibration): Promise<void> {
  await AsyncStorage.setItem(KEY(serial), JSON.stringify(cal));
}

export async function loadCalibration(serial: string): Promise<Calibration | null> {
  const raw = await AsyncStorage.getItem(KEY(serial));
  if (!raw) return null;
  try { return JSON.parse(raw) as Calibration; } catch { return null; }
}

export async function clearCalibration(serial: string): Promise<void> {
  await AsyncStorage.removeItem(KEY(serial));
}

/**
 * True if stored calibration battery has drifted enough from current that the
 * pacing ceilings may no longer hold. Conservative: any side over the delta,
 * or current below the calibrated level (discharge slows the panel) triggers.
 */
export function isCalibrationStale(
  cal: Calibration,
  currentBatt: Record<Side, number | null>,
): boolean {
  for (const side of ['L', 'R'] as Side[]) {
    const was = cal.battAtCalib[side];
    const now = currentBatt[side];
    if (was == null || now == null) continue;
    if (Math.abs(was - now) >= RECAL_BATTERY_DELTA) return true;
  }
  return false;
}
