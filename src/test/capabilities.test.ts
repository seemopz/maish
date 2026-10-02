import { readFileSync } from "fs";
import path from "path";

type Permission = string | { identifier: string; allow?: { url: string }[] };

describe("default capability", () => {
  it("keeps the http plugin scope to https and loopback", () => {
    const file = path.resolve(__dirname, "../../src-tauri/capabilities/default.json");
    const caps = JSON.parse(readFileSync(file, "utf8")) as { permissions: Permission[] };
    const http = caps.permissions.find(
      (p): p is Exclude<Permission, string> => typeof p !== "string" && p.identifier === "http:default",
    );

    // Plugin requests bypass the webview CSP, so this list is the only gate.
    expect(http?.allow?.map((e) => e.url)).toEqual([
      "https://*",
      "http://localhost:*",
      "http://127.0.0.1:*",
    ]);
  });
});
