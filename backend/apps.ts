// Per-app network usage, grouped by bundle or CLI service.
// One `nettop` stream gives a cumulative per-process reading every second; deltas
// between readings are attributed to the app owning the pid (see attribution.ts).
// Icons come from NSWorkspace via JXA, rendered to a local cache and sent as data URLs.

import type {
  AppEntry,
  DailyUsage,
  DayUsage,
  Period,
  Stats,
  TopApp,
  UsageRow,
} from "../shared/types";
import { isBundlePath } from "../shared/settings";
import {
  OTHER,
  createResolver,
  historicalApp,
  lookupError,
  readProcessTable,
  readSessionHosts,
  resolveAliases,
  type AppRef,
} from "./attribution";
import { createNettopParser, type ProcSample } from "./nettop";
import { run } from "./run";

// nettop block-buffers when stdout is a pipe, so it runs under a pty (`script`): each
// reading arrives as soon as it is printed (CRLF line ends, handled in onLine).
// nettop's stdin is closed (`<&-`): with stdin at EOF it busy-loops at 100%+ CPU, and
// EOF is what it would get, since `script` forwards the app's /dev/null stdin into the
// pty as ^D. A pipe held open would do too, but `script` refuses the socketpair that
// tjs.spawn's `stdin: "pipe"` is, and macOS FIFOs are socket-backed as well.
// Interface types are listed instead of `-t external`: VPN tunnels (utun, type
// "undefined") don't count as external, so with a VPN up every app's traffic vanished
// and only the VPN daemon's did show. Loopback and AWDL stay out.
// Socket mode (no -P): each process row is followed by its sockets with their
// interface, which is what tells a VPN's carrier socket apart (see endSample).
const OSASCRIPT = "/usr/bin/osascript";
// -P drops the per-socket lines. Socket mode is only worth it while a utun
// interface is moving bytes (VPN carrier subtraction); otherwise it is
// thousands of lines a second for the interpreter to split.
function streamArgs(sockets: boolean): string[] {
  const flags = sockets ? "" : "-P ";
  return [
    "/usr/bin/script",
    "-q",
    "/dev/null",
    "/bin/sh",
    "-c",
    `exec /usr/bin/nettop -n -s 1 -L 0 -t wifi -t wired -t expensive -t undefined ${flags}-J interface,bytes_in,bytes_out -x <&-`,
  ];
}
// Count a VPN's encrypted UDP carrier separately only when both the port and
// its volume match the active tunnel. This is a heuristic, not a VPN detector.
const TUNNEL_PORTS = new Set([51820, 1194, 1195, 1197, 1198, 500, 4500, 1701]);
const CARRIER_MIN_BYTES = 4096;
const CARRIER_MATCH = { low: 0.4, high: 1.6 };
const NAMES_REFRESH_MS = 10_000; // unknown pids refresh sooner; this only catches renames
// a burst of new processes (a build, a script) rescans at most this often: each scan
// lists every process and looks up all their paths
const UNKNOWN_REFRESH_MS = 2_000;
// nettop reports a process for a few more readings after it exits (its last bytes among
// them), so a pid that left `ps` keeps its app this long
const GONE_KEEP_MS = 15_000;
const ICON_PX = 64;
const ICON_RECHECK_MS = 10 * 60_000; // how often an app's bundle is looked at for a newer icon

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

const PERIOD_DAYS: Record<Period, number> = { today: 1, "7d": 7, "30d": 30 };
const KEEP_DAYS = 90;
const ACTIVE_WINDOW_MS = 2_500; // smooth out the one-second nettop sampling interval

// local calendar day, e.g. "2026-11-04"
function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return dayKey(date);
}

type Counts = { in: number; out: number };

