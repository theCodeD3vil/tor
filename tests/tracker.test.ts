import { describe, expect, test, vi } from "vite-plus/test";
import { counterDelta, parseRoutingMessages, type CounterReading } from "../backend/counters";
import { createNettopParser, type ProcSample } from "../backend/nettop";
import { isIgnoredApp, pickSettings } from "../shared/settings";

vi.mock("tjs:ffi", () => ({
  dlopen: () => ({
    symbols: {
      sysctl: null,
      proc_pidpath: () => 0,
      responsibility_get_pid_responsible_for_pid: () => 0,
    },
  }),
}));

const reading = (
  source: CounterReading["source"],
  interfaces: [string, { rx: bigint; tx: bigint }][],
): CounterReading => ({ source, interfaces: new Map(interfaces) });

describe("network counters", () => {
  test("keeps 64-bit precision and re-baselines new interfaces and resets", () => {
    const prev = reading("sysctl", [
      ["en0#1", { rx: 2n ** 55n, tx: 10n }],
      ["utun0#2", { rx: 4n, tx: 20n }],
      ["en1#3", { rx: 100n, tx: 100n }],
    ]);
    const next = reading("sysctl", [
      ["en0#1", { rx: 2n ** 55n + 123n, tx: 3n }],
      ["utun0#2", { rx: 11n, tx: 31n }],
      ["en1#4", { rx: 100_000n, tx: 10_000n }],
    ]);
    expect(counterDelta(prev, next)).toEqual({ down: 123, up: 0, tunnel: 18 });
  });

  test("does not mix sysctl and netstat baselines", () => {
    const sysctl = reading("sysctl", [["en0#1", { rx: 0n, tx: 0n }]]);
    const netstat = reading("netstat", [["en0#1", { rx: 900_000n, tx: 800_000n }]]);
    expect(counterDelta(sysctl, netstat)).toEqual({ down: 0, up: 0, tunnel: 0 });
    expect(counterDelta(netstat, sysctl)).toEqual({ down: 0, up: 0, tunnel: 0 });
  });

  test("reads full counters and rejects a truncated route message", () => {
    const bytes = new Uint8Array(172);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, bytes.length, true);
    view.setUint8(3, 18);
    view.setUint16(12, 7, true);
    view.setBigUint64(96, 2n ** 55n, true);
    view.setBigUint64(104, 777n, true);
    bytes[165] = 3;
    bytes.set(new TextEncoder().encode("en0"), 168);
    expect(parseRoutingMessages(bytes)).toEqual(
      reading("sysctl", [["en0#7", { rx: 2n ** 55n, tx: 777n }]]),
    );
    expect(parseRoutingMessages(bytes.subarray(0, 170))).toBeNull();
  });
});

test("a stopped nettop stream cannot complete or clear a replacement frame", () => {
  const samples: ProcSample[][] = [];
  const encode = (value: string) => new TextEncoder().encode(value);
  const header = ",interface,bytes_in,bytes_out,\r\n";
  const old = createNettopParser(() => {});
  const current = createNettopParser((rows) => samples.push(rows));

  old(encode(`${header}Old.1,,123,45,\r\n`));
  current(encode(`${header}New, app.2,,22,33,\r\nudp4 *:*<->*:*,,,,\r\nudp4 10.0.`));
  old(encode(`${header}Old.1,,124,46,`));
  expect(samples).toHaveLength(0);
  current(encode(`0.1:1<->1.2.3.4:51820,en0,3,4,\r\n${header}`));
  expect(samples).toMatchObject([
    [{ pid: "2", in: 22, out: 33, sockets: [{ iface: "en0", remotePort: 51820, in: 3, out: 4 }] }],
  ]);
});

test("socket mode keeps tunnel and UDP sockets and drops other TCP flows", () => {
  const samples: ProcSample[][] = [];
  const parse = createNettopParser((rows) => samples.push(rows));
  const header = ",interface,bytes_in,bytes_out,\r\n";
  parse(
    new TextEncoder().encode(
      [
        header,
        "App.7,,500,600,\r\n",
        "tcp4 10.0.0.2:5000<->1.1.1.1:443,en0,100,100,\r\n",
        "tcp4 10.8.0.2:5001<->2.2.2.2:443,utun3,7,8,\r\n",
        "udp4 10.0.0.2:6000<->3.3.3.3:51820,en0,9,10,\r\n",
        header,
      ].join(""),
    ),
  );
  expect(samples).toEqual([
    [
      {
        pid: "7",
        in: 500,
        out: 600,
        sockets: [
          expect.objectContaining({ iface: "utun3", udp: false, in: 7, out: 8 }),
          expect.objectContaining({ iface: "en0", udp: true, remotePort: 51820, in: 9, out: 10 }),
        ],
      },
    ],
  ]);
});

test("same-name bundle rules are independent and old settings retain their meaning", () => {
  const first = "/Applications/Example.app";
  const second = "/Somewhere/Example.app";
  const stored = pickSettings({
    ignoredApps: [
      "Old",
      "Pinned",
      "opencode",
      { name: "Example", bundle: first },
      { name: "Example", bundle: second },
    ],
    ignoredBundles: { Pinned: "/Applications/Pinned.app" },
  }).ignoredApps!;
  expect(isIgnoredApp(stored, "Old", "/Applications/Old.app")).toBe(true);
  expect(isIgnoredApp(stored, "OpenCode", "/Applications/OpenCode.app")).toBe(true);
  expect(isIgnoredApp(stored, "Pinned", "/Different/Pinned.app")).toBe(false);
  expect(isIgnoredApp(stored, "Example", first)).toBe(true);
  expect(isIgnoredApp(stored, "Example", second)).toBe(true);
  expect(
    isIgnoredApp(
      stored.filter((app) => app.bundle !== first),
      "Example",
      second,
    ),
  ).toBe(true);
  expect(isIgnoredApp(stored, "Example", "")).toBe(false);
});

