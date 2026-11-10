/**
 * Last-known battery per G1 serial.
 *
 * The G1 advertisement carries only [side][serial] (firmware bt_start.c) —
 * battery is only reported over UART after connect (F5 0A push / 0x2C poll).
 * So the pairing scan screen can only show a *remembered* value for sets it
 * has connected to before. G1Context writes here on every battery change;
 * scan.tsx reads once per discovered serial.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type BatterySnapshot = { L: number | null; R: number | null; at: number };

const KEY = (serial: string) => `g1_battery_${serial}`;

export async function saveBattery(serial: string, L: number | null, R: number | null): Promise<void> {
  if (L == null && R == null) return;
  const prev = await loadBattery(serial);
  const snap: BatterySnapshot = { L: L ?? prev?.L ?? null, R: R ?? prev?.R ?? null, at: Date.now() };
  await AsyncStorage.setItem(KEY(serial), JSON.stringify(snap));
}

export async function loadBattery(serial: string): Promise<BatterySnapshot | null> {
  const raw = await AsyncStorage.getItem(KEY(serial));
  if (!raw) return null;
  try { return JSON.parse(raw) as BatterySnapshot; } catch { return null; }
}
