import { base64UrlEncode } from "./base64url";

/** PKCE code verifier (RFC 7636 §4.1): 32 random bytes, base64url. */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/** PKCE S256 code challenge (RFC 7636 §4.2). */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
