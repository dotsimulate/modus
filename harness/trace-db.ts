/**
 * Re-exports the harness database for trace queries.
 * Separate file to avoid circular imports with db.ts.
 */

import { Database } from "bun:sqlite";
import { resolveDatabasePath } from "./database-paths";

const DB_PATH = resolveDatabasePath("harness.db");
const db = new Database(DB_PATH, { readonly: true });
db.run("PRAGMA journal_mode = WAL");

export default db;
