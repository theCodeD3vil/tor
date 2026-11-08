// User settings, shared by the backend (which persists them and draws the menubar
// icon from them) and the popover page (which edits them).

export type SpeedUnit = "MBps" | "Mbps";
export type ThemeMode = "light" | "dark" | "system";
export type TopAppsCount = 5 | 10 | 20;
export type UpdateFrequency = "daily" | "weekly" | "monthly";
export type MenubarIcon = "bars" | "arrows" | "logo" | "none";
export type MenubarValue =
  | "download"
  | "upload"
  | "both"
  | "total-download"
  | "total-upload"
  | "net-total";

export const COLOR_PRESETS = [
  { id: "emerald", name: "Emerald", hex: "#34d399" },
  { id: "cyan", name: "Cyan", hex: "#22d3ee" },
  { id: "sky", name: "Sky", hex: "#38bdf8" },
  { id: "blue", name: "Blue", hex: "#3b82f6" },
  { id: "violet", name: "Violet", hex: "#a78bfa" },
  { id: "pink", name: "Pink", hex: "#f472b6" },
  { id: "orange", name: "Orange", hex: "#fb923c" },
  { id: "amber", name: "Amber", hex: "#fbbf24" },
] as const;
export type ColorId = (typeof COLOR_PRESETS)[number]["id"];

export interface Settings {
  unit: SpeedUnit;
  topApps: TopAppsCount;
  theme: ThemeMode;
  downloadColor: ColorId;
  uploadColor: ColorId;
  menubarIcon: MenubarIcon;
  menubarValue: MenubarValue;
  /** look for updates on a schedule; off = only when asked */
  autoUpdates: boolean;
  updateFrequency: UpdateFrequency;
  /** app names left out of Top apps and the totals (a VPN, a backup tool…); still recorded */
  ignoredApps: string[];
}

export const defaultSettings: Settings = {
  unit: "MBps",
  topApps: 20,
  theme: "system",
  downloadColor: "emerald",
  uploadColor: "blue",
  menubarIcon: "bars",
  menubarValue: "download",
  autoUpdates: true,
  updateFrequency: "daily",
  ignoredApps: [],
};

const MAX_IGNORED = 100;
const allowed: { [K in Exclude<keyof Settings, "ignoredApps">]: readonly Settings[K][] } = {
  unit: ["MBps", "Mbps"],
  topApps: [5, 10, 20],
  theme: ["light", "dark", "system"],
  downloadColor: COLOR_PRESETS.map((c) => c.id),
  uploadColor: COLOR_PRESETS.map((c) => c.id),
  menubarIcon: ["bars", "arrows", "logo", "none"],
  menubarValue: ["download", "upload", "both", "total-download", "total-upload", "net-total"],
  autoUpdates: [true, false],
  updateFrequency: ["daily", "weekly", "monthly"],
};

/** keep only known keys with valid values, so stored or incoming junk can't leak in */
export function pickSettings(input: unknown): Partial<Settings> {
  const picked: Record<string, unknown> = {};
  if (typeof input !== "object" || input === null) return picked as Partial<Settings>;
  for (const key of Object.keys(allowed) as (keyof typeof allowed)[]) {
    const value = (input as Record<string, unknown>)[key];
    if ((allowed[key] as readonly unknown[]).includes(value)) picked[key] = value;
  }
  const ignored = (input as Record<string, unknown>).ignoredApps;
  if (Array.isArray(ignored)) {
    picked.ignoredApps = [
      ...new Set(ignored.filter((n): n is string => typeof n === "string" && n.length <= 200)),
    ].slice(0, MAX_IGNORED);
  }
  return picked as Partial<Settings>;
}

export function colorHex(id: ColorId): string {
  return (COLOR_PRESETS.find((c) => c.id === id) ?? COLOR_PRESETS[0]).hex;
}
