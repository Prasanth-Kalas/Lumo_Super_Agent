#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertValidMerchantManifest } from "../manifest.js";

export interface SubmitSigningMaterial {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprintSha256: string;
}

export interface SignedBundlePayload {
  key_id: string;
  public_key_pem: string;
  fingerprint_sha256: string;
  bundle_sha256: string;
  signature: string;
}

const KEYCHAIN_SERVICE = "com.lumo.agent-sdk.signing-key";

export function canonicalBundleSigningPayload(args: {
  agentId: string;
  version: string;
  bundleSha256: string;
}): string {
  return `lumo-agent-bundle:v1:${args.agentId}:${args.version}:${args.bundleSha256}`;
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem.replace(/\s+/g, "")).digest("hex");
}

export function keyIdForFingerprint(fingerprintSha256: string): string {
  return `p256:${fingerprintSha256.slice(0, 16)}`;
}

export function generateSigningMaterial(): SubmitSigningMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  }) as { privateKey: KeyObject; publicKey: KeyObject };
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprintSha256 = fingerprintPublicKey(publicKeyPem);
  return {
    keyId: keyIdForFingerprint(fingerprintSha256),
    publicKeyPem,
    privateKeyPem,
    fingerprintSha256,
  };
}

export function signBundle(args: {
  agentId: string;
  version: string;
  bundleBytes: Uint8Array;
  material: SubmitSigningMaterial;
}): SignedBundlePayload {
  const bundleSha256 = createHash("sha256").update(args.bundleBytes).digest("hex");
  const payload = canonicalBundleSigningPayload({
    agentId: args.agentId,
    version: args.version,
    bundleSha256,
  });
  const signer = createSign("sha256");
  signer.update(payload);
  signer.end();
  return {
    key_id: args.material.keyId,
    public_key_pem: args.material.publicKeyPem,
    fingerprint_sha256: args.material.fingerprintSha256,
    bundle_sha256: bundleSha256,
    signature: signer.sign(args.material.privateKeyPem).toString("base64url"),
  };
}

export function loadOrCreateSigningMaterial(): SubmitSigningMaterial {
  const existing = readPrivateKeyFromKeychain();
  if (existing) return materialFromPrivateKey(existing);

  const material = generateSigningMaterial();
  if (!writePrivateKeyToKeychain(material.privateKeyPem, material.keyId)) {
    writePrivateKeyFallback(material);
  }
  return material;
}

function materialFromPrivateKey(privateKeyPem: string): SubmitSigningMaterial {
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const fingerprintSha256 = fingerprintPublicKey(publicKeyPem);
  return {
    keyId: keyIdForFingerprint(fingerprintSha256),
    publicKeyPem,
    privateKeyPem,
    fingerprintSha256,
  };
}

function readPrivateKeyFromKeychain(): string | null {
  if (platform() !== "darwin") return readPrivateKeyFallback();
  const result = spawnSync("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ], { encoding: "utf8" });
  if (result.status !== 0) return readPrivateKeyFallback();
  const value = result.stdout.trim();
  return value.includes("BEGIN PRIVATE KEY") ? value : null;
}

function writePrivateKeyToKeychain(privateKeyPem: string, keyId: string): boolean {
  if (platform() !== "darwin") return false;
  const result = spawnSync("security", [
    "add-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    keyId,
    "-w",
    privateKeyPem,
    "-U",
  ], { encoding: "utf8" });
  return result.status === 0;
}

function fallbackKeyPath(): string {
  return join(homedir(), ".config", "lumo", "agent-keys", "author-p256.pem");
}

function readPrivateKeyFallback(): string | null {
  const path = fallbackKeyPath();
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`unsafe_key_file_permissions:${path}`);
  }
  return readFileSync(path, "utf8");
}

function writePrivateKeyFallback(material: SubmitSigningMaterial): void {
  const path = fallbackKeyPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, material.privateKeyPem, { mode: 0o600 });
}

async function main(): Promise<void> {
  const [, , command, ...rawArgs] = process.argv;
  const kindIndex = rawArgs.indexOf("--kind=merchant-of-record");
  const kind = kindIndex >= 0 ? "merchant_of_record" : "oauth_as_user";
  const args = rawArgs.filter((arg) => arg !== "--kind=merchant-of-record");
  const [manifestPathArg, bundlePathArg] = args;
  if (command !== "submit" && command !== "sign") {
    console.error("Usage: lumo-agent sign [--kind=merchant-of-record] <manifest.json> <bundle.tar.gz>");
    process.exit(2);
  }
  if (!manifestPathArg || !bundlePathArg) {
    console.error("Missing manifest or bundle path.");
    process.exit(2);
  }
  const manifestPath = resolve(manifestPathArg);
  const bundlePath = resolve(bundlePathArg);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    agent_id?: string;
    version?: string;
    agent_class?: string;
  };
  if (kind === "merchant_of_record" && !manifest.agent_class) {
    manifest.agent_class = "merchant_of_record";
  }
  assertValidMerchantManifest(manifest);
  if (!manifest.agent_id || !manifest.version) {
    throw new Error("manifest_missing_agent_id_or_version");
  }
  const material = loadOrCreateSigningMaterial();
  const signed = signBundle({
    agentId: manifest.agent_id,
    version: manifest.version,
    bundleBytes: readFileSync(bundlePath),
    material,
  });
  process.stdout.write(JSON.stringify(signed, null, 2));
  process.stdout.write("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
