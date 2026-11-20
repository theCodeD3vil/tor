// NET_RT_IFLIST2 avoids a child process every tick. macOS LP64 if_msghdr2 /
// if_data64 (pack 4) has the uint64 byte counters at 96 and 104.
const CTL_NET = 4;
const PF_ROUTE = 17;
const NET_RT_IFLIST2 = 6;
const RTM_IFINFO2 = 18;
const HDR = 160;
const IBYTES = 96;
const OBYTES = 104;
const NETSTAT = "/usr/sbin/netstat";

type Sysctl = (
  mib: Uint8Array,
  namelen: number,
  oldp: Uint8Array | null,
  oldlenp: Uint8Array,
  newp: null,
  newlen: number,
) => number;

let sysctl: Sysctl | null = null;
try {
  const { dlopen } = await import("tjs:ffi");
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: ["buffer", "u32", "pointer", "buffer", "pointer", "u64"], returns: "i32" },
  });
  sysctl = symbols.sysctl as Sysctl;
} catch (err) {
  console.error("tor counters: sysctl unavailable:", err);
}

const mib = new Uint8Array(new Int32Array([CTL_NET, PF_ROUTE, 0, 0, NET_RT_IFLIST2, 0]).buffer);
const decoder = new TextDecoder();

type Interfaces = Map<string, { rx: bigint; tx: bigint }>;
export interface CounterReading {
  source: "sysctl" | "netstat";
  interfaces: Interfaces;
}

function readSysctl(): CounterReading | null {
  if (!sysctl) return null;
  const size = new BigUint64Array(1);
  const lenBuf = new Uint8Array(size.buffer);
  if (sysctl(mib, 6, null, lenBuf, null, 0) !== 0) return null;
  const len = Number(size[0]);
  if (!len || len > 8_000_000) return null;
  const out = new Uint8Array(len);
  if (sysctl(mib, 6, out, lenBuf, null, 0) !== 0 || size[0] > BigInt(len)) return null;
  return parseRoutingMessages(out.subarray(0, Number(size[0])));
}

export function parseRoutingMessages(out: Uint8Array): CounterReading | null {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const interfaces: Interfaces = new Map();
  let sawInterface = false;
  for (let off = 0; off < out.length;) {
    if (off + 4 > out.length) return null;
    const msglen = view.getUint16(off, true);
    const end = off + msglen;
    if (msglen < 4 || end > out.length) return null;
    if (view.getUint8(off + 3) === RTM_IFINFO2) {
      if (msglen < HDR + 8) return null;
      const nlen = out[off + HDR + 5]; // sockaddr_dl.sdl_nlen
      const start = off + HDR + 8; // sockaddr_dl.sdl_data
      if (nlen > 0 && start + nlen <= end) {
        sawInterface = true;
        const name = decoder.decode(out.subarray(start, start + nlen));
        if (/^(en|utun)\d+$/.test(name)) {
          const index = view.getUint16(off + 12, true);
          interfaces.set(`${name}#${index}`, {
            rx: view.getBigUint64(off + IBYTES, true),
            tx: view.getBigUint64(off + OBYTES, true),
          });
        }
      }
    }
    off = end;
  }
  return sawInterface ? { source: "sysctl", interfaces } : null;
}

async function readNetstat(): Promise<CounterReading> {
  const proc = tjs.spawn([NETSTAT, "-ibn"], { stdout: "pipe", stderr: "ignore" });
  const text = await proc.stdout!.text();
  const status = await proc.wait();
  if (status.exit_status !== 0) throw new Error("netstat failed to read interface counters");
  const interfaces: Interfaces = new Map();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const index = cols[2]?.match(/^<Link#(\d+)>$/)?.[1];
    const name = cols[0]?.replace(/\*$/, "");
    if (!index || !/^(en|utun)\d+$/.test(name)) continue;
    const rx = cols[cols.length - 5];
    const tx = cols[cols.length - 2];
    if (!/^\d+$/.test(rx) || !/^\d+$/.test(tx)) continue;
    interfaces.set(`${name}#${index}`, { rx: BigInt(rx), tx: BigInt(tx) });
  }
  return { source: "netstat", interfaces };
}

/** Ignore newly visible interfaces, resets, and transitions to/from the fallback. */
export function counterDelta(before: CounterReading, after: CounterReading) {
  let rx = 0n;
  let tx = 0n;
  let tunnel = 0n;
  if (before.source === after.source) {
    for (const [id, cur] of after.interfaces) {
      const prev = before.interfaces.get(id);
      if (!prev) continue;
      const down = cur.rx >= prev.rx ? cur.rx - prev.rx : 0n;
      const up = cur.tx >= prev.tx ? cur.tx - prev.tx : 0n;
      if (id.startsWith("utun")) tunnel += down + up;
      else {
        rx += down;
        tx += up;
      }
    }
  }
  return { down: Number(rx), up: Number(tx), tunnel: Number(tunnel) };
}

export async function readCounters(): Promise<CounterReading> {
  return readSysctl() ?? readNetstat();
}
