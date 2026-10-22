import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The pooled handle tauri-plugin-sql hands out, and the dedicated connection
// behind the db_tx_* commands. Both are recorded so a test can tell which of
// the two a statement went to.
const { pooledExecute, pooledSelect, invoke } = vi.hoisted(() => ({
  pooledExecute: vi.fn(),
  pooledSelect: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(() => Promise.resolve({ execute: pooledExecute, select: pooledSelect })),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { MIGRATIONS, runMigrations, splitStatements } from "./migrations";

describe("splitStatements", () => {
  it("splits simple statements", () => {
    const result = splitStatements("CREATE TABLE foo (id INT); CREATE TABLE bar (id INT);");
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("CREATE TABLE foo (id INT)");
    expect(result[1]).toBe("CREATE TABLE bar (id INT)");
  });

  it("keeps trigger body intact", () => {
    const sql = `
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, subject) VALUES (new.rowid, new.subject);
      END;
    `;
    const result = splitStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("BEGIN");
    expect(result[0]).toContain("END");
    expect(result[0]).toContain("INSERT INTO messages_fts");
  });

  it("handles multiple triggers", () => {
    const sql = `
      CREATE TABLE foo (id INT);

      CREATE TRIGGER t1 AFTER INSERT ON foo BEGIN
        INSERT INTO bar VALUES (new.id);
      END;

      CREATE TRIGGER t2 AFTER DELETE ON foo BEGIN
        DELETE FROM bar WHERE id = old.id;
      END;
    `;
    const result = splitStatements(sql);
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("CREATE TABLE");
    expect(result[1]).toContain("CREATE TRIGGER t1");
    expect(result[2]).toContain("CREATE TRIGGER t2");
  });

  it("handles trigger with multiple statements inside BEGIN...END", () => {
    const sql = `
      CREATE TRIGGER t1 AFTER UPDATE ON messages BEGIN
        INSERT INTO fts(fts, rowid, subject) VALUES ('delete', old.rowid, old.subject);
        INSERT INTO fts(rowid, subject) VALUES (new.rowid, new.subject);
      END;
    `;
    const result = splitStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("BEGIN");
    expect(result[0]).toContain("END");
  });

  it("handles empty input", () => {
    expect(splitStatements("")).toHaveLength(0);
    expect(splitStatements("   ")).toHaveLength(0);
  });

  it("does not match END inside words like BACKEND", () => {
    const sql = "CREATE TABLE backend (id INT); CREATE TABLE foo (id INT);";
    const result = splitStatements(sql);
    expect(result).toHaveLength(2);
  });

  it("ignores a semicolon inside a line comment", () => {
    // Splitting here tears the statement apart mid-sentence and leaves prose
    // where SQL is expected, which fails the whole migration.
    const sql = `
      -- one column; and another
      ALTER TABLE events ADD COLUMN rrule TEXT;
    `;
    const result = splitStatements(sql);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("ALTER TABLE events ADD COLUMN rrule TEXT");
  });

  it("ignores a semicolon inside a string literal", () => {
    const sql = "INSERT INTO settings VALUES ('a;b'); SELECT 1;";
    const result = splitStatements(sql);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe("INSERT INTO settings VALUES ('a;b')");
  });
});

/**
 * A migration that fails takes the whole startup with it: runMigrations()
 * rethrows, so App.tsx never reaches the point where accounts are loaded and
 * the app comes up empty. The statements therefore have to be checked here
 * rather than on a user's database.
 */
describe("the migrations themselves", () => {
  const SQL_KEYWORDS = /^(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|PRAGMA|REPLACE|WITH|SELECT)\b/i;

  it("splits every migration into executable statements", () => {
    for (const migration of MIGRATIONS) {
      for (const statement of splitStatements(migration.sql)) {
        const code = statement
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim();
        if (code.length === 0) continue;

        expect(
          code,
          `v${migration.version} (${migration.description}) produced a statement that is not SQL`,
        ).toMatch(SQL_KEYWORDS);
      }
    }
  });

  it("numbers migrations consecutively", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
  });
});

/**
 * tauri-plugin-sql runs every execute() on whichever pooled connection is free,
 * so a BEGIN sent through it opens a transaction on one connection while the
 * statements and the COMMIT land on others. The one holding BEGIN keeps the
 * write lock, and every later write fails with SQLITE_BUSY once its timeout
 * runs out — on a fresh database that is the first account the user adds.
 */
describe("runMigrations", () => {
  /** A database on which exactly these versions have been applied. */
  function databaseWithApplied(versions: number[]) {
    pooledSelect.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM _migrations")) return versions.map((version) => ({ version }));
      if (sql.includes("sqlite_master")) return [{ name: "tasks" }];
      return [];
    });
  }

  const allButLast = () => MIGRATIONS.slice(0, -1).map((m) => m.version);
  const commands = () => invoke.mock.calls.map(([command]) => command as string);

  beforeEach(() => {
    vi.clearAllMocks();
    pooledExecute.mockResolvedValue({ rowsAffected: 0, lastInsertId: 0 });
    invoke.mockResolvedValue(undefined);
    databaseWithApplied([]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never opens a transaction on the pooled connection", async () => {
    await runMigrations();

    const transactionControl = pooledExecute.mock.calls
      .map(([sql]) => String(sql).trim())
      .filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE)\b/i.test(sql));

    expect(transactionControl).toEqual([]);
  });

  it("applies a pending migration and records it in one dedicated transaction", async () => {
    databaseWithApplied(allButLast());

    await runMigrations();

    const sent = commands();
    expect(sent[0]).toBe("db_tx_begin");
    expect(sent[sent.length - 1]).toBe("db_tx_commit");
    expect(sent.filter((command) => command === "db_tx_begin")).toHaveLength(1);

    // The migration's own statements, then the row that marks it applied. If
    // the record were written outside the transaction, a crash between the two
    // would leave a migration that is applied but runs again.
    const statements = sent.slice(1, -1);
    expect(statements.length).toBeGreaterThan(1);
    expect(new Set(statements)).toEqual(new Set(["db_tx_execute"]));

    const pending = MIGRATIONS[MIGRATIONS.length - 1]!;
    const [, record] = invoke.mock.calls[invoke.mock.calls.length - 2]!;
    expect(record.sql).toContain("INTO _migrations");
    expect(record.params).toEqual([pending.version, pending.description]);
  });

  it("rolls back and rethrows when a statement fails", async () => {
    databaseWithApplied(allButLast());
    // invoke() rejects with the string the Rust command returned, not an Error.
    invoke.mockImplementation(async (command: string) => {
      if (command === "db_tx_execute") {
        throw 'db_tx: execute failed: error returned from database: (code: 1) near "TABEL": syntax error';
      }
    });

    await expect(runMigrations()).rejects.toMatch(/syntax error/);

    expect(commands()).toEqual(["db_tx_begin", "db_tx_execute", "db_tx_rollback"]);
  });

  it("carries on past a column an earlier, interrupted run already added", async () => {
    databaseWithApplied(allButLast());
    let failed = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "db_tx_execute" && !failed) {
        failed = true;
        throw "db_tx: execute failed: error returned from database: (code: 1) duplicate column name: rrule";
      }
    });

    await runMigrations();

    const sent = commands();
    expect(sent).not.toContain("db_tx_rollback");
    expect(sent[sent.length - 1]).toBe("db_tx_commit");
  });

  it("applies a migration once when two callers start together", async () => {
    // React's StrictMode runs the startup effect twice in a development build.
    // Both callers read _migrations before either has written to it, so a
    // second run repeats what the first committed and fails on the first
    // statement that is not idempotent.
    databaseWithApplied(allButLast());

    await Promise.all([runMigrations(), runMigrations()]);

    expect(commands().filter((command) => command === "db_tx_begin")).toHaveLength(1);
  });

  it("starts over on the next call after a run that failed", async () => {
    databaseWithApplied(allButLast());
    invoke.mockImplementation(async (command: string) => {
      if (command === "db_tx_execute") throw "db_tx: execute failed: disk I/O error";
    });
    await expect(runMigrations()).rejects.toMatch(/disk I\/O error/);

    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    await runMigrations();

    const sent = commands();
    expect(sent[sent.length - 1]).toBe("db_tx_commit");
  });
});

