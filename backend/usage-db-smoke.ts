// Run with `tjs bundle --external:tjs:* backend/usage-db-smoke.ts /path/to/smoke.mjs`
// and then `tjs run /path/to/smoke.mjs`, without touching the app's database.
import { Database } from "tjs:sqlite";
import { openUsageDb } from "./db";

const DAY = "2026-11-20";
const root = await tjs.makeTempDir(`${tjs.tmpDir}/tor-db-smoke-XXXXXX`);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function oldDatabase(path: string, bundle: "NULL" | "''"): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE app_usage (day TEXT, app TEXT, down INTEGER, up INTEGER, bundle TEXT, PRIMARY KEY(day, app));
    INSERT INTO app_usage VALUES ('${DAY}', 'Example', 5, 2, ${bundle});
  `);
  db.close();
}

try {
  const good = `${root}/migrate.db`;
  oldDatabase(good, "''");
  const db = openUsageDb(good);
  assert(db.load(DAY)[DAY].Example.down === 5, "legacy usage was lost");
  db.save([{ day: DAY, app: "Example", bundle: "/Example.app", down: 5, up: 2 }], DAY, [
    { day: DAY, app: "Example", bundle: "" },
  ]);
  const rows = db.load(DAY)[DAY];
  assert(!rows.Example && rows["/Example.app"].up === 2, "removal crossed bundle identities");
  db.close();

  const bad = `${root}/rollback.db`;
  oldDatabase(bad, "NULL");
  let rejected = false;
  try {
    openUsageDb(bad).close();
  } catch {
    rejected = true;
  }
  assert(rejected, "invalid legacy row should fail migration");
  const legacy = new Database(bad);
  const stmt = legacy.prepare("SELECT app FROM app_usage");
  assert(stmt.all().length === 1, "the original table did not survive rollback");
  stmt.finalize();
  const staging = legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'app_usage_v2'");
  assert(staging.all().length === 0, "failed migration left a staging table");
  staging.finalize();
  legacy.close();
  console.log("Tor SQLite migration and rollback passed");
} finally {
  await tjs.remove(root);
}
