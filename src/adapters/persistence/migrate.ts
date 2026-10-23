import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export async function applyMigrations(
  pool: Pool,
  sqlPath?: string,
): Promise<void> {
  const filePath =
    sqlPath ?? path.resolve(process.cwd(), "db/migrations/001_init.sql");
  const sql = await readFile(filePath, "utf8");
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await pool.query(statement);
  }
}
