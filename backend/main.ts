// SPIKE: menubar usage icon (5 bars over 30 min + download rate, drawn in
// the theme font) and a popover opened from it, fed by `netstat -ib` deltas.
import type {
  AppsPayload,
  Period,
  SeriesPoint,
  Snapshot,
  Stats,
  StatsRange,
  Traffic,
  TopApp,
  UpdateStatus,
} from "../shared/types";
import { createAppTracker, type AppTracker } from "./apps";
import { counterDelta, readCounters } from "./counters";
import { openUsageDb, type UsageDb } from "./db";
import { colorHex, isIgnoredApp, type MenubarValue, type SpeedUnit } from "../shared/settings";
import { iconKey, type IconOptions, type Value } from "../shared/trayIcon";
import { isOnline, watchNetwork, type NetworkWatcher } from "./network";
import { getSettings, loadSettings, updateSettings } from "./settings";
import {
  checkForUpdates,
  getUpdateStatus,
  installUpdate,
  loadUpdateState,
  startCheckingForUpdates,
} from "./updates";

const INTERVAL_MS = 1000;
const OFFLINE_INTERVAL_MS = 10_000; // offline, the counters are read now and then for the totals
// an interface with no route still moves a few bytes a second (mDNS, neighbor discovery);
// more than this in one offline interval is worth a look at the network state
const OFFLINE_REFRESH_BYTES = 100_000;
const BUCKETS = 5;
const BUCKET_S = 360; // 5 × 6 min = 30 min
const HISTORY_S = BUCKETS * BUCKET_S;
interface Sample extends Traffic {
  t: number; // ms timestamp
}
const history: Sample[] = []; // per-second { down, up } in bytes, newest last

const RATE_UNITS: Record<SpeedUnit, string[]> = {
  MBps: ["KB/s", "MB/s", "GB/s"],
  Mbps: ["Kbps", "Mbps", "Gbps"],
};
const TOTAL_UNITS = ["KB", "MB", "GB", "TB"];

