/**
 * Token-at-rest encryption.
 *
 * We store per-user OAuth access/refresh tokens for every downstream agent
 * the user has connected. These tokens are bearer credentials — possession
 * is authentication — so treating them like passwords is the minimum bar.
 * AES-256-GCM with a random 96-bit IV per encryption gives us:
 *
 *   - Confidentiality: a DB dump without LUMO_ENCRYPTION_KEY is useless.
 *   - Integrity: GCM authenticates; a tampered ciphertext fails to decrypt.
 *   - Cheap: node:crypto is synchronous enough for our ~single-digit-ms
 *     call sites (one encrypt per OAuth callback, one decrypt per tool
 *     dispatch).
 *
 * Key management:
 *
 *   LUMO_ENCRYPTION_KEY must be a 32-byte key, hex-encoded (64 chars).
 *   Generate with:   openssl rand -hex 32
 *   Rotate by:
 *     1. Keep old key as LUMO_ENCRYPTION_KEY_OLD.
 *     2. Set new key as LUMO_ENCRYPTION_KEY.
 *     3. Background-rewrap every active agent_connections row.
 *     4. Remove LUMO_ENCRYPTION_KEY_OLD once every row is rewrapped.
 *   For MVP, rotation means "revoke everyone and make them reconnect" —
 *   acceptable because the universe of connections is small and it's a
 *   privileged ops action anyway.
 *
 * Storage shape (see db/migrations/004_appstore.sql):
 *
 *   access_token_ciphertext  bytea
 *   access_token_iv          bytea (12 bytes)
 *   access_token_tag         bytea (16 bytes)
 *
 *   Three columns instead of one concatenated blob because it makes the
 *   encryption format explicit in the schema and lets us migrate to a
 *   different AEAD later (libsodium secretbox, KMS envelope encryption,
 *   HSM-backed) without re-encrypting existing rows.
 *
 * What this module intentionally does NOT do:
 *
 *   - No key derivation from a passphrase. If you have a passphrase, hash
 *     it to 32 bytes out-of-band and pass the hex. We don't own that flow.
 *   - No key versioning. If you rotate, you rewrap everything (see above).
 *   - No streaming encryption. Tokens are always < a few KB; buffer everything.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// AES-256-GCM. 12-byte IV (the recommended size), 16-byte auth tag (default).
const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Read the key from env on first call, validate it, cache it. We avoid
 * re-reading on every call so a misconfigured env surfaces once at boot
 * (via the first encrypt/decrypt attempt), not on every dispatch.
 */
let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.LUMO_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "[crypto] LUMO_ENCRYPTION_KEY is not set. Generate with " +
        "`openssl rand -hex 32` and set it as an environment variable. " +
        "Do not commit the value. Do not share it across environments.",
    );
  }

  // Accept hex (64 chars) — reject anything else so a base64 or utf8 key
  // doesn't silently give us a 32-char key that AES-256 will reject at
  // cipher creation time (less-obvious error).
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "[crypto] LUMO_ENCRYPTION_KEY must be a 64-character hex string " +
        "(32 bytes). Generate with `openssl rand -hex 32`.",
    );
  }

  cachedKey = Buffer.from(raw, "hex");
  if (cachedKey.length !== KEY_BYTES) {
    throw new Error(
      `[crypto] LUMO_ENCRYPTION_KEY decoded to ${cachedKey.length} bytes, expected ${KEY_BYTES}.`,
    );
  }
  return cachedKey;
}

/**
 * Encrypt a plaintext string (typically an OAuth token). Returns the three
 * components the DB layer persists. Random IV per call — never reuse an IV
 * with the same key; GCM's security guarantees collapse if you do.
 */
export function seal(plaintext: string): SealedSecret {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("[crypto] seal() called with empty/non-string plaintext.");
  }
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    // Belt & braces — GCM always returns 16 unless you override it, but
    // we never override it.
    throw new Error(`[crypto] unexpected auth tag length: ${tag.length}`);
  }
  return { ciphertext, iv, tag };
}

/**
 * Decrypt. Throws if the ciphertext was tampered with or the key is wrong.
 * Callers MUST NOT swallow this error and fall back to plaintext — that
 * would nullify authenticity. Let the error propagate to a 500; the user
 * will be prompted to reconnect if the error was "this agent's token is
 * corrupt in our DB" rather than "your session is invalid".
 */
export function open(sealed: SealedSecret): string {
  const { ciphertext, iv, tag } = sealed;
  if (iv.length !== IV_BYTES) {
    throw new Error(`[crypto] invalid IV length: ${iv.length}, expected ${IV_BYTES}.`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`[crypto] invalid auth tag length: ${tag.length}, expected ${TAG_BYTES}.`);
  }
  const key = getKey();
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Constant-time string comparison for things like OAuth state values and
 * PKCE verifiers where a timing leak could help an attacker. Zero-pads
 * to the longer length so `timingSafeEqual` doesn't throw on mismatched
 * lengths (which itself is a timing signal).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const len = Math.max(ab.length, bb.length);
  const ap = Buffer.alloc(len);
  const bp = Buffer.alloc(len);
  ab.copy(ap);
  bb.copy(bp);
  // Still an XOR-based compare — length mismatch returns false, which is
  // what we want, but the comparison itself runs in constant time over
  // the padded buffers.
  const eq = timingSafeEqual(ap, bp);
  return eq && ab.length === bb.length;
}

/**
 * PKCE helpers. RFC 7636. We generate a 64-char verifier (256 bits of
 * entropy at 4 bits per hex char) and its S256 challenge.
 *
 * The verifier is stored server-side in oauth_states; the challenge is
 * sent on the authorize URL. On callback, the agent proves it received
 * the original authorize by echoing the code, and we prove the session
 * by sending the verifier — the agent recomputes S256(verifier) and
 * checks it equals the challenge it saw at authorize time.
 */
import { createHash } from "node:crypto";

export function mintCodeVerifier(): string {
  // 32 random bytes → 43-char base64url. That's well within the 43..128
  // allowed range per RFC 7636.
  return base64url(randomBytes(32));
}

export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint an opaque OAuth `state` value. Not a JWT — we don't need to carry
 * claims; the DB row holds everything. Just needs to be unguessable and
 * single-use.
 */
export function mintOAuthState(): string {
  return base64url(randomBytes(24));
}

/**
 * Mint a random connection id. Prefixed so logs and tests can spot them.
 */
export function mintConnectionId(): string {
  return `conn_${base64url(randomBytes(12))}`;
}

/**
 * Test hook — lets tests swap the cached key. Never exported from a
 * public path.
 */
export function __resetCryptoForTesting(): void {
  cachedKey = null;
}
