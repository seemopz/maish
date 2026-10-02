import { describe, it, expect } from "vitest";
import { generateCodeChallenge, generateCodeVerifier } from "./pkce";

describe("pkce", () => {
  it("derives the S256 challenge from RFC 7636 appendix B", async () => {
    const challenge = await generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a 43-character base64url verifier, different each time", () => {
    const a = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeVerifier()).not.toBe(a);
  });
});
