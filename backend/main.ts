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
  UpdateStatus,
} from "../shared/types";
import { createAppTracker, type AppTracker } from "./apps";
import { openUsageDb, type UsageDb } from "./db";
import { colorHex, type MenubarValue, type SpeedUnit } from "../shared/settings";
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

// -n: without it netstat reverse-resolves every interface address, which can take
// many seconds (or 30 s) behind a VPN's DNS, and the tick waits on it
async function readCounters(): Promise<{ rx: number; tx: number }> {
  const proc = tjs.spawn(["netstat", "-ibn"], { stdout: "pipe", stderr: "ignore" });
  const text = await proc.stdout!.text();
  await proc.wait();
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    // physical interfaces only (en0, en1, …), one <Link#n> row each
    if (!cols[0]?.startsWith("en") || !cols[2]?.startsWith("<Link#")) continue;
    // columns from the end: Ibytes Opkts Oerrs Obytes Coll
    rx += Number(cols[cols.length - 5]) || 0;
    tx += Number(cols[cols.length - 2]) || 0;
  }
  return { rx, tx };
}

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
  const today = appTracker?.stats(1).totals ?? { down: 0, up: 0 };
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
    bars: buckets(),
    values,
    arrows,
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
  const padded = Array.from({ length: HISTORY_S - history.length }, () => ({ down: 0, up: 0 }));
  padded.push(...history);
  return Array.from({ length: BUCKETS }, (_, i) =>
    padded
      .slice(i * BUCKET_S, (i + 1) * BUCKET_S)
      .reduce((acc, s) => ({ down: acc.down + s.down, up: acc.up + s.up }), { down: 0, up: 0 }),
  );
}

const PERIODS: Period[] = ["today", "7d", "30d"];
const STATS_RANGES: StatsRange[] = [7, 30, 90];
let appsPeriod: Period = "today"; // which top-apps tab the popover shows

