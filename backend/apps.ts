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
// nettop reports a process for a few more readings after it exits (its last bytes among
// them), so a pid that left `ps` keeps its app this long
const GONE_KEEP_MS = 15_000;
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
// terminal behind a shell, `claude` or `curl`, or Safari behind its WebKit helpers.
// Private libSystem call, so fall back to the executable path. It does not reach
// into a detached session: its server is launched by launchd and is responsible for
// itself and for everything inside (see SESSION_HOSTS).
let responsiblePid: ((pid: number) => number) | null = null;
try {
  const { dlopen } = await import("tjs:ffi");
  const { symbols } = dlopen("c", {
    responsibility_get_pid_responsible_for_pid: { args: ["i32"], returns: "i32" },
  });
  responsiblePid = (pid) => symbols.responsibility_get_pid_responsible_for_pid(pid);
} catch (err) {
  console.error("tor apps: responsible-pid lookup unavailable:", err);
}

async function run(args: string[]): Promise<string> {
  const proc = tjs.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const text = await proc.stdout!.text();
  await proc.wait();
  return text;
}

// "" when the command is missing or fails (no tmux, or no server running)
async function tryRun(args: string[]): Promise<string> {
  try {
    return await run(args);
  } catch {
    return "";
  }
}

// Detached session hosts: a server that outlives the terminal and is reparented to
// launchd (tmux, screen, zellij, dtach, abduco, ...), so the responsible-process
// lookup stops at it and everything inside is unattributed. The terminal is only
// reachable through the client: an ordinary child of the terminal's shell running the
// same program, whose responsible process is the terminal app. The server's subtree
// is attributed to its newest client, matched by a shared argument (a socket path or
// session name) when the server has several; tmux knows its sessions, so its panes
// are mapped to the client attached to their own session. Adding a host: its
// executable name below, and a precise mapping if the generic one is too coarse.
const SESSION_HOSTS = new Set(["tmux", "screen", "zellij", "dtach", "abduco"]);

interface SessionHosts {
  tmux: {
    panes: Map<string, string>; // pane_pid → session id
    clients: Map<string, { pid: string; activity: number }>; // session id → newest client
  };
  args: Map<string, string[]>; // pid → argv (without argv[0]) of the host processes
}

function hostName(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return SESSION_HOSTS.has(name) ? name : null;
}

async function readSessionHosts(paths: Map<string, string>): Promise<SessionHosts> {
  const hosts: SessionHosts = { tmux: { panes: new Map(), clients: new Map() }, args: new Map() };
  const hostPids = [...paths].filter(([, path]) => hostName(path)).map(([pid]) => pid);
  if (!hostPids.length) return hosts;
  const [argsOut, paneOut, clientOut] = await Promise.all([
    tryRun(["ps", "-o", "pid=,args=", "-p", hostPids.join(",")]),
    tryRun(["tmux", "list-panes", "-a", "-F", "#{pane_pid} #{session_id}"]),
    tryRun(["tmux", "list-clients", "-F", "#{client_pid} #{session_id} #{client_activity}"]),
  ]);
  for (const line of argsOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) hosts.args.set(m[1], m[2].split(/\s+/).slice(1).filter(Boolean));
  }
  for (const line of paneOut.split("\n")) {
    const [pid, session] = line.trim().split(" ");
    if (pid && session) hosts.tmux.panes.set(pid, session);
  }
  for (const line of clientOut.split("\n")) {
    const [pid, session, activity] = line.trim().split(" ");
    if (!pid || !session) continue;
    const at = Number(activity) || 0;
    const cur = hosts.tmux.clients.get(session);
    if (!cur || at >= cur.activity) hosts.tmux.clients.set(session, { pid, activity: at });
  }
  return hosts;
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