// → { num, unit } with a fixed shape: 3 significant digits. `value` is in the first unit.
function scaled(value: number, units: string[]): Value {
  let i = 0;
  while (value >= 999.5 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  let num: string;
  if (value < 9.995) num = value.toFixed(2); // 1.23
  else if (value < 99.95) num = value.toFixed(1); // 12.3
  else num = Math.round(value).toString(); // 123
  return { num, unit: units[i] };
}

const rateValue = (bytesPerSec: number, unit: SpeedUnit): Value =>
  scaled((unit === "Mbps" ? bytesPerSec * 8 : bytesPerSec) / 1000, RATE_UNITS[unit]);
const totalValue = (bytes: number): Value => scaled(bytes / 1000, TOTAL_UNITS);

// what the menubar icon shows right now, from the settings and the live numbers
function trayOptions(): IconOptions {
  const settings = getSettings();
  const today = settings.menubarValue.includes("total")
    ? (appTracker?.todayTotals() ?? { down: 0, up: 0 })
    : { down: 0, up: 0 };
  const rate = (n: number): Value => rateValue(n, settings.unit);
  const shown: Record<
    MenubarValue,
    { values: Value[]; arrows: ("down" | "up")[]; totals: boolean }
  > = {
    download: { values: [rate(latest.down)], arrows: ["down"], totals: false },
    upload: { values: [rate(latest.up)], arrows: ["up"], totals: false },
    both: { values: [rate(latest.up), rate(latest.down)], arrows: ["up", "down"], totals: false },
    "total-download": { values: [totalValue(today.down)], arrows: ["down"], totals: true },
    "total-upload": { values: [totalValue(today.up)], arrows: ["up"], totals: true },
    "net-total": {
      values: [totalValue(today.down + today.up)],
      arrows: ["up", "down"],
      totals: true,
    },
  };
  const { values, arrows, totals } = shown[settings.menubarValue];
  return {
    icon: settings.menubarIcon,
    values,
    arrows,
    // the bars are thrown away unless the menubar actually draws them
    bars: settings.menubarIcon === "bars" ? buckets() : [],
    units: totals ? TOTAL_UNITS : RATE_UNITS[settings.unit],
    colors: { down: colorHex(settings.downloadColor), up: colorHex(settings.uploadColor) },
    offline: !online,
  };
}

// Popover graph: the last 5 minutes as SERIES_BARS clock-aligned buckets of
// SERIES_STEP_S seconds (so bars only shift when a bucket rolls over and the
// newest one fills live). Each bucket is its samples' average rate in bytes/s;
// `id` is stable per bucket so the page can animate bars sliding left.
const SERIES_BARS = 60;
const SERIES_STEP_S = 5;
function series(): SeriesPoint[] {
  const current = Math.floor(Date.now() / 1000 / SERIES_STEP_S);
  const first = current - SERIES_BARS + 1;
  const sums = new Map<number, Traffic & { n: number }>();
  for (const s of history) {
    const id = Math.floor(s.t / 1000 / SERIES_STEP_S);
    if (id < first) continue;
    const b = sums.get(id) ?? { down: 0, up: 0, n: 0 };
    b.down += s.down;
    b.up += s.up;
    b.n++;
    sums.set(id, b);
  }
  return Array.from({ length: SERIES_BARS }, (_, i) => {
    const id = first + i;
    const b = sums.get(id);
    return { id, down: b ? b.down / b.n : 0, up: b ? b.up / b.n : 0 };
  });
}

// Total bytes per bucket, oldest → newest; the newest bar always ends "now".
function buckets(): Traffic[] {
  const totals = Array.from({ length: BUCKETS }, () => ({ down: 0, up: 0 }));
  const now = Date.now();
  for (const s of history) {
    const slot = BUCKETS - 1 - Math.floor((now - s.t) / (BUCKET_S * 1000));
    if (slot < 0 || slot >= BUCKETS) continue;
    totals[slot].down += s.down;
    totals[slot].up += s.up;
  }
  return totals;
}

const PERIODS: Period[] = ["today", "7d", "30d"];
const STATS_RANGES: StatsRange[] = [7, 30, 90];
let appsPeriod: Period = "today"; // which Connections tab the popover shows

// page parameters are untrusted and may be missing altogether
const param = (params: unknown, key: string): unknown =>
  params && typeof params === "object" ? (params as Record<string, unknown>)[key] : undefined;
const periodParam = (params: unknown): Period => {
  const period = param(params, "period");
  return PERIODS.includes(period as Period) ? (period as Period) : "today";
};

export const api: Record<string, TinyApiHandler> = {
  openExternalLink: (params: unknown, app) => {
    if (!params || typeof params !== "object" || !("url" in params)) return;
    if (typeof params.url !== "string" || params.url.length > 4096) return;
    let url: URL;
    try {
      url = new URL(params.url);
    } catch {
      return;
    }
    if (url.protocol === "https:" && !url.username && !url.password)
      return app.shell.open(url.href);
  },
  // the page reports a blur (click outside); the panel hides itself like teneo's
  hidePopover: (_params, app) => {
    if (popoverOpen || opening) hidePopover(app);
  },
  setPage: (params: unknown) => {
    popoverPage = param(params, "page") === "home" ? "home" : "other";
  },
  setAppsPeriod: (params: unknown) => {
    appsPeriod = periodParam(params);
  },
  // the popover's Quit button
  quit: (_params, app) => quitTor(app),
  getSettings: () => getSettings(),
  updateSettings: async (changes: unknown, app) => {
    const next = await updateSettings(changes, app);
    appTracker?.invalidate(); // the hidden apps may have changed, and the sums leave them out
    void repaintTray?.(); // unit, colors and the menubar options all change the icon
    // hiding or showing an app changes the list and the totals at once
    if (popoverOpen && appTracker) {
      app.window(POPOVER.id).push("apps", topApps());
      app.window(POPOVER.id).push("stats", snapshot());
    }
    return next;
  },
  getUpdateStatus: () => getUpdateStatus(),
  checkForUpdates: (_params, app) => checkForUpdates(app, true, pushUpdateStatus(app)),
  installUpdate: async (_params, app) => {
    const installed = await installUpdate(app, (progress) =>
      app.window(POPOVER.id).push("update-progress", progress),
    );
    // the new version is already starting and tinyjs quits this one in 250 ms:
    // save what the download itself used and clean up, as Quit would
    if (installed) await shutdown(app);
  },
  getVersion: async (_params, app) => (await app.info()).version,
  // the hidden apps with their icons, for the settings page
  getIgnoredApps: (): TopApp[] => {
    return getSettings().ignoredApps.map((entry) => ({
      name: entry.name,
      down: 0,
      up: 0,
      bundle: entry.bundle,
      icon: appTracker?.icon(entry) ?? null,
    }));
  },
  // the page (re)loaded and lost its icon cache: send every icon again once
  resetIcons: () => iconsSent.clear(),
  cacheIcons: (params: unknown) => {
    if (!Array.isArray(params) || params.length > 40) return;
    for (const entry of params) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0].length > 4096) continue;
      if (!Number.isSafeInteger(entry[1]) || entry[1] < 1) continue;
      if (iconsSent.size >= 512 && !iconsSent.has(entry[0])) {
        const first = iconsSent.keys().next();
        if (!first.done) iconsSent.delete(first.value);
      }
      iconsSent.set(entry[0], entry[1]);
    }
  },
  // the page has applied what it was sent and rendered it (see togglePopover)
  popoverReady: (params?: { generation?: number }) => {
    if (params?.generation === openGen) resolveReady?.();
  },
  getApps: (params: unknown) => topApps(periodParam(params)),
  getStats: (params: unknown) => {
    const days = param(params, "days");
    return statsPayload(STATS_RANGES.includes(days as StatsRange) ? (days as StatsRange) : 30);
  },
  // the page drew the menubar icon it was asked for (see setTray in init)
  setTrayIcon: (params?: { png?: unknown; token?: number }) => {
    if (typeof params?.token !== "number") return;
    return trayIcons?.set(params.png, params.token);
  },
  // the page (re)loaded: it has drawn nothing yet, so ask it for the current icon
  trayIconReady: () => trayIcons?.reset(),
};

