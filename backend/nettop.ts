export interface ProcSample {
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

/** One parser per child process: a replaced child can never touch its successor's frame. */
export function createNettopParser(onSample: (sample: ProcSample[]) => void) {
  const decoder = new TextDecoder();
  let buf = "";
  let sample: ProcSample[] = [];
  let current: ProcSample | undefined;
  return (chunk: Uint8Array): void => {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith(",interface,bytes_in,bytes_out,")) {
        const complete = sample;
        sample = [];
        current = undefined;
        if (complete.length) onSample(complete);
        continue;
      }
      // The executable label may itself contain commas. The numeric columns
      // and interface are the final three fields; parse those from the right.
      const m = /^(.*),([^,]*),(\d+),(\d+),$/.exec(line);
      if (!m) {
        // nettop prints empty counters for unconnected sockets.
        if (!/^(tcp|udp)\d?\s/.test(line)) current = undefined;
        continue;
      }
      const [, label, iface, bytesIn, bytesOut] = m;
      const count = { in: Number(bytesIn), out: Number(bytesOut) };
      if (!Number.isSafeInteger(count.in) || !Number.isSafeInteger(count.out)) continue;
      if (!iface) {
        const pid = /\.(\d+)$/.exec(label)?.[1];
        current = pid ? { pid, ...count, sockets: [] } : undefined;
        if (current) sample.push(current);
      } else if (current && /^(tcp|udp)\d?\s/.test(label)) {
        const remote = label.includes("<->") ? label.slice(label.indexOf("<->") + 3) : "";
        current.sockets.push({
          key: label,
          iface,
          udp: label.startsWith("udp"),
          remotePort: Number(/[.:](\d+)$/.exec(remote)?.[1]) || 0,
          ...count,
        });
      }
    }
  };
}
