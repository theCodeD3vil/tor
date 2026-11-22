// Which app a process's traffic belongs to: the .app it lives in, the app responsible
// for it (the terminal behind a shell, `claude` or `curl`, or Safari behind its WebKit
// helpers), the terminal showing a detached session, a coding agent's shared service,
// or System & CLI. Apple system binaries and network extensions are dropped.
import { run, tryRun } from "./run";

export const PS = "/bin/ps";
const OSASCRIPT = "/usr/bin/osascript";
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

// macOS "responsible process": the app a process works on behalf of. Private libSystem
// call, so fall back to the executable path. It does not reach into a detached session:
// its server is launched by launchd and is responsible for itself and for everything
// inside (see SESSION_HOSTS).
// libSystem is opened by its full path: the runtime tinyjs bundled up to txiki.js
// 26.6 could not resolve the bare name "c", so the lookup was silently missing and
// every terminal's traffic (curl, git, brew: no ".app" in their path) was dropped.
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
export let responsiblePid: ((pid: number) => number) | null = null;
// Kernel vnode path, not the process-controlled ps `comm` label.
export let procPath: ((pid: number) => string) | null = null;
/** why responsiblePid is missing, reported by createAppTracker */
export let lookupError: string | null = null;
try {
  const { dlopen } = await import("tjs:ffi");
  const { symbols } = dlopen(LIBSYSTEM, {
    responsibility_get_pid_responsible_for_pid: { args: ["i32"], returns: "i32" },
  });
  responsiblePid = (pid) => symbols.responsibility_get_pid_responsible_for_pid(pid);
} catch (err) {
  lookupError = err instanceof Error ? err.message : String(err);
  console.error("tor apps: responsible-pid lookup unavailable:", err);
}
try {
  const { dlopen } = await import("tjs:ffi");
  const { symbols } = dlopen(LIBSYSTEM, {
    proc_pidpath: { args: ["i32", "buffer", "u32"], returns: "i32" },
  });
  const pathBuf = new Uint8Array(4096);
  const decoder = new TextDecoder();
  procPath = (pid) => {
    const n = symbols.proc_pidpath(pid, pathBuf, pathBuf.length);
    if (n <= 0) return "";
    return decoder.decode(pathBuf.subarray(0, n));
  };
} catch (err) {
  console.error("tor apps: process paths unavailable:", err);
}

// Finder and Login Items give the app a PATH without Homebrew, so a bare
// `tmux` never resolves in a packaged build. Probe the real locations.
let tmuxBin: string | null | undefined;
async function tmuxPath(): Promise<string | null> {
  if (tmuxBin !== undefined) return tmuxBin;
  tmuxBin = null;
  for (const path of TMUX_CANDIDATES) {
    try {
      await tjs.stat(path);
      tmuxBin = path;
      break;
    } catch {
      // not installed there
    }
  }
  return tmuxBin;
}

