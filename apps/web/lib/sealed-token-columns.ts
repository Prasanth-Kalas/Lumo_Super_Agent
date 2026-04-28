import { open, seal, type SealedSecret } from "./crypto.js";

export type PgByteaInput = Buffer | Uint8Array | string;

export function sealToPgColumns(
  plaintext: string,
  prefix: string,
): Record<string, string> {
  const sealed = seal(plaintext);
  return {
    [`${prefix}_ciphertext`]: bufferToPgEscape(sealed.ciphertext),
    [`${prefix}_iv`]: bufferToPgEscape(sealed.iv),
    [`${prefix}_tag`]: bufferToPgEscape(sealed.tag),
  };
}

export function openFromPgColumns(
  row: Record<string, unknown>,
  prefix: string,
): string {
  const ciphertext = row[`${prefix}_ciphertext`];
  const iv = row[`${prefix}_iv`];
  const tag = row[`${prefix}_tag`];

  if (!isPgByteaInput(ciphertext) || !isPgByteaInput(iv) || !isPgByteaInput(tag)) {
    throw new Error(`Row is missing ${prefix} sealed-token columns.`);
  }

  return open(toSealed(ciphertext, iv, tag));
}

function toSealed(
  ciphertext: PgByteaInput,
  iv: PgByteaInput,
  tag: PgByteaInput,
): SealedSecret {
  return {
    ciphertext: coerceBytes(ciphertext),
    iv: coerceBytes(iv),
    tag: coerceBytes(tag),
  };
}

function bufferToPgEscape(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}

function coerceBytes(v: PgByteaInput): Buffer {
  if (typeof v === "string") {
    const hex = v.startsWith("\\x") ? v.slice(2) : v;
    return Buffer.from(hex, "hex");
  }
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function isPgByteaInput(v: unknown): v is PgByteaInput {
  return typeof v === "string" || Buffer.isBuffer(v) || v instanceof Uint8Array;
}