const POPOVER = { id: "popover", width: 380, height: 800 };
let appTracker: AppTracker | undefined;
// tell the popover when a background check changes the update status
const pushUpdateStatus = (app: TinyApp) => (status: UpdateStatus) =>
  app.window(POPOVER.id).push("update-status", status);

let repaintTray: (() => Promise<void>) | undefined;
let trayIcons: { set(png: unknown, token: number): Promise<void>; reset(): void } | undefined;
let usageDb: UsageDb | undefined;
let iconTempDir = "";
let flushUsageOnQuit: (() => void) | undefined;

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// earlier builds kept the per-day totals in the key-value store: move them into SQLite once
async function importLegacyUsage(app: TinyApp, usageDb: UsageDb): Promise<void> {
  const legacy = (await app.store.get("appUsage")) as Record<
    string,
    Record<string, Traffic & { bundle?: string }>
  > | null;
  if (!legacy) return;
  const rows = Object.entries(legacy).flatMap(([day, apps]) =>
    Object.entries(apps).map(([name, v]) => ({ day, app: name, ...v, bundle: v.bundle ?? "" })),
  );
  usageDb.save(rows, "0000-00-00");
  await app.store.delete("appUsage");
}
// Problems that make the counts incomplete go to a short log in the app's logs folder:
// a menubar app has no console anyone reads. Capped, so it cannot grow without end.
const LOG_LINES = 200;
let logChain: Promise<void> = Promise.resolve();
function appendLog(path: string, message: string): void {
  const line = message.replace(/[\r\n]+/g, " ").slice(0, 500);
  console.error(`tor: ${line}`);
  // one write at a time: overlapping read-modify-writes drop lines
  logChain = logChain.then(async () => {
    try {
      const old = await tjs.readFile(path).then(
        (bytes) => new TextDecoder().decode(bytes),
        () => "", // no log yet
      );
      const lines = `${old}${new Date().toISOString()} ${line}\n`.split("\n").filter(Boolean);
      await tjs.writeFile(path, `${lines.slice(-LOG_LINES).join("\n")}\n`);
    } catch {
      // the log is a courtesy: never let it break the app
    }
  });
}

