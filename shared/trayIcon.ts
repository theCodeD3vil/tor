// What the menubar icon shows, shared by the backend (which decides it from the live
// numbers) and the page (which draws it, see src/lib/trayIcon.ts).
import type { MenubarIcon } from "./settings";
import type { Traffic } from "./types";

export interface Value {
  /** "9.49" | "10.9" | "123" — at most 3 digits */
  num: string;
  /** "KB/s" | "Mbps" | "GB" … */
  unit: string;
}

export interface Colors {
  /** hex, "#34d399" */
  down: string;
  up: string;
}

export interface IconOptions {
  icon: MenubarIcon;
  /** bytes per bucket, oldest → newest (for the bars) */
  bars: Traffic[];
  /** one value, or two (upload first) drawn stacked */
  values: Value[];
  /** which arrows to draw, for the arrows icon */
  arrows: ("down" | "up")[];
  /** every unit a value can take in the current mode (sizes the text slot) */
  units: string[];
  colors: Colors;
  /** no network: the icon turns red */
  offline: boolean;
}

export const BAR_COUNT = 5;
export const ICON_HEIGHT = 36; // px, drawn @2x → 18pt
export const MAX_BAR_H = ICON_HEIGHT - 2;
const MIN_BAR_H = 3;
const PEAK_FLOOR = 50_000_000; // bytes: below this a bucket never fills the bar

/** the pixels a bar comes to: its height, the upload slice at the top, and whether it is lit */
export interface BarShape {
  h: number;
  upH: number;
  on: boolean;
}

export function barShapes(bars: Traffic[]): BarShape[] {
  const peak = Math.max(...bars.map((b) => b.down + b.up), PEAK_FLOOR); // idle stays small
  return bars.map((bar) => {
    const total = bar.down + bar.up;
    const h = Math.max(MIN_BAR_H, Math.round(Math.sqrt(total / peak) * MAX_BAR_H));
    return { h, upH: total > 0 ? Math.round(h * (bar.up / total)) : 0, on: total > 0 };
  });
}

/** names the image these options draw: equal keys, identical icon */
export function iconKey({
  icon,
  bars,
  values,
  arrows,
  units,
  colors,
  offline,
}: IconOptions): string {
  // the bars only matter through the pixels they come to
  const shapes = icon === "bars" && !offline ? barShapes(bars) : [];
  return JSON.stringify([icon, shapes, values, arrows, units, colors, offline]);
}