/**
 * SQLite resolves an upsert's conflict target against the declared unique
 * constraints and rejects the statement at prepare time when none matches:
 * "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
 * That is a hard error on the write path, not a slow query, and nothing in the
 * type system connects a query in a db module to the schema in this file — so
 * the two are compared here.
 */
describe("upsert conflict targets", () => {
  const DB_DIR = "src/services/db";

  /** Column tuples the migrations declare unique, per table. */
  function declaredUniques(sql: string): Map<string, Set<string>> {
    const uniques = new Map<string, Set<string>>();
    const add = (table: string, columns: string) => {
      const key = columns
        .split(",")
        .map((c) => c.trim().replace(/["`[\]]/g, ""))
        .filter(Boolean)
        .join(",");
      if (!uniques.has(table)) uniques.set(table, new Set());
      uniques.get(table)!.add(key);
    };

    const createTable = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\s*\);/g;
    for (const [, table, body] of sql.matchAll(createTable)) {
      for (const [, cols] of body.matchAll(/\bUNIQUE\s*\(([^)]*)\)/gi)) add(table, cols);
      for (const [, cols] of body.matchAll(/\bPRIMARY KEY\s*\(([^)]*)\)/gi)) add(table, cols);
      for (const line of body.split("\n")) {
        // A constraint written on the column itself rather than as a table clause.
        const inline = line.match(/^\s*(\w+)\s+[\w()]+.*\b(?:PRIMARY KEY|UNIQUE)\b/i);
        if (inline) add(table, inline[1]!);
      }
    }

    const uniqueIndex =
      /CREATE UNIQUE INDEX (?:IF NOT EXISTS )?\w+\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
    for (const [, table, cols] of sql.matchAll(uniqueIndex)) add(table!, cols!);

    return uniques;
  }

  it("backs every ON CONFLICT target with a unique constraint", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const uniques = declaredUniques(
      MIGRATIONS.map((migration) => migration.sql).join("\n"),
    );

    const upsert = /INSERT (?:OR \w+ )?INTO\s+(\w+)[\s\S]{0,600}?ON CONFLICT\s*\(([^)]*)\)/gi;
    const unbacked: string[] = [];

    for (const file of readdirSync(DB_DIR)) {
      if (!file.endsWith(".ts") || file.includes(".test.") || file === "migrations.ts") {
        continue;
      }
      const source = readFileSync(join(DB_DIR, file), "utf8");
      for (const [, table, columns] of source.matchAll(upsert)) {
        const target = columns!
          .split(",")
          .map((c) => c.trim())
          .join(",");
        if (!uniques.get(table!)?.has(target)) {
          unbacked.push(`${file}: ON CONFLICT(${target}) on ${table}`);
        }
      }
    }

    expect(unbacked).toEqual([]);
  });
});