// Only the page can confirm it got an icon; a push before its listener runs
// must not suppress the next copy.
const iconsSent = new Map<string, number>();
const withUncachedIcon = (app: TopApp): TopApp =>
  app.iconRevision && iconsSent.get(app.bundle || app.name) === app.iconRevision
    ? { ...app, icon: undefined }
    : app;

function topApps(period: Period = appsPeriod): AppsPayload {
  const apps = (appTracker?.top(getSettings().topApps, period) ?? []).map(withUncachedIcon);
  return { period, apps };
}
// stats can be queried as soon as the hidden page mounts, while the tracker is loading
function statsPayload(days: StatsRange): Stats {
  const stats = appTracker?.stats(days);
  if (!stats)
    return { days: [], totals: { down: 0, up: 0 }, busiest: null, topApp: null, avgPerDay: 0 };
  return { ...stats, topApp: stats.topApp ? withUncachedIcon(stats.topApp) : null };
}

let latest: Traffic = { down: 0, up: 0 }; // bytes/s

// Offline (no primary interface, see network.ts, or asleep), nettop is stopped and the
// interface counters are read every OFFLINE_INTERVAL_MS instead of every second. Nothing
// is lost: nettop keeps its per-process baselines, so its first reading after resume is
// exactly the bytes moved in between, and the interface counters are cumulative. Real
// traffic while "offline" makes the app re-read the state, in case a notice was missed.
let online = true;
let asleep = false;
let counterEpoch = 0; // an interface read begun before sleep is stale after wake
let quitting = false;
let network: NetworkWatcher | undefined;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let ticking = false;
let tick: () => Promise<void> = async () => {}; // set in init, once the counters are read

function setOnline(next: boolean, why: string): void {
  if (quitting) return;
  next &&= !asleep;
  if (next === online) return;
  online = next;
  console.log(`tor: ${next ? "online" : "offline"} (${why})`);
  if (next) {
    appTracker?.resume();
    scheduleTick(0); // catch up now rather than at the end of the offline interval
  } else appTracker?.pause();
  void repaintTray?.(); // the icon shows a red dot while offline
}

function scheduleTick(delayMs = online ? INTERVAL_MS : OFFLINE_INTERVAL_MS): void {
  clearTimeout(tickTimer);
  if (!asleep && !quitting) tickTimer = setTimeout(() => void tick(), delayMs);
}

// `history` holds one sample per second (buckets() counts on it), so a reading that
// spans several seconds (the offline interval, a wake from sleep) is spread over them
function record(down: number, up: number, secs: number, now: number): void {
  // a 10 s offline poll is spread so the chart doesn't spike; a sleep of
  // minutes must not paint that blip across the whole half hour
  const n = secs > 30 ? 1 : Math.min(Math.max(1, Math.round(secs)), 10);
  for (let i = n - 1; i >= 0; i--) history.push({ t: now - i * 1000, down: down / n, up: up / n });
  if (history.length > HISTORY_S) history.splice(0, history.length - HISTORY_S);
}

function snapshot(): Snapshot {
  return {
    rate: latest,
    today: appTracker?.todayTotals() ?? { down: 0, up: 0 },
    series: series(),
  };
}