test("a failed usage flush can be retried without losing migrated rows", async () => {
  vi.stubGlobal("tjs", {
    homeDir: "/Users/test",
    makeTempDir: async () => "/unused/tor-apps",
    makeDir: async () => {},
    writeFile: async () => {},
    remove: async () => {},
    spawn: () => ({
      stdout: { text: async () => "" },
      wait: async () => ({ exit_status: 0 }),
    }),
  });
  try {
    const { createAppTracker } = await import("../backend/apps");
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const tracker = await createAppTracker(
      "/unused",
      {
        [day]: { opencode: { name: "opencode", bundle: "", down: 5, up: 2 } },
      },
      { paused: true, iconDir: "/unused" },
    );
    try {
      expect(() =>
        tracker.flushDirty(() => {
          throw new Error("disk unavailable");
        }),
      ).toThrow();
      const save = vi.fn();
      tracker.flushDirty(save);
      expect(save).toHaveBeenCalledWith(
        [{ day, app: "OpenCode", bundle: "", down: 5, up: 2 }],
        expect.any(String),
        expect.any(Array),
      );
      tracker.flushDirty(save);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      await tracker.stop();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

test("saved Setapp agent and translocated rows fold into one row per app", async () => {
  vi.stubGlobal("tjs", {
    homeDir: "/Users/test",
    makeTempDir: async () => "/unused/tor-apps",
    makeDir: async () => {},
    writeFile: async () => {},
    remove: async () => {},
    spawn: (args: string[]) => ({
      stdout: {
        // NSWorkspace lookup: Rex, Herdr, Setapp, OpenCode
        text: async () =>
          args[0] === "/usr/bin/osascript" ? "\n\n/Applications/Setapp.app\n\n" : "",
      },
      wait: async () => ({ exit_status: 0 }),
    }),
  });
  try {
    const { createAppTracker } = await import("../backend/apps");
    const day = "2026-11-20";
    const agent = "/Users/test/Library/Application Support/Setapp/LaunchAgents/Setapp.app";
    const copy = (id: string) =>
      `/private/var/folders/fr/abc/T/AppTranslocation/${id}/d/Install Setapp 3.app`;
    const tracker = await createAppTracker(
      "/unused",
      {
        [day]: {
          "/Applications/Setapp.app": {
            name: "Setapp",
            bundle: "/Applications/Setapp.app",
            down: 5,
            up: 1,
          },
          [agent]: { name: "Setapp", bundle: agent, down: 9, up: 2 },
          [copy("A")]: { name: "Install Setapp 3", bundle: copy("A"), down: 4, up: 0 },
          [copy("B")]: { name: "Install Setapp 3", bundle: copy("B"), down: 3, up: 0 },
        },
      },
      { paused: true, iconDir: "/unused" },
    );
    try {
      const save = vi.fn();
      tracker.flushDirty(save);
      const [rows, , removed] = save.mock.calls[0];
      expect(rows).toEqual(
        expect.arrayContaining([
          { day, app: "Setapp", bundle: "/Applications/Setapp.app", down: 14, up: 3 },
          { day, app: "Install Setapp 3", bundle: "", down: 7, up: 0 },
        ]),
      );
      expect(rows).toHaveLength(2);
      expect(removed).toEqual(
        expect.arrayContaining([
          { day, app: "Setapp", bundle: agent },
          { day, app: "Install Setapp 3", bundle: copy("A") },
          { day, app: "Install Setapp 3", bundle: copy("B") },
        ]),
      );
    } finally {
      await tracker.stop();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
test("connections show recent per-app traffic as active, then return to idle", async () => {
  const frame = new TextEncoder().encode(
    [
      ",interface,bytes_in,bytes_out,",
      "Example.4242,,100,200,",
      ",interface,bytes_in,bytes_out,",
      "Example.4242,,140,260,",
      ",interface,bytes_in,bytes_out,",
    ].join("\r\n") + "\r\n",
  );
  vi.stubGlobal("tjs", {
    homeDir: "/Users/test",
    makeTempDir: async () => "/unused/tor-apps",
    makeDir: async () => {},
    writeFile: async () => {},
    remove: async () => {},
    spawn: (args: string[]) => {
      if (args[0] === "/usr/bin/script") {
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(frame);
            },
          }),
          kill: () => streamController?.close(),
        };
      }
      return {
        stdout: { text: async () => (args[0] === "/bin/ps" ? "4242 1\n" : "") },
        wait: async () => ({ exit_status: 0 }),
      };
    },
  });
  try {
    const { createAppTracker } = await import("../backend/apps");
    const tracker = await createAppTracker("/unused", {}, { iconDir: "/unused" });
    try {
      await vi.waitFor(() =>
        expect(tracker.top(5)[0]).toMatchObject({
          name: "System & CLI",
          down: 40,
          up: 60,
          active: true,
        }),
      );
      await vi.waitFor(() => expect(tracker.top(5)[0]?.active).toBe(false), { timeout: 4_000 });
    } finally {
      await tracker.stop();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