export const api: Record<string, TinyApiHandler> = {
  // the page reports a blur (click outside); the panel hides itself like teneo's
  hidePopover: (_params, app) => {
    if (popoverOpen) hidePopover(app);
  },
  setAppsPeriod: ({ period }: { period: Period }) => {
    appsPeriod = PERIODS.includes(period) ? period : "today";
  },
  // the popover's Quit button
  quit: (_params, app) => quitTor(app),
  getSettings: () => getSettings(),
  updateSettings: async (changes: unknown, app) => {
    const next = await updateSettings(changes, app);
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
  installUpdate: (_params, app) =>
    installUpdate(app, (progress) => app.window(POPOVER.id).push("update-progress", progress)),
  getVersion: async (_params, app) => (await app.info()).version,
  // the page (re)loaded and lost its icon cache: send every icon again once
  resetIcons: () => iconsSent.clear(),
  // the page has applied what it was sent and rendered it (see togglePopover)
  popoverReady: () => {
    resolveReady?.();
  },
  getApps: ({ period }: { period: Period }) => topApps(PERIODS.includes(period) ? period : "today"),
  getStats: ({ days }: { days: StatsRange }) =>
    statsPayload(STATS_RANGES.includes(days) ? days : 30),
  // the page drew the menubar icon it was asked for (see setTray in init)
  setTrayIcon: ({ png }: { png: string }) => trayIcons?.set(png),
  // the page (re)loaded: it has drawn nothing yet, so ask it for the current icon
  trayIconReady: () => trayIcons?.reset(),
};

const POPOVER = { id: "popover", width: 380, height: 800 };
let appTracker: AppTracker | undefined;
// tell the popover when a background check changes the update status
const pushUpdateStatus = (app: TinyApp) => (status: UpdateStatus) =>
  app.window(POPOVER.id).push("update-status", status);

let repaintTray: (() => Promise<void>) | undefined;
let trayIcons: { set(png: string): Promise<void>; reset(): Promise<void> } | undefined;
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
const iconsSent = new Set<string>(); // icon data URLs are big: send each once per popover open

function topApps(period: Period = appsPeriod): AppsPayload {
  const apps = appTracker!.top(getSettings().topApps, period).map((a) => {
    if (!a.icon || iconsSent.has(a.name)) return { ...a, icon: undefined };
    iconsSent.add(a.name);
    return a;
  });
  return { period, apps };
}
// stats for the popover (7 / 30 / 90 days); the top app's icon is sent once like the list's
function statsPayload(days: StatsRange): Stats {
  const stats = appTracker!.stats(days);
  if (stats.topApp?.icon) {
    if (iconsSent.has(stats.topApp.name)) stats.topApp.icon = undefined;
    else iconsSent.add(stats.topApp.name);
  }
  return stats;
}

let latest: Traffic = { down: 0, up: 0 }; // bytes/s

// Offline (no primary interface, see network.ts, or asleep), nettop is stopped and the
// interface counters are read every OFFLINE_INTERVAL_MS instead of every second. Nothing
// is lost: nettop keeps its per-process baselines, so its first reading after resume is
// exactly the bytes moved in between, and the interface counters are cumulative. Real
// traffic while "offline" makes the app re-read the state, in case a notice was missed.
let online = true;
let network: NetworkWatcher | undefined;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let ticking = false;
let tick: () => Promise<void> = async () => {}; // set in init, once the counters are read

function setOnline(next: boolean, why: string): void {
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
  tickTimer = setTimeout(() => void tick(), delayMs);
}

// `history` holds one sample per second (buckets() counts on it), so a reading that
// spans several seconds (the offline interval, a wake from sleep) is spread over them
function record(down: number, up: number, secs: number, now: number): void {
  const n = Math.min(Math.max(1, Math.round(secs)), HISTORY_S);
  for (let i = n - 1; i >= 0; i--) history.push({ t: now - i * 1000, down: down / n, up: up / n });
  if (history.length > HISTORY_S) history.splice(0, history.length - HISTORY_S);
}

function snapshot(): Snapshot {
  return {
    rate: latest,
    today: appTracker?.stats(1).totals ?? { down: 0, up: 0 },
    series: series(),
  };
}

let popoverOpen = false;
let opening = false; // a click while the page is being prepared is ignored
let resolveReady: (() => void) | undefined;
// how long to wait for the page before showing the window anyway
const READY_TIMEOUT_MS = 1500;
let popoverFocused = false; // blur only counts after the window actually gained focus
let closedAt = 0; // a click on the tray icon blurs (hides) the popover first

function hidePopover(app: TinyApp): void {
  popoverOpen = false;
  popoverFocused = false;
  closedAt = Date.now();
  // go back to the home page while hidden, so reopening never shows the old page
  app.window(POPOVER.id).push("reset");
  app.window(POPOVER.id).hide({ app: false });
}

async function togglePopover(app: TinyApp): Promise<void> {
  if (popoverOpen) return hidePopover(app);
  if (Date.now() - closedAt < 250) return; // that click is what just closed it
  if (opening) return;
  opening = true;
  try {
    await openPopover(app);
  } finally {
    opening = false;
  }
}

async function openPopover(app: TinyApp): Promise<void> {
  const win = app.window(POPOVER.id);
  // Open on the display that was clicked. tray.position() reports one display's
  // icon only (the built-in one), so on another display fall back to the cursor.
  const [rect, mouse, screens] = await Promise.all([
    app.tray.position(),
    app.mousePosition(),
    app.screens(),
  ]);
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
  win.push("reset"); // also puts the page back on home, scrolled to the top
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ready,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, READY_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  resolveReady = undefined;
  popoverFocused = false;
  popoverOpen = true;
  win.show();
}

export async function init(app: TinyApp): Promise<void> {
  const tempDir = (await app.paths()).temp;
  const dir = await tjs.makeTempDir(`${tempDir}/tor-icon-XXXXXX`);
  await loadSettings(app);
  await loadUpdateState(app);
  let iconSeq = 0;
  let requestedIcon = ""; // iconKey of the icon last asked of the page
  const tray = { primaryAction: true, menu: [{ id: "quit", label: "Quit Tor" }], tooltip: "Tor" };
  app.tray.set({ ...tray, title: "Tor" }); // until the page has drawn the first icon

  // The page draws the icon (src/lib/trayIcon.ts) and sends it back as a PNG.
  async function setTray() {
    const options = trayOptions();
    const key = iconKey(options);
    if (key === requestedIcon) return; // that image is up, or on its way: nothing to draw
    requestedIcon = key;
    app.window(POPOVER.id).push("draw-tray-icon", options);
  }
  trayIcons = {
    async set(png) {
      const path = `${dir}/icon-${iconSeq++ % 2}.png`; // alternate names: no icon caching
      await tjs.writeFile(
        path,
        Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
      );
      app.tray.set({ ...tray, icon: path, template: false });
    },
    reset() {
      requestedIcon = "";
      return setTray();
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

  const usageDb = openUsageDb(`${(await app.paths()).data}/usage.db`);
  await importLegacyUsage(app, usageDb);
  const keepFrom = new Date(Date.now() - 89 * 86_400_000);
  online = await isOnline().catch(() => true); // no answer: assume online and count
  appTracker = await createAppTracker(tempDir, usageDb.load(localDay(keepFrom)), {
    paused: !online,
    isIgnored: (name) => getSettings().ignoredApps.includes(name),
  });
  // persist per-day app totals (7d / 30d history) every 30 s when they changed
  const flushUsage = (): void => {
    const dirty = appTracker!.takeDirty();
    if (dirty) usageDb.save(dirty.rows, dirty.pruneBefore);
  };
  setInterval(flushUsage, 30_000);
  flushUsageOnQuit = flushUsage;
  // top apps refresh every 500 ms while the popover is open
  setInterval(() => {
    if (popoverOpen) app.window(POPOVER.id).push("apps", topApps());
  }, 500);

  startCheckingForUpdates(app, pushUpdateStatus(app));

  let prev = await readCounters();
  let prevAt = Date.now();

  tick = async () => {
    if (ticking) return; // asked for while one runs: that one reschedules when it ends
    ticking = true;
    try {
      const cur = await readCounters();
      const now = Date.now();
      const secs = Math.max((now - prevAt) / 1000, 0.001);
      // counters can reset (sleep/reboot): clamp negative deltas to 0
      const down = Math.max(0, cur.rx - prev.rx); // bytes since the previous reading
      const up = Math.max(0, cur.tx - prev.tx);
      prev = cur;
      prevAt = now;
      record(down, up, secs, now);
      latest = { down: down / secs, up: up / secs };
      if (!online && down + up > OFFLINE_REFRESH_BYTES) void network?.refresh();
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
  scheduleTick();
  network = watchNetwork((up) => setOnline(up, up ? "network up" : "network down"));
}

// Asleep nothing moves, so nettop stops. Awake, the state is read right away rather than
// waited for: a wired interface can keep its keys through sleep and never notify.
export function onSystem(kind: string): void {
  if (kind === "sleep") setOnline(false, "sleep");
  else if (kind === "wake") void network?.refresh();
}

function quitTor(app: TinyApp): void {
  flushUsageOnQuit?.();
  appTracker?.stop();
  network?.stop();
  app.quit();
}

export async function onTray(id: string | null, app: TinyApp): Promise<void> {
  if (id === "quit") {
    quitTor(app);
  } else if (id === null) void togglePopover(app);
}

// click outside the popover closes it
export function onWindowState(info: TinyWindowStateEvent, app: TinyApp): void {
  if (info.win !== POPOVER.id) return;
  if (info.focused) popoverFocused = true;
  else if (popoverFocused && popoverOpen) hidePopover(app);
}