let popoverOpen = false;
let opening = false; // a click while the page is being prepared cancels it
let popoverPage = "home"; // only the home page needs the live app list
let openGen = 0; // a ready event from the previous open must not resolve this one
let shownAt = 0;
let resolveReady: (() => void) | undefined;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PNG_B64 = 400_000;
function decodePng(png: unknown): Uint8Array | null {
  if (typeof png !== "string" || png.length === 0 || png.length > MAX_PNG_B64) return null;
  let bin: string;
  try {
    bin = atob(png);
  } catch {
    return null;
  }
  if (bin.length < 33 || bin.length > 256_000 || bin.slice(12, 16) !== "IHDR") return null;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (!PNG_MAGIC.every((b, i) => out[i] === b)) return null;
  const header = new DataView(out.buffer);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (header.getUint32(8) !== 13 || width === 0 || width > 512 || height === 0 || height > 128)
    return null;
  return out;
}
// how long to wait for the page before showing the window anyway
const READY_TIMEOUT_MS = 1500;
let popoverFocused = false; // blur only counts after the window actually gained focus
let closedAt = 0; // a click on the tray icon blurs (hides) the popover first

function hidePopover(app: TinyApp): void {
  openGen++; // the in-flight open sees this and does not show
  resolveReady?.();
  resolveReady = undefined;
  popoverOpen = false;
  opening = false;
  popoverFocused = false;
  closedAt = Date.now();
  // go back to the home page while hidden, so reopening never shows the old page
  app.window(POPOVER.id).push("reset");
  app.window(POPOVER.id).hide({ app: false });
}

async function togglePopover(app: TinyApp): Promise<void> {
  if (quitting || !appTracker) return;
  if (popoverOpen || opening) return hidePopover(app);
  if (Date.now() - closedAt < 250) return; // that click is what just closed it
  opening = true;
  const gen = ++openGen;
  try {
    await openPopover(app, gen);
  } finally {
    if (gen === openGen) opening = false;
  }
}

async function openPopover(app: TinyApp, gen: number): Promise<void> {
  const win = app.window(POPOVER.id);
  // Open on the display that was clicked. tray.position() reports one display's
  // icon only (the built-in one), so on another display fall back to the cursor.
  const [rect, mouse, screens] = await Promise.all([
    app.tray.position(),
    app.mousePosition(),
    app.screens(),
  ]);
  if (gen !== openGen || quitting || !screens.length) return;
  const screen = screens.find((s) => s.id === mouse.screen.id) ?? screens[0];
  const rectOnScreen =
    rect &&
    rect.x >= screen.x &&
    rect.x < screen.x + screen.width &&
    rect.y >= screen.y &&
    rect.y < screen.y + screen.height;
  const centerX = rectOnScreen ? rect.x + rect.width / 2 : mouse.x;
  const minX = screen.x + 8;
  const maxX = screen.x + screen.width - POPOVER.width - 8;
  const x = Math.max(minX, Math.min(Math.round(centerX - POPOVER.width / 2), maxX));
  const y = rectOnScreen ? Math.round(rect.y + rect.height + 4) : screen.visible.y + 4;
  win.setPosition(x, y);
  // A hidden webview is throttled and can lag, so show it only once the page says it has
  // applied the data and rendered it. "reset" goes last: the page answers when it is done.
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  win.push("stats", snapshot());
  win.push("apps", topApps());
  win.push("reset", { generation: gen });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ready,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, READY_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (gen !== openGen) return; // hidden again while the page was getting ready
  resolveReady = undefined;
  popoverFocused = false;
  popoverOpen = true;
  shownAt = Date.now();
  win.show();
}