export interface AppTracker {
  /** `period` may also be a count of days */
  top(n: number, period?: Period | number): TopApp[];
  /** stop nettop (offline, asleep); the per-process baselines are kept, so the first
   *  reading after resume() yields exactly the bytes moved in between */
  pause(): void;
  resume(): void;
  /** Writes changed rows and their prunes; failed writes leave rows dirty. */
  flushDirty(
    save: (
      rows: UsageRow[],
      pruneBefore: string,
      remove: { day: string; app: string; bundle: string }[],
    ) => void,
  ): void;
  /** the last `range` days: daily totals, overall totals, and the usual suspects */
  stats(range?: number): Stats;
  todayTotals(): { down: number; up: number };
  /** an app's icon (PNG path) when known; starts rendering it from its bundle otherwise */
  icon(app: AppRef): string | null;
  /** forget the cached sums (the hidden apps changed) */
  invalidate(): void;
  /** per-socket nettop only while a VPN tunnel is moving bytes */
  setTunnelActive(active: boolean): void;
  stop(): Promise<void>;
}

/**
 * @param tempDir scratch dir for the JXA scripts
 * @param saved per-day, per-app totals from an earlier run (the 7d / 30d history)
 * @param iconDir where icon PNGs are kept across launches
 * @param paused start without nettop (the Mac is offline); resume() starts it
 * @param isIgnored apps the user hid: still recorded, left out of top() and stats().
 *   A pinned bundle only hides that bundle, not another app with the same name.
 * @param onProblem told about anything that makes the counts incomplete (so it can be logged)
 */
