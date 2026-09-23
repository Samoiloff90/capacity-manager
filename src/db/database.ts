import Database from "@tauri-apps/plugin-sql";

const DATABASE_URL = "sqlite:capacity.db";

let dbPromise: Promise<Database> | null = null;

export function getDatabase() {
  dbPromise ??= Database.load(DATABASE_URL);
  return dbPromise;
}

export function nowIso() {
  return new Date().toISOString();
}