export async function init(app: TinyApp): Promise<void> {
  const tempDir = (await app.paths()).temp;
  const dir = await tjs.makeTempDir(`${tempDir}/tor-icon-XXXXXX`);
  iconTempDir = dir;
  await loadSettings(app);
  await loadUpdateState(app);
  let iconSeq = 0;
  let iconToken = 0;
  let rendererReady = false;
  let displayedKey = "";
  let desired: { options: IconOptions; key: string } | undefined;
  let inFlight: { token: number; key: string; writing?: true } | undefined;
  const writtenIcons: string[] = [];
  const tray = { primaryAction: true, menu: [{ id: "quit", label: "Quit Tor" }], tooltip: "Tor" };
  app.tray.set({ ...tray, title: "Tor" }); // until the page has drawn the first icon

  // The page draws the icon (src/lib/trayIcon.ts) and sends it back as a PNG.
  function dispatchTray(): void {
    if (quitting || !rendererReady || !desired || inFlight || displayedKey === desired.key) return;
    inFlight = { token: ++iconToken, key: desired.key };
    app.window(POPOVER.id).push("draw-tray-icon", { ...desired.options, token: inFlight.token });
  }
  async function setTray() {
    const options = trayOptions();
    desired = { options, key: iconKey(options) };
    dispatchTray();
  }
  trayIcons = {
    async set(png, token) {
      const job = inFlight;
      if (!job || token !== job.token || job.writing || quitting) return;
      job.writing = true;
      try {
        const bytes = decodePng(png);
        if (!bytes) return;
        const path = `${dir}/icon-${iconSeq++}.png`;
        await tjs.writeFile(path, bytes);
        if (job !== inFlight || quitting) {
          await tjs.remove(path).catch(() => {});
          return;
        }
        // Always display a completed frame, even if the desired rate has
        // changed. Keep only the newest desired frame behind this one.
        app.tray.set({ ...tray, icon: path, template: false });
        displayedKey = job.key;
        writtenIcons.push(path);
        if (writtenIcons.length > 3) tjs.remove(writtenIcons.shift()!).catch(() => {});
      } catch (err) {
        console.error("tor tray:", err);
      } finally {
        if (job === inFlight) {
          inFlight = undefined;
          if (desired?.key !== job.key) dispatchTray();
        }
      }
    },
    reset() {
      rendererReady = true;
      inFlight = undefined;
      displayedKey = "";
      void setTray();
    },
  };
  repaintTray = setTray;

  app.win.open(POPOVER.id, {
    page: "index.html",
    title: "Tor",
    size: `${POPOVER.width}x${POPOVER.height}`,
    // same material as teneo's panel: "sheet" stays legible over light backgrounds
    chrome: {
      frame: false,
      windowControls: false,
      vibrancy: "sheet",
      transparent: true,
      panel: true, // non-activating: opening it doesn't steal focus from the frontmost app
    },
    show: false,
  });
  // open on the current Space, over full-screen apps too, instead of switching Spaces
  app.window(POPOVER.id).setAllSpaces(true);
  // stay above other apps' windows until hidden: a normal-level panel can drop behind the app that just took focus
  app.window(POPOVER.id).setLevel("floating");

  const db = openUsageDb(`${(await app.paths()).data}/usage.db`);
  usageDb = db;
  await importLegacyUsage(app, db);
  const keepFrom = new Date(Date.now() - 89 * 86_400_000);
  const initiallyOnline = await isOnline().catch(() => true);
  online = initiallyOnline && !asleep;
  const logFile = `${(await app.paths()).logs}/tor.log`;
  appTracker = await createAppTracker(tempDir, db.load(localDay(keepFrom)), {
    paused: !online,
    isIgnored: (name, bundle) => isIgnoredApp(getSettings().ignoredApps, name, bundle),
    iconDir: `${(await app.paths()).data}/icons`,
    onProblem: (message) => appendLog(logFile, message),
  });
  if (asleep) appTracker.pause();
  // persist per-day app totals (7d / 30d history) every 30 s when they changed
  const flushUsage = (): void => {
    try {
      appTracker?.flushDirty((rows, cutoff, removed) => db.save(rows, cutoff, removed));
    } catch (err) {
      appendLog(logFile, `could not save usage history: ${String(err)}`);
    }
  };
  setInterval(() => {
    if (!quitting) flushUsage();
  }, 30_000);
  flushUsageOnQuit = flushUsage;
  // Connections refresh every 500 ms while the home page is showing
  let lastFrame = "";
  setInterval(() => {
    if (!popoverOpen || popoverPage !== "home") {
      lastFrame = "";
      return;
    }
    const frame = topApps();
    const key = JSON.stringify([frame.period, frame.apps.map(({ icon: _icon, ...row }) => row)]);
    if (key === lastFrame && !frame.apps.some((a) => a.icon)) return;
    lastFrame = key;
    app.window(POPOVER.id).push("apps", frame);
  }, 500);

  startCheckingForUpdates(app, pushUpdateStatus(app));

  let prev: Awaited<ReturnType<typeof readCounters>> | null = null;
  let prevAt = Date.now();
  let prevEpoch = counterEpoch;
  let tunnelUntil = 0;

  tick = async () => {
    if (ticking || asleep || quitting) return;
    ticking = true;
    const epoch = counterEpoch;
    try {
      const cur = await readCounters();
      if (epoch !== counterEpoch || quitting) return;
      const now = Date.now();
      const secs = Math.max((now - prevAt) / 1000, 0.001);
      const baseline = prevEpoch === epoch ? prev : null;
      const { down, up, tunnel } = baseline
        ? counterDelta(baseline, cur)
        : { down: 0, up: 0, tunnel: 0 };
      prev = cur;
      prevAt = now;
      prevEpoch = epoch;
      if (baseline) record(down, up, secs, now);
      else tunnelUntil = 0;
      latest = { down: down / secs, up: up / secs };
      if (tunnel > 0) tunnelUntil = now + 30_000;
      appTracker?.setTunnelActive(now < tunnelUntil);
      // Power Nap keeps a primary interface. Don't resume nettop until wake.
      if (!online && !asleep && down + up > OFFLINE_REFRESH_BYTES) void network?.refresh();
      await setTray();
      // a hidden webview is throttled, so a push per second would pile up behind it and
      // delay the next open: send only while the popover is showing (opening sends a fresh one)
      if (popoverOpen) app.window(POPOVER.id).push("stats", snapshot());
    } catch (err) {
      console.error("tor spike:", err);
    } finally {
      ticking = false;
      scheduleTick();
    }
  };
  scheduleTick(0);
  network = watchNetwork((up) => setOnline(up, up ? "network up" : "network down"));
}