/** an app's row: its display name and outermost .app ("" for System & CLI and agents) */
export interface AppRef {
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
// when its path has no .app in it. Setapp is the same shape: the app in /Applications
// is the window, and its agent, launcher and updater (the ones that download) are
// separate bundles under Application Support, also named "Setapp.app". Those helpers
// are looked up by the bundle id of the window app they belong to (see
// resolveAliases), so moving the app is fine.
const HOME = tjs.homeDir;
const APP_STORE: AppRef = { name: "App Store", bundle: "/System/Applications/App Store.app" };
const STEAM: AppRef = { name: "Steam", bundle: "/Applications/Steam.app" };
const APP_ALIASES: { prefix: string; app: AppRef }[] = [
  { prefix: "/System/Library/PrivateFrameworks/AppStoreDaemon.framework/", app: APP_STORE },
  { prefix: "/System/Library/PrivateFrameworks/CommerceKit.framework/", app: APP_STORE },
  { prefix: "/System/Applications/App Store.app/", app: APP_STORE },
  { prefix: `${HOME}/Library/Application Support/Steam/`, app: STEAM },
];
// helper paths → the bundle id of the app they work for
const SERVER_ALIASES: { prefixes: string[]; bundleId: string }[] = [
  {
    prefixes: [`${HOME}/Library/Application Support/com.superlogical.rex/`],
    bundleId: "com.superlogical.rex", // Rex (Beta): "Rex Server.app" under Application Support
  },
  {
    prefixes: [`${HOME}/.local/share/herdr-core/`, `${HOME}/.local/bin/herdr-core`],
    bundleId: "dev.herdr.app", // Herdr: "Herdr Core.app" (or a bare herdr-core) under ~/.local
  },
  {
    prefixes: [`${HOME}/Library/Application Support/Setapp/LaunchAgents/`],
    bundleId: "com.setapp.DesktopClient", // Setapp: Setapp.app, SetappLauncher.app, ...
  },
];
// Gatekeeper runs a quarantined app from a random read-only copy
// (/private/var/folders/…/AppTranslocation/<uuid>/d/Name.app), a new one on every launch
// and gone once it quits, so the path cannot tell launches apart from other apps
const TRANSLOCATED = /\/AppTranslocation\/[^/]+\/d\//;

// Coding agents that make their model calls from one background service shared by every
// terminal: opencode starts "opencode serve --service" under launchd the first time and
// every later session, from any terminal, only talks to it over loopback. Its responsible
// process is whichever app started it first (Herdr, say), so all sessions' traffic would
// be filed under that app, and no terminal could be told apart anyway. The service, and
// what it runs for the agent, get a row of their own instead. Only processes with no
// .app of their own are claimed: a GUI app an agent opens keeps its row. Adding an
// agent: the name of its executable below.
const AGENT_SERVICES: { exe: string; bundleId: string; app: AppRef }[] = [
  { exe: "opencode", bundleId: "ai.opencode.desktop", app: { name: "OpenCode", bundle: "" } },
];
// Everything that is not a real app and not an Apple system binary. Hidden
// launchd agents and CLIs used to vanish from the totals.
export const OTHER: AppRef = { name: "System & CLI", bundle: "" };
const SYSTEM_PREFIXES = ["/System/Library/", "/usr/libexec/", "/usr/sbin/", "/usr/lib/"];

// JXA: where NSWorkspace finds the app with each bundle id (one path per line, "" if none)
const APP_PATHS_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  return argv.map((id) => {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
    return url.isNil() ? "" : url.path.js;
  }).join("\\n");
}
`;

/** Add an alias per installed app for the helper paths that run on its behalf.
 *  Apps not installed are skipped: their helpers cannot be running either. An agent's row
 *  (AGENT_SERVICES) gets the bundle of its desktop app when that is installed. */
export async function resolveAliases(dir: string): Promise<void> {
  const script = `${dir}/apppaths.jxa.js`;
  await tjs.writeFile(script, APP_PATHS_SCRIPT);
  const ids = [...SERVER_ALIASES, ...AGENT_SERVICES].map((a) => a.bundleId);
  applyAppPaths(await tryRun([OSASCRIPT, "-l", "JavaScript", script, ...ids]));
}

/** what APP_PATHS_SCRIPT printed: one app path per bundle id, in resolveAliases' order */
export function applyAppPaths(out: string): void {
  const lines = out.replace(/\n$/, "").split("\n");
  SERVER_ALIASES.forEach(({ prefixes }, i) => {
    const bundle = lines[i];
    const name = bundle?.match(/([^/]+)\.app$/)?.[1];
    if (!bundle || !name) return;
    for (const prefix of prefixes) {
      if (!APP_ALIASES.some((alias) => alias.prefix === prefix))
        APP_ALIASES.push({ prefix, app: { name, bundle } });
    }
  });
  AGENT_SERVICES.forEach(({ app }, i) => {
    const bundle = lines[SERVER_ALIASES.length + i];
    if (bundle?.startsWith("/") && bundle.endsWith(`/${app.name}.app`)) app.bundle = bundle;
  });
}

export function isExtension(path: string): boolean {
  // Network Extensions carry other apps' traffic: counting them counts it twice
  return path.startsWith("/Library/SystemExtensions/") || /\.(appex|systemextension)\//.test(path);
}

export function isSystem(path: string): boolean {
  return SYSTEM_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function aliasOf(path: string): AppRef | null {
  for (const { prefix, app } of APP_ALIASES) {
    if (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix) return app;
  }
  return null;
}

/** Outermost .app of an executable path; null for daemons, CLIs and system internals */
export function appOf(path: string): AppRef | null {
  if (isExtension(path)) return null;
  const alias = aliasOf(path);
  if (alias) return alias;
  // A real bundle has Contents/. A path that merely contains ".app" does not.
  const m = path.match(/^(.*?\/([^/]+)\.app)\/Contents\//);
  if (!m) return null;
  // keyed by name: one row for every launch of a translocated app
  return { name: m[2], bundle: TRANSLOCATED.test(m[1]) ? "" : m[1] };
}

/** The app a saved history row belongs to now, when it was recorded under a helper's
 *  own bundle before its alias existed ("Herdr Core", Setapp's agent), under an earlier
 *  name ("opencode"), or under one launch's translocated copy. */
export function historicalApp(name: string, bundle: string): AppRef | null {
  const agent = !bundle && AGENT_SERVICES.find(({ exe, app }) => name === exe || name === app.name);
  if (agent) return agent.app;
  if (!bundle) return null;
  const app = appOf(`${bundle}/Contents/`);
  return app && app.bundle !== bundle ? app : null;
}

// ── processes ──
export interface ProcessTable {
  /** pid → executable path ("" when unknown) */
  paths: Map<string, string>;
  /** pid → parent pid */
  parent: Map<string, string>;
}

export async function readProcessTable(): Promise<ProcessTable> {
  const paths = new Map<string, string>();
  const parent = new Map<string, string>();
  for (const line of (await run([PS, "-axo", "pid=,ppid="])).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    paths.set(m[1], procPath?.(Number(m[1])) ?? "");
    parent.set(m[1], m[2]);
  }
  return { paths, parent };
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

export interface SessionHosts {
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

export async function readSessionHosts(paths: Map<string, string>): Promise<SessionHosts> {
  const hostPids = [...paths].filter(([, path]) => hostName(path)).map(([pid]) => pid);
  if (!hostPids.length) return parseSessionHosts("", "", "");
  const tmux = hostPids.some((pid) => hostName(paths.get(pid) ?? "") === "tmux")
    ? await tmuxPath()
    : null;
  const [argsOut, paneOut, clientOut] = await Promise.all([
    tryRun([PS, "-o", "pid=,args=", "-p", hostPids.join(",")]),
    tmux
      ? tryRun([tmux, "list-panes", "-a", "-F", "#{pane_pid} #{session_id}"])
      : Promise.resolve(""),
    tmux
      ? tryRun([tmux, "list-clients", "-F", "#{client_pid} #{session_id} #{client_activity}"])
      : Promise.resolve(""),
  ]);
  return parseSessionHosts(argsOut, paneOut, clientOut);
}

/** `ps -o pid=,args=`, `tmux list-panes` and `tmux list-clients`, as readSessionHosts runs them */
export function parseSessionHosts(
  argsOut: string,
  paneOut: string,
  clientOut: string,
): SessionHosts {
  const hosts: SessionHosts = { tmux: { panes: new Map(), clients: new Map() }, args: new Map() };
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

/** what the resolver keeps between process scans */
export interface ResolverState {
  /** pid → its responsible pid, valid while the pid runs the same executable */
  responsibleOf: Map<string, { path: string; pid: number }>;
  /** session key → the app last seen showing it */
  sessionApp: Map<string, { app: AppRef; seen: number }>;
}

/** For one process scan: pid → its app, or null to drop it (an extension, Apple system). */
export function createResolver(
  { paths, parent }: ProcessTable,
  hosts: SessionHosts,
  { responsibleOf, sessionApp }: ResolverState,
  responsible: ((pid: number) => number) | null = responsiblePid,
  now = Date.now(),
): (pid: string) => AppRef | null {
  const direct = (pid: string): AppRef | null => {
    const path = paths.get(pid);
    if (!path || isExtension(path)) return null;
    const cached = responsibleOf.get(pid);
    const owner = cached && cached.path === path ? cached.pid : (responsible?.(Number(pid)) ?? 0);
    responsibleOf.set(pid, { path, pid: owner });
    const ownerPath = owner > 0 ? paths.get(String(owner)) : undefined;
    return (ownerPath && appOf(ownerPath)) || appOf(path);
  };
  // an agent's service, or something it runs: its own row, ahead of the responsible app
  const agentOf = (pid: string): AppRef | null => {
    if (appOf(paths.get(pid) ?? "")) return null; // an app of its own keeps its row
    for (let p: string | undefined = pid, hops = 0; p && p !== "1" && hops < 64; hops++) {
      const path = paths.get(p) ?? "";
      const exe = path.slice(path.lastIndexOf("/") + 1);
      const agent = AGENT_SERVICES.find((a) => a.exe === exe);
      if (agent) return agent.app;
      p = parent.get(p);
    }
    return null;
  };
  // the terminal behind a session: its client's app now, else the one last seen,
  // so a detached session keeps counting where it was shown
  const remember = (key: string, app: AppRef | null): AppRef | null => {
    const entry = app ?? sessionApp.get(key)?.app;
    if (entry) sessionApp.set(key, { app: entry, seen: now });
    return entry ?? null;
  };
  // every process in a session asks for the same answer: work it out once per scan
  const sessions = new Map<string, AppRef | null>();
  const once = (key: string, compute: () => AppRef | null): AppRef | null => {
    if (!sessions.has(key)) sessions.set(key, remember(key, compute()));
    return sessions.get(key)!;
  };
  const tmuxSession = (session: string): AppRef | null =>
    once(`tmux:${session}`, () => {
      const client = hosts.tmux.clients.get(session);
      return client ? direct(client.pid) : null;
    });
  // a host server's client: same program under a terminal, sharing an argument
  // (socket path, session name) with the server when any client does
  const hostClient = (server: string, name: string): AppRef | null =>
    once(`${name}:${server}`, () => {
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
      return best?.app ?? null;
    });
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
  return (pid) => {
    const path = paths.get(pid) ?? "";
    if (isExtension(path)) return null;
    const app = agentOf(pid) ?? direct(pid) ?? sessionHostApp(pid);
    // not an app and not an Apple binary: keep it visible instead of dropping it
    return app ?? (isSystem(path) ? null : OTHER);
  };
}
