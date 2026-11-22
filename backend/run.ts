// Run a helper program and collect what it prints.

export async function run(args: string[]): Promise<string> {
  const proc = tjs.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const text = await proc.stdout!.text();
  const status = await proc.wait();
  if (status.exit_status !== 0) throw new Error(`${args[0]} exited with ${status.exit_status}`);
  return text;
}

/** "" when the command is missing or fails (no tmux, or no server running) */
export async function tryRun(args: string[]): Promise<string> {
  try {
    return await run(args);
  } catch {
    return "";
  }
}
