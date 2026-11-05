// Per-app network usage since launch, grouped into real apps (.app bundles only).
// One `nettop` stream gives a cumulative per-process reading every second; deltas
// between readings are attributed to the app owning the pid. Icons come from
// NSWorkspace via JXA.

import type {
  AppEntry,
  DailyUsage,
  DayUsage,
  Period,
  Stats,
  TopApp,
  UsageRow,
} from "../shared/types";

// nettop block-buffers when stdout is a pipe, so it runs under a pty (`script`): each
// reading arrives as soon as it is printed (CRLF line ends, handled in onLine).
// nettop's stdin is closed (`<&-`): with stdin at EOF it busy-loops at 100%+ CPU, and
// EOF is what it would get, since `script` forwards the app's /dev/null stdin into the
// pty as ^D. A pipe held open would do too, but `script` refuses the socketpair that
// tjs.spawn's `stdin: "pipe"` is, and macOS FIFOs are socket-backed as well.
const STREAM_ARGS = [
  "script",
  "-q",
  "/dev/null",
  "sh",
  "-c",
  "exec nettop -P -s 1 -L 0 -t external -J bytes_in,bytes_out -x <&-",
];
const NAMES_REFRESH_MS = 2000;
const ICON_PX = 64;

// JXA: render an app's NSWorkspace icon to a PNG (args: bundle path, out path, px)
const ICON_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const [path, out] = argv;
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(path);
  const size = Number(argv[2]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    $(), size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  png.writeToFileAtomically(out, true);
}
`;

// macOS "responsible process": the app a process works on behalf of, e.g. the
// terminal behind a shell, `claude` or `curl` (even through tmux), or Safari behind
// its WebKit helpers. Private libSystem call, so fall back to the executable path.
let responsiblePid: ((pid: number) => number) | null = null;
try {
  const { CFunction, Lib, types } = await import("tjs:ffi");
  const fn = new CFunction(
    new Lib(Lib.LIBC_NAME).symbol("responsibility_get_pid_responsible_for_pid"),
    types.sint,
    [types.sint],
  );
  responsiblePid = (pid) => fn.call(pid) as number;
} catch (err) {
  console.error("tor apps: responsible-pid lookup unavailable:", err);
}

async function run(args: string[]): Promise<string> {
  const proc = tjs.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const text = await proc.stdout!.text();
  await proc.wait();
  return text;
}

// Outermost .app of an executable path — null for daemons, CLIs and system internals
interface AppRef {
  name: string;
  bundle: string;
}

function appOf(path: string): AppRef | null {
  if (path.startsWith("/System/Library/")) return null;
  const m = path.match(/^(.*?\/([^/]+)\.app)(?:\/|$)/);
  return m ? { name: m[2], bundle: m[1] } : null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const PERIOD_DAYS: Record<Period, number> = { today: 1, "7d": 7, "30d": 30 };
const KEEP_DAYS = 90;

// local calendar day, e.g. "2026-11-04"
function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface AppTracker {
  /** `period` may also be a count of days */
  top(n: number, period?: Period | number): TopApp[];
  /** rows changed since the last call (absolute totals), or null; + the cutoff to prune */
  takeDirty(): { rows: UsageRow[]; pruneBefore: string } | null;
  /** the last `range` days: daily totals, overall totals, and the usual suspects */
  stats(range?: number): Stats;
  stop(): void;
}

/**
 * @param tempDir scratch dir for icon PNGs
 * @param saved per-day, per-app totals from an earlier run (the 7d / 30d history)
 */
export async function createAppTracker(
  tempDir: string,
  saved: DailyUsage = {},
): Promise<AppTracker> {
  const daily = saved;
  const touched = new Set<string>(); // "day|app" rows changed since the last save
  const iconDir = await tjs.makeTempDir(`${tempDir}/tor-appicons-XXXXXX`);
  const iconScript = `${iconDir}/icon.jxa.js`;
  await tjs.writeFile(iconScript, ICON_SCRIPT);
  const pids = new Map<string, AppRef | null>(); // pid → { name, bundle } | null (not an app)
  const last = new Map<string, { in: number; out: number }>(); // pid → { in, out } cumulative at the previous reading
  const pending = new Map<string, { down: number; up: number }>(); // pid → bytes seen before its app was known
  const icons = new Map<string, string | null>(); // app name → data URL | null while loading
  const primeUntil = Date.now() + 1600; // readings before this only set baselines
  const procs: ReturnType<typeof tjs.spawn>[] = [];
  let refreshing: Promise<void> | null = null;
  let stopped = false;

  function refreshPids(): Promise<void> {
    refreshing ??= (async () => {
      const paths = new Map<string, string>();
      for (const line of (await run(["ps", "-axo", "pid=,comm="])).split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        if (m) paths.set(m[1], m[2]);
      }
      const next = new Map<string, AppRef | null>();
      for (const [pid, path] of paths) {
        const owner = responsiblePid?.(Number(pid)) ?? 0;
        const ownerPath = owner > 0 ? paths.get(String(owner)) : undefined;
        next.set(pid, (ownerPath && appOf(ownerPath)) || appOf(path));
      }
      pids.clear();
      for (const [pid, app] of next) pids.set(pid, app);
      for (const [pid, bytes] of pending) {
        const app = pids.get(pid);
        if (app) add(app, bytes.down, bytes.up);
      }
      pending.clear();
    })()
      .catch((err) => console.error("tor apps ps:", err))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  function loadIcon(app: AppRef): void {
    if (icons.has(app.name)) return;
    icons.set(app.name, null);
    const out = `${iconDir}/${app.name.replace(/[^\w-]+/g, "_")}.png`;
    run(["osascript", "-l", "JavaScript", iconScript, app.bundle, out, String(ICON_PX)])
      .then(() => tjs.readFile(out))
      .then((bytes) => icons.set(app.name, `data:image/png;base64,${toBase64(bytes)}`))
      .catch(() => icons.delete(app.name)); // retried the next time the app shows traffic
  }

  function add(app: AppRef, down: number, up: number): void {
    const today = (daily[dayKey(new Date())] ??= {});
    const entry = (today[app.name] ??= { down: 0, up: 0, bundle: app.bundle });
    entry.down += down;
    entry.up += up;
    touched.add(`${dayKey(new Date())}|${app.name}`);
    loadIcon(app);
  }

  // sum of the last `days` calendar days, today included
  function history(days: number): Map<string, AppEntry> {
    const totals = new Map<string, AppEntry>();
    for (let i = 0; i < days; i++) {
      const day = daily[dayKey(new Date(Date.now() - i * 86_400_000))];
      for (const [name, v] of Object.entries(day ?? {})) {
        const t = totals.get(name) ?? { down: 0, up: 0, bundle: v.bundle };
        t.down += v.down;
        t.up += v.up;
        totals.set(name, t);
      }
    }
    return totals;
  }

  function onLine(line: string): void {
    const [label, bytesIn, bytesOut] = line.replace(/\r$/, "").split(",");
    const dot = label ? label.lastIndexOf(".") : -1;
    if (dot < 0 || bytesOut === undefined) return; // header or blank
    const pid = label.slice(dot + 1);
    if (!/^\d+$/.test(pid)) return;
    const cur = { in: Number(bytesIn) || 0, out: Number(bytesOut) || 0 };
    const prev = last.get(pid);
    last.set(pid, cur);
    // a pid first seen after priming is a new process: all its bytes are new
    const base = prev ?? (Date.now() < primeUntil ? cur : { in: 0, out: 0 });
    const down = Math.max(0, cur.in - base.in);
    const up = Math.max(0, cur.out - base.out);
    if (!down && !up) return;
    if (!pids.has(pid)) {
      const p = pending.get(pid) ?? { down: 0, up: 0 };
      p.down += down;
      p.up += up;
      pending.set(pid, p);
      void refreshPids();
      return;
    }
    const app = pids.get(pid);
    if (app) add(app, down, up);
  }

  async function stream(): Promise<void> {
    try {
      await runStream();
    } finally {
      // nettop ended unexpectedly (it was killed, or the pty closed): start it again
      if (!stopped)
        setTimeout(() => stream().catch((err) => console.error("tor apps stream:", err)), 1000);
    }
  }

  async function runStream(): Promise<void> {
    const proc = tjs.spawn(STREAM_ARGS, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    procs.push(proc);
    const reader = proc.stdout!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  }

  function top(n: number, period: Period | number = "today"): TopApp[] {
    const source = history(typeof period === "number" ? period : (PERIOD_DAYS[period] ?? 1));
    for (const [name, v] of source) {
      if (!icons.has(name) && v.bundle) loadIcon({ name, bundle: v.bundle });
    }
    return [...source.entries()]
      .map(([name, v]) => ({ name, down: v.down, up: v.up, icon: icons.get(name) ?? null }))
      .sort((a, b) => b.down + b.up - (a.down + a.up))
      .slice(0, n);
  }

  await refreshPids();
  setInterval(() => void refreshPids(), NAMES_REFRESH_MS);
  stream().catch((err) => console.error("tor apps stream:", err));

  return {
    top,
    takeDirty() {
      if (!touched.size) return null;
      const rows = [...touched].map((key): UsageRow => {
        const [day, app] = key.split("|");
        const v = daily[day][app];
        return { day, app, down: v.down, up: v.up, bundle: v.bundle ?? "" };
      });
      touched.clear();
      const pruneBefore = dayKey(new Date(Date.now() - (KEEP_DAYS - 1) * 86_400_000));
      for (const day of Object.keys(daily)) if (day < pruneBefore) delete daily[day];
      return { rows, pruneBefore };
    },
    stats(range = 30) {
      const days: DayUsage[] = [];
      for (let i = range - 1; i >= 0; i--) {
        const day = dayKey(new Date(Date.now() - i * 86_400_000));
        let down = 0;
        let up = 0;
        for (const v of Object.values(daily[day] ?? {})) {
          down += v.down;
          up += v.up;
        }
        days.push({ day, down, up });
      }
      const totals = days.reduce((t, d) => ({ down: t.down + d.down, up: t.up + d.up }), {
        down: 0,
        up: 0,
      });
      const withData = days.filter((d) => d.down + d.up > 0);
      const busiest = withData.reduce<DayUsage | null>(
        (best, d) => (!best || d.down + d.up > best.down + best.up ? d : best),
        null,
      );
      const [topApp] = top(1, range);
      return {
        days,
        totals,
        busiest,
        topApp: topApp ?? null,
        // average over the days that actually recorded traffic
        avgPerDay: withData.length ? (totals.down + totals.up) / withData.length : 0,
      };
    },
    stop() {
      stopped = true;
      for (const p of procs) {
        try {
          p.kill();
        } catch {
          // already exited
        }
      }
    },
  };
}
