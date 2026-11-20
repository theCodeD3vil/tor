// Settings live in memory for synchronous reads (every tray repaint) and are
// written through to tinyjs's store.
import { defaultSettings, pickSettings, type Settings } from "../shared/settings";

const STORE_KEY = "settings";

let current: Settings = { ...defaultSettings };
let writeTail: Promise<void> = Promise.resolve();

export async function loadSettings(app: TinyApp): Promise<void> {
  current = { ...defaultSettings, ...pickSettings(await app.store.get(STORE_KEY)) };
}

export function getSettings(): Settings {
  return current;
}

/** apply a partial change, persist it and return the new settings */
export function updateSettings(changes: unknown, app: TinyApp): Promise<Settings> {
  const patch = pickSettings(changes);
  const write = writeTail.then(async () => {
    const next = { ...current, ...patch };
    await app.store.set(STORE_KEY, next);
    current = next;
    return next;
  });
  writeTail = write.then(
    () => {},
    () => {},
  );
  return write;
}
