// Update checks: on demand from Settings, and on a schedule when automatic checks are on.
import type { UpdateFrequency } from "../shared/settings";
import type { UpdateProgress, UpdateStatus } from "../shared/types";
import { getSettings } from "./settings";

const STATE_KEY = "updateState";
const HOUR_MS = 60 * 60 * 1000;
const FREQUENCY_MS: Record<UpdateFrequency, number> = {
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
  monthly: 30 * 24 * HOUR_MS,
};

let status: UpdateStatus = {
  state: "idle",
  current: "",
  latest: null,
  notes: null,
  lastChecked: null,
};
let notifiedVersion: string | null = null;

// a dev run has no .app to replace (tinyjs's own updater makes the same check)
const isInstalledApp = (): boolean => tjs.exePath.includes(".app/Contents/MacOS/");

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export async function loadUpdateState(app: TinyApp): Promise<void> {
  const saved = (await app.store.get(STATE_KEY)) as { lastChecked?: number } | null;
  status = {
    ...status,
    current: (await app.info()).version,
    lastChecked: typeof saved?.lastChecked === "number" ? saved.lastChecked : null,
  };
}

/** look for a newer version; `manual` checks never notify, the page shows the result */
export async function checkForUpdates(
  app: TinyApp,
  manual: boolean,
  onStatus: (status: UpdateStatus) => void,
): Promise<UpdateStatus> {
  if (!isInstalledApp()) {
    status = { ...status, state: "unsupported" };
    return status;
  }
  try {
    const result = await app.update.check();
    status = {
      state: result.available && result.latest ? "available" : "up-to-date",
      current: result.current,
      latest: result.latest,
      notes: result.notes,
      lastChecked: Date.now(),
    };
    await app.store.set(STATE_KEY, { lastChecked: status.lastChecked });
    if (!manual && status.state === "available" && notifiedVersion !== status.latest) {
      notifiedVersion = status.latest;
      void app.notify("Tor update available", `Tor ${status.latest} is ready to install`);
    }
  } catch {
    // offline, the release server is down, or no update URL is configured
    status = { ...status, state: "error" };
  }
  onStatus(status);
  return status;
}

// A push per chunk would flood the page on a fast connection
const PROGRESS_INTERVAL_MS = 100;

/** Count the download's bytes as update.install() reads them. */
function trackDownload(response: Response, onProgress: (progress: UpdateProgress) => void): void {
  const total = Number(response.headers.get("content-length")) || null;
  let received = 0;
  let lastSentAt = 0;
  const countedBody = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        // performance.now() only moves forward; with Date.now(), setting the
        // Mac's clock back would stop progress until it caught up again
        if (performance.now() - lastSentAt >= PROGRESS_INTERVAL_MS) {
          lastSentAt = performance.now();
          onProgress({ received, total });
        }
        controller.enqueue(chunk);
      },
      // everything has arrived, so the size is known even without a header
      flush() {
        onProgress({ received, total: received });
      },
    }),
  );
  // update.install() reads the whole download with arrayBuffer()
  response.arrayBuffer = () => new Response(countedBody).arrayBuffer();
}

// The archive is told by the name of what came back, not by the URL asked for:
// update.install() follows redirects one hop at a time, and GitHub answers the .zip URL
// with an empty 302 to a signed blob URL (a bare path plus a query string) that carries
// the bytes. Only that final, successful hop is worth counting.
export function isUpdateArchive(url: string, response: Response): boolean {
  if (!response.ok || !response.body) return false;
  const disposition = response.headers.get("content-disposition") ?? "";
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition)?.[1];
  let name = named ?? "";
  if (!name) {
    try {
      name = new URL(url).pathname.split("/").pop() ?? "";
    } catch {
      name = url;
    }
  }
  try {
    name = decodeURIComponent(name);
  } catch {
    // leave it as sent
  }
  return /\.(zip|tar\.gz|tgz)$/i.test(name);
}

/** report the bytes of every update archive fetched until the returned function is called */
export function watchDownloads(onProgress: (progress: UpdateProgress) => void): () => void {
  // update.install() reports no progress, but it downloads through the global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isUpdateArchive(url, response)) trackDownload(response, onProgress);
    return response;
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** download the update and relaunch into it */
export async function installUpdate(
  app: TinyApp,
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  const unwatch = watchDownloads(onProgress);
  try {
    await app.update.install();
  } finally {
    unwatch();
  }
}

/** Check when a check is due (at launch, then hourly: a menubar app can stay open for
 *  weeks). Due = automatic checks are on and the chosen frequency has passed. */
export function startCheckingForUpdates(
  app: TinyApp,
  onStatus: (status: UpdateStatus) => void,
): void {
  const checkIfDue = (): void => {
    const { autoUpdates, updateFrequency } = getSettings();
    if (!autoUpdates) return;
    const due =
      status.lastChecked === null ||
      Date.now() - status.lastChecked >= FREQUENCY_MS[updateFrequency];
    if (due) void checkForUpdates(app, false, onStatus);
  };
  checkIfDue();
  setInterval(checkIfDue, HOUR_MS);
}
