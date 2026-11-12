import { MIGRATIONS, splitStatements } from "@/services/db/migrations";

/**
 * An in-memory SQLite database with every migration applied, shaped like the
 * `getDb()` connection, for tests that need the real schema and SQL.
 * Mock the connection module with it:
 *   vi.mock("@/services/db/connection", () => ({ getDb: async () => db, withTransaction: (fn) => fn() }))
 */
export function createTestDb() {
  // process.getBuiltinModule keeps node:sqlite away from Vite (see migrations.test.ts).
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    for (const statement of splitStatements(migration.sql)) raw.exec(statement);
  }

  // tauri-plugin-sql binds $1..$n; node:sqlite reads those as named parameters.
  const prepare = (query: string) => raw.prepare(query.replace(/\$(\d+)/g, "?$1"));
  const bind = (params: unknown[] = []) =>
    params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p)) as never[];

  return {
    raw,
    async select<T>(query: string, params?: unknown[]): Promise<T> {
      return prepare(query).all(...bind(params)) as T;
    },
    async execute(query: string, params?: unknown[]) {
      const r = prepare(query).run(...bind(params));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
}

export type TestDb = ReturnType<typeof createTestDb>;