// Processes that move bytes for an app without living in its bundle: system daemons
// that download for the App Store, and Steam, whose /Applications/Steam.app is only a
// bootstrapper for a client installed under Application Support (no ".app/" in its
// path, and its helpers sit in a nested "Steam Helper.app").
// Terminals with a server (Rex, Herdr) are the other kind: the window is one app, the
// shells run under a server bundle launched by launchd ("Rex Server.app", "Herdr
// Core.app", or a bare herdr-core binary), which is their responsible process, so
// all the traffic of what runs inside would be filed under the server, or dropped
// when its path has no .app in it. Those servers are looked up by the bundle id of
// the window app they belong to (see resolveAliases), so moving the app is fine.
const HOME = tjs.homeDir;
const APP_STORE: AppRef = { name: "App Store", bundle: "/System/Applications/App Store.app" };
const STEAM: AppRef = { name: "Steam", bundle: "/Applications/Steam.app" };
const APP_ALIASES: { prefix: string; app: AppRef }[] = [
  { prefix: "/System/Library/PrivateFrameworks/AppStoreDaemon.framework/", app: APP_STORE },
  { prefix: "/System/Library/PrivateFrameworks/CommerceKit.framework/", app: APP_STORE },
  { prefix: "/System/Applications/App Store.app/", app: APP_STORE },
  { prefix: `${HOME}/Library/Application Support/Steam/`, app: STEAM },
];
// server paths → the bundle id of the terminal app that shows them
const SERVER_ALIASES: { prefixes: string[]; bundleId: string }[] = [
  {
    prefixes: [`${HOME}/Library/Application Support/com.superlogical.rex/`],
    bundleId: "com.superlogical.rex", // Rex (Beta): "Rex Server.app" under Application Support
  },
  {
    prefixes: [`${HOME}/.local/share/herdr-core/`, `${HOME}/.local/bin/herdr-core`],
    bundleId: "dev.herdr.app", // Herdr: "Herdr Core.app" (or a bare herdr-core) under ~/.local
  },
];

