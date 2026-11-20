// SQLite store for per-day, per-app network usage (powers the 7d / 30d tabs).
import { Database } from "tjs:sqlite";
import type { DailyUsage, UsageRow } from "../shared/types";

export interface UsageDb {
  /** days >= sinceDay */
  load(sinceDay: string): DailyUsage;
  /** absolute totals; drops days before pruneBefore, and the rows in `remove` */
  save(
    rows: UsageRow[],
    pruneBefore: string,
    remove?: { day: string; app: string; bundle: string }[],
  ): void;
  close(): void;
}

const schema = (table: "app_usage" | "app_usage_v2"): string => `
  CREATE TABLE ${table} (
    day    TEXT    NOT NULL,            -- local calendar day, YYYY-MM-DD
    app    TEXT    NOT NULL,
    down   INTEGER NOT NULL DEFAULT 0,  -- bytes received
    up     INTEGER NOT NULL DEFAULT 0,  -- bytes sent
    bundle TEXT    NOT NULL DEFAULT '', -- .app path, for the icon
    PRIMARY KEY (day, app, bundle)
  )
`;

export function openUsageDb(path: string): UsageDb {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  try {
    db.transaction(() => {
      const info = db.prepare("PRAGMA table_info(app_usage)");
      const columns = info.all() as { name: string; pk: number }[];
      info.finalize();
      if (!columns.length) db.exec(schema("app_usage"));
      else if (columns.find((col) => col.name === "bundle")?.pk !== 3) {
        // Distinct bundles may have the same app name. Roll back if the copy
        // or any of the schema changes fail.
        db.exec(`
          ${schema("app_usage_v2")};
          INSERT INTO app_usage_v2 (day, app, down, up, bundle)
            SELECT day, app, down, up, bundle FROM app_usage;
          DROP TABLE app_usage;
          ALTER TABLE app_usage_v2 RENAME TO app_usage;
        `);
      }
    })();
  } catch (err) {
    db.close();
    throw err;
  }
  const select = db.prepare("SELECT day, app, down, up, bundle FROM app_usage WHERE day >= ?");
  const upsert = db.prepare(`
    INSERT INTO app_usage (day, app, down, up, bundle) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (day, app, bundle) DO UPDATE SET down = excluded.down, up = excluded.up
  `);
  const prune = db.prepare("DELETE FROM app_usage WHERE day < ?");
  const removeBundle = db.prepare("DELETE FROM app_usage WHERE day = ? AND app = ? AND bundle = ?");
  const write = db.transaction(
    (
      rows: UsageRow[],
      pruneBefore: string,
      gone: { day: string; app: string; bundle: string }[],
    ) => {
      for (const r of rows)
        upsert.run(r.day, r.app, Math.round(r.down), Math.round(r.up), r.bundle);
      for (const g of gone) removeBundle.run(g.day, g.app, g.bundle);
      prune.run(pruneBefore);
    },
  );

  return {
    load(sinceDay) {
      const daily = Object.create(null) as DailyUsage;
      for (const r of select.all(sinceDay) as UsageRow[]) {
        const id = r.bundle || r.app;
        (daily[r.day] ??= Object.create(null) as DailyUsage[string])[id] = {
          down: r.down,
          up: r.up,
          bundle: r.bundle,
          name: r.app,
        };
      }
      return daily;
    },
    save(rows, pruneBefore, remove = []) {
      write(rows, pruneBefore, remove);
    },
    close() {
      for (const stmt of [select, upsert, prune, removeBundle]) stmt.finalize();
      db.close();
    },
  };
}