describe("v27 Copilot removal", () => {
  function runV27(rows: [string, string][]): unknown[] {
    // process.getBuiltinModule keeps node:sqlite away from Vite, which cannot
    // bundle it under Node 22 (CI).
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of rows) insert.run(key, value);

    const v27 = MIGRATIONS.find((m) => m.version === 27)!;
    for (const statement of splitStatements(v27.sql)) db.exec(statement);
    return db.prepare("SELECT key, value FROM settings ORDER BY key").all();
  }

  it("drops the Copilot token and model and turns AI off instead of switching to Claude", () => {
    expect(
      runV27([
        ["ai_provider", "copilot"],
        ["ai_enabled", "true"],
        ["copilot_api_key", "enc:ciphertext"],
        ["copilot_model", "openai/gpt-4o"],
        ["claude_api_key", "enc:other"],
      ]),
    ).toEqual([
      { key: "ai_enabled", value: "false" },
      { key: "claude_api_key", value: "enc:other" },
    ]);
  });

  it("turns AI off for a Copilot user who never stored ai_enabled", () => {
    expect(runV27([["ai_provider", "copilot"]])).toEqual([{ key: "ai_enabled", value: "false" }]);
  });

  it("leaves another provider and its AI switch alone", () => {
    expect(
      runV27([
        ["ai_provider", "openai"],
        ["ai_enabled", "true"],
        ["copilot_api_key", "enc:stale"],
      ]),
    ).toEqual([
      { key: "ai_enabled", value: "true" },
      { key: "ai_provider", value: "openai" },
    ]);
  });
});
