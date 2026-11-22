import { expect, test, vi } from "vite-plus/test";

vi.mock("tjs:ffi", () => ({ dlopen: () => ({ symbols: {} }) }));
vi.mock("tjs:sqlite", () => ({ Database: class {} }));

test("page calls without parameters fall back instead of throwing", async () => {
  vi.stubGlobal("tjs", { homeDir: "/Users/test", exePath: "/usr/local/bin/tor" });
  try {
    const { api } = await import("../backend/main");
    const app = {} as Parameters<(typeof api)[string]>[1];
    for (const params of [undefined, null, "today", { period: "forever", days: 12 }]) {
      expect(() => api.setPage(params, app)).not.toThrow();
      expect(() => api.setAppsPeriod(params, app)).not.toThrow();
      expect(await api.getApps(params, app)).toEqual({ period: "today", apps: [] });
      expect(await api.getStats(params, app)).toMatchObject({ days: [], avgPerDay: 0 });
    }
    expect(await api.getApps({ period: "7d" }, app)).toEqual({ period: "7d", apps: [] });
  } finally {
    vi.unstubAllGlobals();
  }
});
