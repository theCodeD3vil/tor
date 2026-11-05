// SQLite store for per-day, per-app network usage (powers the 7d / 30d tabs).
import { Database } from "tjs:sqlite";
import type { DailyUsage, UsageRow } from "../shared/types";

export interface UsageDb {
  /** days >= sinceDay */
  load(sinceDay: string): DailyUsage;
  /** absolute totals; drops days before pruneBefore */
  save(rows: UsageRow[], pruneBefore: string): void;
  close(): void;
}

export function openUsageDb(path: string): UsageDb {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_usage (
      day    TEXT    NOT NULL,            -- local calendar day, YYYY-MM-DD
      app    TEXT    NOT NULL,
      down   INTEGER NOT NULL DEFAULT 0,  -- bytes received
      up     INTEGER NOT NULL DEFAULT 0,  -- bytes sent
      bundle TEXT    NOT NULL DEFAULT '', -- .app path, for the icon
      PRIMARY KEY (day, app)
    )
  `);
  const select = db.prepare("SELECT day, app, down, up, bundle FROM app_usage WHERE day >= ?");
  const upsert = db.prepare(`
    INSERT INTO app_usage (day, app, down, up, bundle) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (day, app) DO UPDATE SET down = excluded.down, up = excluded.up, bundle = excluded.bundle
  `);
  const prune = db.prepare("DELETE FROM app_usage WHERE day < ?");
  const write = db.transaction((rows: UsageRow[], pruneBefore: string) => {
    for (const r of rows) upsert.run(r.day, r.app, Math.round(r.down), Math.round(r.up), r.bundle);
    prune.run(pruneBefore);
  });

  return {
    load(sinceDay) {
      const daily: DailyUsage = {};
      for (const r of select.all(sinceDay) as UsageRow[]) {
        (daily[r.day] ??= {})[r.app] = { down: r.down, up: r.up, bundle: r.bundle };
      }
      return daily;
    },
    save(rows, pruneBefore) {
      write(rows, pruneBefore);
    },
    close() {
      db.close();
    },
  };
}
