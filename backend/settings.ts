// Settings live in memory for synchronous reads (every tray repaint) and are
// written through to tinyjs's store.
import { defaultSettings, pickSettings, type Settings } from "../shared/settings";

const STORE_KEY = "settings";

let current: Settings = { ...defaultSettings };

export async function loadSettings(app: TinyApp): Promise<void> {
  current = { ...defaultSettings, ...pickSettings(await app.store.get(STORE_KEY)) };
}

export function getSettings(): Settings {
  return current;
}

/** apply a partial change, persist it and return the new settings */
export async function updateSettings(changes: unknown, app: TinyApp): Promise<Settings> {
  current = { ...current, ...pickSettings(changes) };
  await app.store.set(STORE_KEY, current);
  return current;
}
