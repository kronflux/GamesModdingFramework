// AES-encrypted pak and IoStore containers. The key is never written to a
// profile, a plan, evidence or a log: it is read from the call, the
// environment or the machine-local gmf.local.json and passed to the tool.
import fs from "node:fs";
import path from "node:path";
import { gmfError } from "./shared.mjs";

export const AES_KEY_ENV = "GMF_AES_KEY";
export const AES_KEY_LOCAL_FIELD = "aesKey";

const PAK_MAGIC = Buffer.from([0xe1, 0x12, 0x6f, 0x5a]);
const UTOC_MAGIC = "-==--==--==--==-";
// FIoStoreTocHeader: magic[16], version u8, reserved u8, reserved u16, nine
// u32 fields, container id u64, encryption key guid[16], then ContainerFlags.
const UTOC_FLAGS_OFFSET = 16 + 1 + 1 + 2 + 9 * 4 + 8 + 16;
const UTOC_FLAG_ENCRYPTED = 0x02;

// A 256-bit key as 64 hex digits with or without 0x, or as 44 base64
// characters. Returns the key as 0x-prefixed lower-case hex, which both repak
// and retoc read.
export function normalizeAesKey(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const hex = text.replace(/^0x/i, "");
  if (/^[0-9a-f]{64}$/i.test(hex)) return `0x${hex.toLowerCase()}`;
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    const bytes = Buffer.from(text, "base64");
    if (bytes.length === 32) return `0x${bytes.toString("hex")}`;
  }
  throw gmfError(
    "GMF-E-PLAN-001",
    "The AES key must be a 256-bit key: 64 hex digits (0x prefix optional) or 44 base64 characters.",
    "Pass --input aesKey=0x<64 hex digits>, set GMF_AES_KEY, or put \"aesKey\" in the workspace gmf.local.json.",
  );
}

// The key for this call: the aesKey input, then GMF_AES_KEY, then the
// workspace's machine-local file. Returns { key, source } or null.
export function resolveAesKey(inputs = {}, context = {}, env = process.env) {
  if (inputs.aesKey) return { key: normalizeAesKey(inputs.aesKey), source: "input" };
  if (env && env[AES_KEY_ENV]) return { key: normalizeAesKey(env[AES_KEY_ENV]), source: "environment" };
  const local = context.workspace?.local?.[AES_KEY_LOCAL_FIELD];
  if (local) return { key: normalizeAesKey(local), source: "gmf.local.json" };
  return null;
}

// Reads the pak footer's bEncryptedIndex byte, which sits right before the
// pak magic. The index flag is set for every encrypted pak, whatever its
// version, so no version-specific footer layout is needed.
export function pakIndexEncrypted(pakFile) {
  let handle;
  try {
    const size = fs.statSync(pakFile).size;
    const length = Math.min(size, 512);
    const tail = Buffer.alloc(length);
    handle = fs.openSync(pakFile, "r");
    fs.readSync(handle, tail, 0, length, size - length);
    const at = tail.lastIndexOf(PAK_MAGIC);
    if (at <= 0) return null;
    return tail[at - 1] === 1;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// Reads the IoStore table-of-contents header's ContainerFlags.
export function utocEncrypted(utocFile) {
  let handle;
  try {
    const head = Buffer.alloc(UTOC_FLAGS_OFFSET + 1);
    handle = fs.openSync(utocFile, "r");
    const read = fs.readSync(handle, head, 0, head.length, 0);
    if (read < head.length || head.toString("latin1", 0, 16) !== UTOC_MAGIC) return null;
    return (head[UTOC_FLAGS_OFFSET] & UTOC_FLAG_ENCRYPTED) !== 0;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// Whether any container in Content/Paks is encrypted. unknown lists files
// whose header could not be read (synthetic or truncated files).
export function detectEncryption(paksDir) {
  const result = { encrypted: false, containers: [], unknown: [] };
  let names = [];
  try {
    names = fs.readdirSync(paksDir);
  } catch {
    return result;
  }
  for (const name of names.sort()) {
    const lower = name.toLowerCase();
    const file = path.join(paksDir, name);
    let flag = null;
    if (lower.endsWith(".pak")) flag = pakIndexEncrypted(file);
    else if (lower.endsWith(".utoc")) flag = utocEncrypted(file);
    else continue;
    if (flag === null) result.unknown.push(name);
    else if (flag) {
      result.encrypted = true;
      result.containers.push(name);
    }
  }
  return result;
}

// The tool arguments that carry the key: both repak and retoc take a global
// --aes-key before the subcommand.
export function aesArgs(resolved) {
  return resolved ? ["--aes-key", resolved.key] : [];
}

export function requireKeyIfEncrypted(paksDir, resolved) {
  const detection = detectEncryption(paksDir);
  if (detection.encrypted && !resolved) {
    throw gmfError(
      "GMF-E-GAME-002",
      `GMF-E-GAME-002: the game's containers are AES-encrypted (${detection.containers.join(", ")}) and no key was given.`,
      "Pass --input aesKey=<key>, set GMF_AES_KEY for this shell, or add \"aesKey\" to the workspace gmf.local.json (never gmf.json). Keys come from the game's own community; gmf does not look them up.",
    );
  }
  return detection;
}
