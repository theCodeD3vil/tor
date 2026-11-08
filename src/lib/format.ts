import type { SpeedUnit } from "../../shared/settings";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < UNITS.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${UNITS[i]}`;
}

export type { SpeedUnit } from "../../shared/settings";

/** MB/s keeps bytes; Mbps converts to bits (1 byte = 8 bits), both in steps of 1000 */
export function formatRate(bytesPerSec: number, unit: SpeedUnit = "MBps"): string {
  if (unit === "MBps") return `${formatBytes(bytesPerSec)}/s`;
  const measurementUnits = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let value = bytesPerSec * 8;
  let i = 0;
  while (value >= 1000 && i < measurementUnits.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${measurementUnits[i]}`;
}

// "2026-11-03" → "Nov 3" (parsed by hand: new Date("YYYY-MM-DD") is UTC and can shift a day)
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