export async function createAppTracker(
  tempDir: string,
  saved: DailyUsage = {},
  {
    paused = false,
    isIgnored = (_name: string, _bundle = ""): boolean => false,
    iconDir,
    onProblem = (_message: string): void => {},
  }: {
    paused?: boolean;
    isIgnored?: (name: string, bundle: string) => boolean;
    iconDir: string;
    onProblem?: (message: string) => void;
  },
): Promise<AppTracker> {
  if (lookupError) {
    onProblem(
      `responsible-process lookup unavailable (${lookupError}): some terminal traffic may appear under System & CLI`,
    );
  }
  const daily = saved;
  const touched = new Set<string>(); // "day\0id" rows changed since the last save
  const removed: { day: string; app: string; bundle: string }[] = []; // rows merged into another app
  let lastPrune = "";
  const scriptDir = await tjs.makeTempDir(`${tempDir}/tor-apps-XXXXXX`);
  const iconScript = `${scriptDir}/icon.jxa.js`;
  await tjs.writeFile(iconScript, ICON_SCRIPT);
  await tjs.makeDir(iconDir, { recursive: true });
  await resolveAliases(scriptDir);
  // History recorded under a helper's own bundle before its alias existed ("Herdr Core",
  // "Rex Server", Setapp's agent), under a row's earlier name ("opencode"), or under a
  // translocated copy, is folded into the app it stands for, so the list shows one entry
  for (const [day, apps] of Object.entries(daily)) {
    for (const [key, v] of Object.entries(apps)) {
      const previous = v.name || key;
      const app = historicalApp(previous, v.bundle);
      const id = app ? app.bundle || app.name : key;
      const display = app?.name ?? previous;
      v.name = display;
      if (key === id) {
        if (previous !== display) {
          touched.add(`${day}\0${id}`);
          removed.push({ day, app: previous, bundle: v.bundle });
        }
        continue;
      }
      const into = (apps[id] ??= { down: 0, up: 0, bundle: v.bundle, name: display });
      into.down += v.down;
      into.up += v.up;
      into.bundle = app ? app.bundle : v.bundle;
      into.name = display;
      delete apps[key];
      touched.add(`${day}\0${id}`);
      removed.push({ day, app: previous, bundle: v.bundle });
    }
  }
  const pids = new Map<string, AppRef | null>(); // pid → app | null (drop: extension or Apple system)
  const pidPath = new Map<string, string>(); // pid → vnode path last refresh, to spot reuse
  const gone = new Map<string, number>(); // pid → when it was last missing from ps
  const resolverState = {
    responsibleOf: new Map<string, { path: string; pid: number }>(),
    sessionApp: new Map<string, { app: AppRef; seen: number }>(),
  };
  const last = new Map<string, Counts>(); // pid → cumulative at the previous reading
  const lastSock = new Map<string, Map<string, Counts>>(); // pid → socket → cumulative at the previous reading
  const sampleSeen = new Map<string, number>();
  // bytes of pids not in the last process scan; `at` is when they last moved
  const pending = new Map<string, { down: number; up: number; since: number; at: number }>();
  const lastActivity = new Map<string, number>(); // app identity → when it last moved bytes
  const icons = new Map<string, { url: string; path: string; revision: number }>();
  let iconRevision = 0;
  const iconChecked = new Map<string, number>(); // identity → when its bundle was last looked at
  let proc: ReturnType<typeof tjs.spawn> | undefined; // the running nettop (via script)
  let restart: ReturnType<typeof setTimeout> | undefined;
  let streamSeq = 0; // which stream() is current: an older one ending must not restart
  let refreshing: Promise<void> | null = null;
  let again = false; // a pid showed up while a refresh was awaiting ps
  let lastScanAt = -Infinity;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let socketMode = false;

  function forgetPid(pid: string): void {
    forgetSample(pid);
    lastSock.delete(pid);
    resolverState.responsibleOf.delete(pid);
    pidPath.delete(pid);
  }

  function forgetSample(pid: string): void {
    last.delete(pid);
    sampleSeen.delete(pid);
  }

  function expireTraffic(now: number): void {
    for (const [pid, bytes] of pending) {
      if (now - bytes.since < GONE_KEEP_MS) continue;
      // The process was too short-lived for ps; the bytes still belong in totals.
      add(OTHER, bytes.down, bytes.up, bytes.at);
      pending.delete(pid);
    }
    for (const [pid, at] of sampleSeen)
      if (!pids.has(pid) && now - at >= GONE_KEEP_MS) forgetSample(pid);
    for (const [key, entry] of resolverState.sessionApp)
      if (now - entry.seen >= 10 * 60_000) resolverState.sessionApp.delete(key);
    for (const [id, at] of lastActivity) if (now - at >= ACTIVE_WINDOW_MS) lastActivity.delete(id);
  }

  function refreshPids(): Promise<void> {
    again = true;
    refreshing ??= (async () => {
      while (again && !stopped) {
        again = false;
        lastScanAt = Date.now();
        const table = await readProcessTable();
        const hosts = await readSessionHosts(table.paths);
        if (stopped) return;
        const resolve = createResolver(table, hosts, resolverState);
        const next = new Map<string, AppRef | null>();
        for (const [pid, path] of table.paths) {
          const known = pidPath.get(pid);
          if (gone.has(pid) || (known && path && known !== path)) forgetPid(pid);
          pidPath.set(pid, path);
          next.set(pid, resolve(pid));
        }
        // just exited: keep the app for the readings nettop still prints for it
        const now = Date.now();
        for (const [pid, app] of pids) {
          if (table.paths.has(pid)) continue;
          const since = gone.get(pid) ?? now;
          if (now - since < GONE_KEEP_MS) {
            gone.set(pid, since);
            next.set(pid, app);
          } else forgetPid(pid); // recycled pids must not inherit this baseline
        }
        for (const pid of gone.keys()) if (!next.has(pid) || table.paths.has(pid)) gone.delete(pid);
        for (const pid of resolverState.responsibleOf.keys())
          if (!next.has(pid)) resolverState.responsibleOf.delete(pid);
        pids.clear();
        for (const [pid, app] of next) pids.set(pid, app);
        for (const [pid, bytes] of pending) {
          if (!pids.has(pid)) continue; // showed up after ps: the next pass keeps it
          const app = pids.get(pid);
          if (app) add(app, bytes.down, bytes.up, bytes.at);
          pending.delete(pid);
        }
      } // again: a pid arrived while this pass was awaiting ps
    })()
      .catch((err) => console.error("tor apps ps:", err))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  // a pid nettop reported that the last scan did not know: scan again, at once when
  // the last scan is old enough, else once UNKNOWN_REFRESH_MS has passed
  function refreshSoon(): void {
    if (scanTimer !== undefined || stopped) return;
    const wait = Math.max(0, lastScanAt + UNKNOWN_REFRESH_MS - Date.now());
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      void refreshPids();
    }, wait);
  }

  function identity(app: AppRef): string {
    return app.bundle || app.name;
  }

  // Each bundle keeps one cached PNG, named after its path and modification time.
  // Earlier ones (the app was updated since) are deleted once the current one loads.
  async function pruneIcons(prefix: string, keep: string): Promise<void> {
    const dir = await tjs.readDir(iconDir);
    try {
      for await (const entry of dir) {
        const path = `${iconDir}/${entry.name}`;
        if (entry.name.startsWith(prefix) && path !== keep) await tjs.remove(path).catch(() => {});
      }
    } finally {
      await dir.close();
    }
  }

  // Rendered once per app and kept across launches. The page gets a data URL,
  // so it does not need readAccess to the icon directory. A missing bundle is
  // remembered for ICON_RECHECK_MS instead of being statted on every poll.
  function loadIcon(app: AppRef): void {
    if (!isBundlePath(app.bundle)) return;
    const id = identity(app);
    const now = Date.now();
    const checked = iconChecked.get(id);
    if (checked !== undefined && now - checked < ICON_RECHECK_MS) return;
    iconChecked.set(id, now);
    void (async () => {
      const stat = await tjs.stat(app.bundle);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(app.bundle));
      const fingerprint = [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const out = `${iconDir}/${fingerprint}-${stat.mtim.getTime()}.png`;
      const known = icons.get(id);
      if (known?.path === out || stopped) return;
      const file = await tjs.stat(out).catch(() => null);
      if (!file)
        await run([OSASCRIPT, "-l", "JavaScript", iconScript, app.bundle, out, String(ICON_PX)]);
      if ((file ?? (await tjs.stat(out))).size > 96_000 || stopped) return;
      const bytes = await tjs.readFile(out);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      icons.set(id, {
        path: out,
        url: `data:image/png;base64,${btoa(binary)}`,
        revision: ++iconRevision,
      });
      await pruneIcons(`${fingerprint}-`, out);
    })().catch(() => {
      // Keep the old icon and retry only after ICON_RECHECK_MS.
    });
  }

  // Sums are read far more often than written (the tray repaints every second, the
  // popover polls twice a second), so each is computed once and kept until the next
  // add(), the day rolls over, or the hidden apps change (invalidate()).
  const sums = new Map<string, unknown>();
  let sumsDay = "";
  function cached<T>(key: string, compute: () => T): T {
    const today = dayKey(new Date());
    if (today !== sumsDay) {
      sums.clear();
      sumsDay = today;
    }
    if (sums.has(key)) return sums.get(key) as T;
    const value = compute();
    sums.set(key, value);
    return value;
  }

  /** `at`: when the bytes moved, for the activity dot (late-attributed bytes are old) */
  function add(app: AppRef, down: number, up: number, at = Date.now()): void {
    const id = identity(app);
    if ((down > 0 || up > 0) && at > (lastActivity.get(id) ?? -Infinity)) lastActivity.set(id, at);
    const day = dayKey(new Date());
    const today = (daily[day] ??= Object.create(null) as Record<string, AppEntry>);
    const entry = (today[id] ??= { down: 0, up: 0, bundle: app.bundle, name: app.name });
    entry.down += down;
    entry.up += up;
    entry.name = app.name;
    entry.bundle = app.bundle;
    touched.add(`${day}\0${id}`);
    sums.clear();
  }

  // sum of the last `days` calendar days, today included (shared: do not mutate)
  function history(days: number): Map<string, AppEntry> {
    return cached(`history:${days}`, () => sumHistory(days));
  }

  function sumHistory(days: number): Map<string, AppEntry> {
    const totals = new Map<string, AppEntry>();
    for (let i = 0; i < days; i++) {
      const day = daily[daysAgo(i)];
      for (const [name, v] of Object.entries(day ?? {})) {
        if (isIgnored(v.name || name, v.bundle)) continue;
        const t = totals.get(name) ?? { down: 0, up: 0, bundle: v.bundle, name: v.name };
        t.down += v.down;
        t.up += v.up;
        t.name = v.name || t.name;
        totals.set(name, t);
      }
    }
    return totals;
  }

  function totalsForDay(day: string): DayUsage {
    return cached(`day:${day}`, () => {
      let down = 0;
      let up = 0;
      for (const [id, v] of Object.entries(daily[day] ?? {})) {
        if (isIgnored(v.name || id, v.bundle)) continue;
        down += v.down;
        up += v.up;
      }
      return { day, down, up };
    });
  }

  function endSample(procs: ProcSample[], establish: boolean, sockets: boolean): void {
    const now = Date.now();
    expireTraffic(now);
    // first seen after priming: a new process/socket, all its bytes are new
    const delta = (prev: Counts | undefined, cur: Counts): { down: number; up: number } => {
      const base = prev ?? (establish ? cur : { in: 0, out: 0 });
      return { down: Math.max(0, cur.in - base.in), up: Math.max(0, cur.out - base.out) };
    };
    // pass 1: socket deltas; what the tunnels moved, and the UDP sockets that might carry it
    const seenPids = new Set<string>();
    let tunnel = 0;
    const udp: { proc: ProcSample; down: number; up: number; port: number }[] = [];
    const perProc = new Map<ProcSample, { down: number; up: number }>();
    for (const proc of procs) {
      sampleSeen.set(proc.pid, now);
      perProc.set(proc, delta(last.get(proc.pid), proc));
      last.set(proc.pid, proc);
      // a process-only sample has no sockets; wiping baselines here would
      // double-count them the next time socket mode starts
      if (!sockets) continue;
      seenPids.add(proc.pid);
      const before = lastSock.get(proc.pid);
      const after = new Map<string, Counts>();
      for (const sock of proc.sockets) {
        const d = delta(before?.get(sock.key), sock);
        after.set(sock.key, sock);
        if (!d.down && !d.up) continue;
        if (sock.iface.startsWith("utun")) tunnel += d.down + d.up;
        else if (sock.udp && sock.iface && !sock.iface.startsWith("lo")) {
          udp.push({ proc, ...d, port: sock.remotePort });
        }
      }
      lastSock.set(proc.pid, after);
    }
    if (sockets) for (const pid of lastSock.keys()) if (!seenPids.has(pid)) lastSock.delete(pid);
    // pass 2: a known tunnel port counts as the carrier only when it also
    // moves about as much as the tunnel. A quiet utun must not zero every
    // flow to those ports, and a QUIC flow must not match on size alone.
    if (tunnel >= CARRIER_MIN_BYTES) {
      for (const c of udp) {
        if (!TUNNEL_PORTS.has(c.port)) continue;
        const total = c.down + c.up;
        if (total < tunnel * CARRIER_MATCH.low || total > tunnel * CARRIER_MATCH.high) continue;
        const d = perProc.get(c.proc)!;
        d.down = Math.max(0, d.down - c.down);
        d.up = Math.max(0, d.up - c.up);
      }
    }
    // pass 3: attribute to apps
    for (const [proc, d] of perProc) {
      if (!d.down && !d.up) continue;
      if (!pids.has(proc.pid)) {
        const p = pending.get(proc.pid) ?? { down: 0, up: 0, since: now, at: now };
        p.down += d.down;
        p.up += d.up;
        p.at = now;
        pending.set(proc.pid, p);
        refreshSoon();
        continue;
      }
      const app = pids.get(proc.pid);
      if (app) add(app, d.down, d.up, now);
    }
  }

  function stream(): void {
    if (stopped || paused || proc) return;
    clearTimeout(restart);
    const id = ++streamSeq;
    runStream(socketMode)
      .catch((err) => console.error("tor apps stream:", err))
      .finally(() => {
        // nettop ended unexpectedly (it was killed, or the pty closed): start it again,
        // unless this is a pause or a stop, or a newer stream has already replaced it
        if (!stopped && !paused && id === streamSeq) restart = setTimeout(stream, 1000);
      });
  }

  async function runStream(sockets: boolean): Promise<void> {
    const p = tjs.spawn(streamArgs(sockets), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc = p;
    let priming = true;
    const feed = createNettopParser((sample) => {
      endSample(sample, priming, sockets);
      priming = false;
    });
    const reader = p.stdout!.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || proc !== p) break;
        feed(value);
      }
    } finally {
      reader.releaseLock();
      if (proc === p) proc = undefined;
    }
  }

  function killStream(): void {
    streamSeq++;
    clearTimeout(restart);
    const p = proc;
    proc = undefined;
    try {
      p?.kill();
    } catch {
      // already exited
    }
  }

  function top(n: number, period: Period | number = "today"): TopApp[] {
    const source = history(typeof period === "number" ? period : (PERIOD_DAYS[period] ?? 1));
    const now = Date.now();
    return [...source.entries()]
      .map(([id, v]) => {
        const icon = icons.get(v.bundle || id);
        const lastActive = lastActivity.get(v.bundle || id);
        return {
          name: v.name || id,
          bundle: v.bundle,
          down: v.down,
          up: v.up,
          active: lastActive !== undefined && now - lastActive < ACTIVE_WINDOW_MS,
          icon: icon?.url ?? null,
          iconRevision: icon?.revision,
        };
      })
      .sort((a, b) => b.down + b.up - (a.down + a.up))
      .slice(0, n)
      .map((a) => {
        if (a.bundle) loadIcon({ name: a.name, bundle: a.bundle });
        return a;
      });
  }

  await refreshPids();
  const pidTimer = setInterval(() => {
    if (!paused) {
      expireTraffic(Date.now());
      void refreshPids();
    }
  }, NAMES_REFRESH_MS);
  stream();

  return {
    top,
    pause() {
      if (paused) return;
      paused = true;
      killStream();
    },
    resume() {
      if (!paused) return;
      paused = false;
      void refreshPids().then(stream); // refresh attribution before the first frame
    },
    flushDirty(save) {
      const pruneBefore = daysAgo(KEEP_DAYS - 1);
      if (!touched.size && !removed.length && lastPrune === pruneBefore) return;
      const rows = [...touched].flatMap((key): UsageRow[] => {
        const cut = key.indexOf("\0");
        const day = key.slice(0, cut);
        const id = key.slice(cut + 1);
        const v = daily[day]?.[id];
        if (!v) return [];
        return [{ day, app: v.name || id, down: v.down, up: v.up, bundle: v.bundle ?? "" }];
      });
      save(rows, pruneBefore, [...removed]);
      touched.clear();
      removed.length = 0;
      lastPrune = pruneBefore;
      for (const day of Object.keys(daily)) if (day < pruneBefore) delete daily[day];
      sums.clear();
    },
    todayTotals: () => totalsForDay(dayKey(new Date())),
    stats(range = 30) {
      const days: DayUsage[] = [];
      for (let i = range - 1; i >= 0; i--) {
        days.push(totalsForDay(daysAgo(i)));
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
    icon(app) {
      if (app.bundle) {
        loadIcon(app);
        return icons.get(app.bundle)?.url ?? null;
      }
      for (const day of Object.values(daily)) {
        for (const [id, v] of Object.entries(day)) {
          if ((v.name || id) !== app.name || !v.bundle) continue;
          loadIcon({ name: app.name, bundle: v.bundle });
          return icons.get(v.bundle)?.url ?? null;
        }
      }
      return null;
    },
    invalidate() {
      sums.clear();
    },
    /** socket lines are only collected while a utun interface is moving bytes */
    setTunnelActive(active: boolean) {
      if (active === socketMode) return;
      socketMode = active;
      lastSock.clear(); // socket baselines from the other mode are not comparable
      if (stopped || paused) return;
      killStream();
      stream();
    },
    async stop() {
      stopped = true;
      clearInterval(pidTimer);
      clearTimeout(scanTimer);
      killStream();
      await tjs.remove(scriptDir).catch(() => {});
    },
  };
}
