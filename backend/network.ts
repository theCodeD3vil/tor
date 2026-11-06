// Online = macOS has a primary network interface, i.e. State:/Network/Global/IPv4 or
// IPv6 exists in the SystemConfiguration dynamic store. That is not internet
// reachability: a LAN with no internet still moves bytes, and Tor counts those.
// `scutil` watches the two keys and prints a line when either changes, so there is no
// polling; every change (and a wake, a restart) is followed by a one-shot `scutil show`.
// tjs quirk: a write to a child's stdin lands at once but its promise never settles, and
// closing the writer sends no EOF, so the one-shot goes through `sh` and the watcher's
// write is not awaited.

const KEYS = ["State:/Network/Global/IPv4", "State:/Network/Global/IPv6"];
const SETTLE_MS = 300; // one change arrives as a few notifications: read the state once
const encoder = new TextEncoder();

export interface NetworkWatcher {
  /** read the state now and report it (after a wake, say) */
  refresh(): Promise<void>;
  stop(): void;
}

/** true when a primary interface exists, for IPv4 or IPv6 */
export async function isOnline(): Promise<boolean> {
  const script = KEYS.map((key) => `show ${key}`).join("\\n");
  const proc = tjs.spawn(["sh", "-c", `printf '${script}\\n' | scutil`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await proc.stdout!.text();
  await proc.wait();
  return /PrimaryInterface\s*:/.test(out);
}

export function watchNetwork(onState: (online: boolean) => void): NetworkWatcher {
  let stopped = false;
  let proc: ReturnType<typeof tjs.spawn> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let again = false;
  let reading: Promise<void> | null = null;

  // refreshes asked for while one runs collapse into a single read after it
  function refresh(): Promise<void> {
    again = true;
    reading ??= (async () => {
      while (again && !stopped) {
        again = false;
        try {
          onState(await isOnline());
        } catch (err) {
          console.error("tor network:", err); // the state stays as it was
        }
      }
    })().finally(() => {
      reading = null;
    });
    return reading;
  }

  async function watch(): Promise<void> {
    const p = tjs.spawn(["scutil"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc = p;
    // stdin stays open: EOF would end the session (not awaited, see above)
    const commands = `${KEYS.map((key) => `n.add ${key}\n`).join("")}n.watch\n`;
    void p.stdin!.getWriter().write(encoder.encode(commands));
    const reader = p.stdout!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      // whatever it printed is a change notice: `show` replies go to their own process
      clearTimeout(settle);
      settle = setTimeout(() => void refresh(), SETTLE_MS);
    }
    if (proc === p) proc = undefined;
  }

  function start(): void {
    if (stopped) return;
    watch()
      .catch((err) => console.error("tor network watch:", err))
      .finally(() => {
        // scutil ended (killed, or its store connection dropped): start over, and read
        // the state in case it changed in between
        if (!stopped)
          setTimeout(() => {
            start();
            void refresh();
          }, 1000);
      });
  }
  start();

  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(settle);
      try {
        proc?.kill();
      } catch {
        // already exited
      }
    },
  };
}
