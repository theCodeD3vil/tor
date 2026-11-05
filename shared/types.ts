// Types shared by the backend (backend/) and the popover page (src/).

export type Period = "today" | "7d" | "30d";
export type StatsRange = 7 | 30 | 90;

/** bytes (or bytes/s), downloaded and uploaded */
export interface Traffic {
  down: number;
  up: number;
}

/** one 5 s bucket of the live chart; `id` is stable so bars can animate sliding left */
export interface SeriesPoint extends Traffic {
  id: number;
}

/** pushed to the page every second as the "stats" event */
export interface Snapshot {
  rate: Traffic;
  /** everything transferred so far today (bytes) */
  today: Traffic;
  series: SeriesPoint[];
}

/** `icon` is a data URL; the backend sends each one only once, so it is often absent */
export interface TopApp extends Traffic {
  name: string;
  icon?: string | null;
}

/** pushed as the "apps" event and returned by getApps */
export interface AppsPayload {
  period: Period;
  apps: TopApp[];
}

/** one calendar day, `day` is local "YYYY-MM-DD" */
export interface DayUsage extends Traffic {
  day: string;
}

export interface Stats {
  days: DayUsage[];
  totals: Traffic;
  busiest: DayUsage | null;
  topApp: TopApp | null;
  /** average over the days that actually recorded traffic */
  avgPerDay: number;
}

/** day → app name → totals; what the SQLite history loads into memory */
export interface AppEntry extends Traffic {
  bundle: string;
}
export type DailyUsage = Record<string, Record<string, AppEntry>>;

/** one app_usage row */
export interface UsageRow extends Traffic {
  day: string;
  app: string;
  bundle: string;
}

/** where the app stands on updates; `lastChecked` is a ms timestamp */
export interface UpdateStatus {
  state: "idle" | "up-to-date" | "available" | "unsupported" | "error";
  current: string;
  latest: string | null;
  notes: string | null;
  lastChecked: number | null;
}

/** bytes received so far; `total` is null when the server sends no size */
export interface UpdateProgress {
  received: number;
  total: number | null;
}