// Asleep nothing moves, so nettop stops. Awake, the state is read right away rather than
// waited for: a wired interface can keep its keys through sleep and never notify.
export function onSystem(kind: string): void {
  if (kind === "sleep" && !asleep) {
    asleep = true;
    counterEpoch++;
    latest = { down: 0, up: 0 };
    clearTimeout(tickTimer);
    setOnline(false, "sleep");
  } else if (kind === "wake" && asleep) {
    asleep = false;
    scheduleTick(0);
    void network?.refresh();
  }
}

// stop everything and save the usage, before Quit or an update's relaunch
async function shutdown(app: TinyApp): Promise<void> {
  if (quitting) return;
  quitting = true;
  clearTimeout(tickTimer);
  hidePopover(app);
  network?.stop();
  try {
    flushUsageOnQuit?.();
    usageDb?.close();
  } finally {
    await Promise.allSettled([appTracker?.stop(), iconTempDir && tjs.remove(iconTempDir)]);
  }
}

async function quitTor(app: TinyApp): Promise<void> {
  try {
    await shutdown(app);
  } finally {
    app.quit();
  }
}

export async function onTray(id: string | null, app: TinyApp): Promise<void> {
  if (id === "quit") {
    await quitTor(app);
  } else if (id === null) void togglePopover(app);
}

// click outside the popover closes it
export function onWindowState(info: TinyWindowStateEvent, app: TinyApp): void {
  if (info.win !== POPOVER.id) return;
  if (info.focused) popoverFocused = true;
  // a panel that never receives focus still blurs when the user clicks away,
  // once the click that opened it has had a moment
  else if (popoverOpen && (popoverFocused || Date.now() - shownAt > 400)) hidePopover(app);
}