// JXA: where NSWorkspace finds the app with each bundle id (one path per line, "" if none)
const APP_PATHS_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  return argv.map((id) => {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
    return url.isNil() ? "" : url.path.js;
  }).join("\\n");
}
`;

// Add an alias per installed terminal app for the server paths that run on its behalf.
// Apps not installed are skipped: their servers cannot be running either.
async function resolveAliases(dir: string): Promise<void> {
  const script = `${dir}/apppaths.jxa.js`;
  await tjs.writeFile(script, APP_PATHS_SCRIPT);
  const ids = SERVER_ALIASES.map((a) => a.bundleId);
  const out = await tryRun(["osascript", "-l", "JavaScript", script, ...ids]);
  const lines = out.replace(/\n$/, "").split("\n");
  SERVER_ALIASES.forEach(({ prefixes }, i) => {
    const bundle = lines[i];
    const name = bundle?.match(/([^/]+)\.app$/)?.[1];
    if (!bundle || !name) return;
    for (const prefix of prefixes) APP_ALIASES.push({ prefix, app: { name, bundle } });
  });
}

function appOf(path: string): AppRef | null {
  for (const { prefix, app } of APP_ALIASES) {
    if (path.startsWith(prefix)) return app;
  }
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
  /** rows changed since the last call (absolute totals), or null; + the cutoff to prune
   *  and the rows merged away (see mergeSaved) */
  takeDirty(): {
    rows: UsageRow[];
    pruneBefore: string;
    remove: { day: string; app: string }[];
  } | null;
  /** the last `range` days: daily totals, overall totals, and the usual suspects */
  stats(range?: number): Stats;
  /** an app's icon (data URL) when known; starts loading it from its bundle otherwise */
  icon(name: string): string | null;
  /** forget the cached sums (the hidden apps changed) */
  invalidate(): void;
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
  const removed: { day: string; app: string }[] = []; // rows merged into another app since the last save
  const iconDir = await tjs.makeTempDir(`${tempDir}/tor-appicons-XXXXXX`);
  const iconScript = `${iconDir}/icon.jxa.js`;
  await tjs.writeFile(iconScript, ICON_SCRIPT);
  await resolveAliases(iconDir);
  // History recorded under a server's own name before its alias existed ("Herdr Core",
  // "Rex Server") is folded into the app it stands for, so the list shows one entry
  for (const [day, apps] of Object.entries(daily)) {
    for (const [name, v] of Object.entries(apps)) {
      const app = v.bundle ? appOf(v.bundle) : null;
      if (!app || app.name === name) continue;
      const into = (apps[app.name] ??= { down: 0, up: 0, bundle: app.bundle });
      into.down += v.down;
      into.up += v.up;
      into.bundle = app.bundle;
      delete apps[name];
      touched.add(`${day}|${app.name}`);
      removed.push({ day, app: name });
    }
  }
  const pids = new Map<string, AppRef | null>(); // pid → { name, bundle } | null (not an app)
  const gone = new Map<string, number>(); // pid → when it was last missing from ps
  const sessionApp = new Map<string, AppRef>(); // session host key → the terminal last attached to it
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
      const parent = new Map<string, string>();
      for (const line of (await run(["ps", "-axo", "pid=,ppid=,comm="])).split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        paths.set(m[1], m[3]);
        parent.set(m[1], m[2]);
      }
      const hosts = await readSessionHosts(paths);
      const direct = (pid: string): AppRef | null => {
        const path = paths.get(pid);
        if (!path) return null;
        const owner = responsiblePid?.(Number(pid)) ?? 0;
        const ownerPath = owner > 0 ? paths.get(String(owner)) : undefined;
        return (ownerPath && appOf(ownerPath)) || appOf(path);
      };
      // the terminal behind a session: its client's app now, else the one last seen,
      // so a detached session keeps counting where it was shown
      const remember = (key: string, app: AppRef | null): AppRef | null => {
        if (app) sessionApp.set(key, app);
        return app ?? sessionApp.get(key) ?? null;
      };
      const tmuxSession = (session: string): AppRef | null => {
        const client = hosts.tmux.clients.get(session);
        return remember(`tmux:${session}`, client ? direct(client.pid) : null);
      };
      // a host server's client: same program under a terminal, sharing an argument
      // (socket path, session name) with the server when any client does
      const hostClient = (server: string, name: string): AppRef | null => {
        const serverArgs = new Set(hosts.args.get(server) ?? []);
        let best: { pid: number; shared: boolean; app: AppRef } | null = null;
        for (const [pid, path] of paths) {
          if (pid === server || hostName(path) !== name) continue;
          const app = direct(pid);
          if (!app) continue;
          const shared = (hosts.args.get(pid) ?? []).some((arg) => serverArgs.has(arg));
          const n = Number(pid);
          if (!best || (shared && !best.shared) || (shared === best.shared && n > best.pid)) {
            best = { pid: n, shared, app };
          }
        }
        return remember(`${name}:${server}`, best?.app ?? null);
      };
      // a process inside a session: walk up to the pane (tmux) or to the host server
      const sessionHostApp = (pid: string): AppRef | null => {
        for (let p: string | undefined = pid, hops = 0; p && p !== "1" && hops < 64; hops++) {
          const session = hosts.tmux.panes.get(p);
          if (session) return tmuxSession(session);
          const name = hostName(paths.get(p) ?? "");
          if (name && parent.get(p) === "1") return hostClient(p, name);
          p = parent.get(p);
        }
        return null;
      };
      const next = new Map<string, AppRef | null>();
      for (const pid of paths.keys()) {
        next.set(pid, direct(pid) ?? sessionHostApp(pid));
      }
      // just exited: keep the app for the readings nettop still prints for it
      const now = Date.now();
      for (const [pid, app] of pids) {
        if (paths.has(pid)) continue;
        const since = gone.get(pid) ?? now;
        if (now - since < GONE_KEEP_MS) {
          gone.set(pid, since);
          next.set(pid, app);
        }
      }
      for (const pid of gone.keys()) if (!next.has(pid) || paths.has(pid)) gone.delete(pid);
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

  function add(app: AppRef, down: number, up: number): void {
    const day = dayKey(new Date());
    const today = (daily[day] ??= {});
    const entry = (today[app.name] ??= { down: 0, up: 0, bundle: app.bundle });
    entry.down += down;
    entry.up += up;
    touched.add(`${day}|${app.name}`);
    sums.clear();
    loadIcon(app);
  }

  // sum of the last `days` calendar days, today included (shared: do not mutate)
  function history(days: number): Map<string, AppEntry> {
    return cached(`history:${days}`, () => sumHistory(days));
  }

  function sumHistory(days: number): Map<string, AppEntry> {
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
      if (!touched.size && !removed.length) return null;
      const rows = [...touched].map((key): UsageRow => {
        const [day, app] = key.split("|");
        const v = daily[day][app];
        return { day, app, down: v.down, up: v.up, bundle: v.bundle ?? "" };
      });
      touched.clear();
      const pruneBefore = dayKey(new Date(Date.now() - (KEEP_DAYS - 1) * 86_400_000));
      for (const day of Object.keys(daily)) if (day < pruneBefore) delete daily[day];
      const remove = removed.splice(0);
      return { rows, pruneBefore, remove };
    },
    stats(range = 30) {
      const days: DayUsage[] = [];
      for (let i = range - 1; i >= 0; i--) {
        const day = dayKey(new Date(Date.now() - i * 86_400_000));
        days.push(
          cached(`day:${day}`, () => {
            let down = 0;
            let up = 0;
            for (const [name, v] of Object.entries(daily[day] ?? {})) {
              if (isIgnored(name)) continue;
              down += v.down;
              up += v.up;
            }
            return { day, down, up };
          }),
        );
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
    icon(name) {
      const known = icons.get(name);
      if (known) return known;
      for (const day of Object.values(daily)) {
        const bundle = day[name]?.bundle;
        if (bundle) {
          loadIcon({ name, bundle });
          break;
        }
      }
      return icons.get(name) ?? null;
    },
    invalidate() {
      sums.clear();
    },
    stop() {
      stopped = true;
      killStream();
    },
  };
}
