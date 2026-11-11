import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/sqliteDb";

let db: TestDb;
vi.mock("./connection", () => ({ getDb: async () => db }));

import { getAiCache, setAiCache } from "./aiCache";

describe("AI cache and a thread that grows", () => {
  const now = Math.floor(Date.now() / 1000);
  const addMessage = (id: string, dateSeconds: number) =>
    db.raw
      .prepare("INSERT INTO messages (id, account_id, thread_id, date) VALUES (?, 'acc-1', 't1', ?)")
      .run(id, dateSeconds * 1000);

  beforeEach(async () => {
    db = createTestDb();
    db.raw.exec(`
      INSERT INTO accounts (id, email) VALUES ('acc-1', 'me@example.com');
      INSERT INTO threads (id, account_id) VALUES ('t1', 'acc-1');
    `);
    addMessage("m1", now - 3600);
    await setAiCache("acc-1", "t1", "summary_de", "old summary");
    db.raw.exec(`UPDATE ai_cache SET created_at = ${now - 600}`);
  });

  it("serves the cached answer while no newer message arrived", async () => {
    expect(await getAiCache("acc-1", "t1", "summary_de")).toBe("old summary");
  });

  it("does not serve an answer older than the thread's newest message", async () => {
    addMessage("m2", now - 60);

    expect(await getAiCache("acc-1", "t1", "summary_de")).toBeNull();
  });
});
