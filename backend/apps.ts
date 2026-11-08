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
// Interface types are listed instead of `-t external`: VPN tunnels (utun, type
// "undefined") don't count as external, so with a VPN up every app's traffic vanished
// and only the VPN daemon's did show. Loopback and AWDL stay out.
// Socket mode (no -P): each process row is followed by its sockets with their
// interface, which is what tells a VPN's carrier socket apart (see endSample).
const STREAM_ARGS = [
  "script",
  "-q",
  "/dev/null",
  "sh",
  "-c",
  "exec nettop -n -s 1 -L 0 -t wifi -t wired -t expensive -t undefined -J interface,bytes_in,bytes_out -x <&-",
];
// A VPN's carrier: the UDP socket on a real interface that moves the (encrypted) bytes
// the apps move on utun. Spotted by a well-known tunnel port, or by carrying about as
// much as all utun sockets together while the tunnel is busy; its bytes are taken off
// its process so that traffic is not counted twice. The tunnel must move at least
// CARRIER_MIN_BYTES in a sample before the size match applies, so that idle noise
// cannot mark a random UDP socket.
const TUNNEL_PORTS = new Set([51820, 1194, 1195, 1197, 1198, 500, 4500, 1701]);
const CARRIER_MIN_BYTES = 4096;
const CARRIER_MATCH = { low: 0.4, high: 1.6 };
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

// one process row of a nettop reading, with the sockets listed under it
interface ProcSample {
  pid: string;
  in: number;
  out: number;
  sockets: {
    key: string;
    iface: string;
    udp: boolean;
    remotePort: number;
    in: number;
    out: number;
  }[];
}

// Outermost .app of an executable path — null for daemons, CLIs and system internals
interface AppRef {
  name: string;
  bundle: string;
}

function appOf(path: string): AppRef | null {
  if (path.startsWith("/System/Library/")) return null;
  // Network Extensions (VPN tunnel providers, content filters) carry other apps'
  // traffic: counting them would count those bytes twice
  if (path.startsWith("/Library/SystemExtensions/") || /\.(appex|systemextension)\//.test(path)) {
    return null;
  }
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
  /** stop nettop (offline, asleep); the per-process baselines are kept, so the first
   *  reading after resume() yields exactly the bytes moved in between */
  pause(): void;
  resume(): void;
  /** rows changed since the last call (absolute totals), or null; + the cutoff to prune */
  takeDirty(): { rows: UsageRow[]; pruneBefore: string } | null;
  /** the last `range` days: daily totals, overall totals, and the usual suspects */
  stats(range?: number): Stats;
  stop(): void;
}

/**
 * @param tempDir scratch dir for icon PNGs
 * @param saved per-day, per-app totals from an earlier run (the 7d / 30d history)
 * @param paused start without nettop (the Mac is offline); resume() starts it
 * @param isIgnored apps the user hid: still recorded, left out of top() and stats()
 */
