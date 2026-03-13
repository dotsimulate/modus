/**
 * Re-exports the harness database for trace queries.
 * Separate file to avoid circular imports with db.ts.
 */

import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "harness.db");
const db = new Database(DB_PATH, { readonly: true });
db.run("PRAGMA journal_mode = WAL");

export default db;