export async function createAppTracker(
  tempDir: string,
  saved: DailyUsage = {},
  {
    paused = false,
    isIgnored = (_name: string): boolean => false,
  }: { paused?: boolean; isIgnored?: (name: string) => boolean } = {},
): Promise<AppTracker> {
  const daily = saved;
  const touched = new Set<string>(); // "day|app" rows changed since the last save
  const iconDir = await tjs.makeTempDir(`${tempDir}/tor-appicons-XXXXXX`);
  const iconScript = `${iconDir}/icon.jxa.js`;
  await tjs.writeFile(iconScript, ICON_SCRIPT);
  const pids = new Map<string, AppRef | null>(); // pid → { name, bundle } | null (not an app)
  const last = new Map<string, { in: number; out: number }>(); // pid → { in, out } cumulative at the previous reading
  const lastSock = new Map<string, { in: number; out: number }>(); // "pid|socket" → cumulative at the previous reading
  let sample: ProcSample[] = []; // the reading being read (nettop prints one per second)
  const pending = new Map<string, { down: number; up: number }>(); // pid → bytes seen before its app was known
  const icons = new Map<string, string | null>(); // app name → data URL | null while loading
  const primeUntil = Date.now() + 1600; // readings before this only set baselines
  let proc: ReturnType<typeof tjs.spawn> | undefined; // the running nettop (via script)
  let streamSeq = 0; // which stream() is current: an older one ending must not restart
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
        if (isIgnored(name)) continue;
        const t = totals.get(name) ?? { down: 0, up: 0, bundle: v.bundle };
        t.down += v.down;
        t.up += v.up;
        totals.set(name, t);
      }
    }
    return totals;
  }

  // a nettop reading: header, then per process its row followed by its sockets
  //   ,interface,bytes_in,bytes_out,
  //   Safari.512,,123,45,
  //   tcp4 10.0.0.2:5000<->1.2.3.4:443,en0,100,40,
  function onLine(raw: string): void {
    const line = raw.replace(/\r$/, "");
    const [label, iface, bytesIn, bytesOut] = line.split(",");
    if (bytesOut === undefined) return; // blank
    if (label === "") {
      endSample(); // header: the previous reading is complete
      return;
    }
    const cur = { in: Number(bytesIn) || 0, out: Number(bytesOut) || 0 };
    const arrow = label.indexOf("<->");
    if (arrow < 0) {
      const dot = label.lastIndexOf(".");
      const pid = label.slice(dot + 1);
      if (dot < 0 || !/^\d+$/.test(pid)) return;
      sample.push({ pid, ...cur, sockets: [] });
      return;
    }
    const proc = sample[sample.length - 1];
    if (!proc) return; // a socket before any process row: cannot happen, ignore
    const remotePort = Number(label.slice(arrow + 3).match(/[.:](\d+)$/)?.[1]);
    proc.sockets.push({
      key: label,
      iface,
      udp: label.startsWith("udp"),
      remotePort: Number.isFinite(remotePort) ? remotePort : 0,
      ...cur,
    });
  }

  function endSample(): void {
    const procs = sample;
    sample = [];
    if (!procs.length) return;
    const priming = Date.now() < primeUntil;
    const delta = (
      map: Map<string, { in: number; out: number }>,
      key: string,
      cur: { in: number; out: number },
    ): { down: number; up: number } => {
      const prev = map.get(key);
      map.set(key, cur);
      // first seen after priming: a new process/socket, all its bytes are new
      const base = prev ?? (priming ? cur : { in: 0, out: 0 });
      return { down: Math.max(0, cur.in - base.in), up: Math.max(0, cur.out - base.out) };
    };
    // pass 1: socket deltas; what the tunnels moved, and the UDP sockets that might carry it
    const seen = new Set<string>();
    let tunnel = 0;
    const udp: { proc: ProcSample; down: number; up: number; port: number }[] = [];
    const perProc = new Map<ProcSample, { down: number; up: number }>();
    for (const proc of procs) {
      perProc.set(proc, delta(last, proc.pid, proc));
      for (const sock of proc.sockets) {
        const key = `${proc.pid}|${sock.key}`;
        seen.add(key);
        const d = delta(lastSock, key, sock);
        if (!d.down && !d.up) continue;
        if (sock.iface.startsWith("utun")) tunnel += d.down + d.up;
        else if (sock.udp && sock.iface && !sock.iface.startsWith("lo")) {
          udp.push({ proc, ...d, port: sock.remotePort });
        }
      }
    }
    for (const key of lastSock.keys()) if (!seen.has(key)) lastSock.delete(key); // closed
    // pass 2: take the carriers' bytes off their processes
    if (tunnel > 0) {
      for (const c of udp) {
        const total = c.down + c.up;
        const sized =
          tunnel >= CARRIER_MIN_BYTES &&
          total >= tunnel * CARRIER_MATCH.low &&
          total <= tunnel * CARRIER_MATCH.high;
        if (!TUNNEL_PORTS.has(c.port) && !sized) continue;
        const d = perProc.get(c.proc)!;
        d.down = Math.max(0, d.down - c.down);
        d.up = Math.max(0, d.up - c.up);
      }
    }
    // pass 3: attribute to apps
    for (const [proc, d] of perProc) {
      if (!d.down && !d.up) continue;
      if (!pids.has(proc.pid)) {
        const p = pending.get(proc.pid) ?? { down: 0, up: 0 };
        p.down += d.down;
        p.up += d.up;
        pending.set(proc.pid, p);
        void refreshPids();
        continue;
      }
      const app = pids.get(proc.pid);
      if (app) add(app, d.down, d.up);
    }
  }

  function stream(): void {
    if (stopped || paused) return;
    const id = ++streamSeq;
    runStream()
      .catch((err) => console.error("tor apps stream:", err))
      .finally(() => {
        // nettop ended unexpectedly (it was killed, or the pty closed): start it again,
        // unless this is a pause or a stop, or a newer stream has already replaced it
        if (!stopped && !paused && id === streamSeq) setTimeout(stream, 1000);
      });
  }

  async function runStream(): Promise<void> {
    const p = tjs.spawn(STREAM_ARGS, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    proc = p;
    const reader = p.stdout!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    if (proc === p) proc = undefined;
  }

  function killStream(): void {
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
    for (const [name, v] of source) {
      if (!icons.has(name) && v.bundle) loadIcon({ name, bundle: v.bundle });
    }
    return [...source.entries()]
      .map(([name, v]) => ({ name, down: v.down, up: v.up, icon: icons.get(name) ?? null }))
      .sort((a, b) => b.down + b.up - (a.down + a.up))
      .slice(0, n);
  }

  await refreshPids();
  setInterval(() => {
    if (!paused) void refreshPids(); // names are only needed while nettop reports pids
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
      void refreshPids(); // processes started meanwhile
      stream();
    },
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
        for (const [name, v] of Object.entries(daily[day] ?? {})) {
          if (isIgnored(name)) continue;
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
      killStream();
    },
  };
}
