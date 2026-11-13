// unreal.read_containers: copy the text files that live inside the game's .pak files (.ini,
// .locres, .uplugin, .uproject) into the workspace, so the docs builder can turn them into pages.
// repak lists each pak (`repak list <pak>` prints one path per line) and `repak unpack -i` extracts
// only the selected entries. Nothing is written to the game folder.

import fs from "node:fs";
import path from "node:path";
import { evidence } from "../../../core/evidence.mjs";
import { gmfError, isDirectory, requireTool, resolveGameDirInput, runResolvedTool, ensureInsideWorkspace } from "./shared.mjs";
import { aesArgs, requireKeyIfEncrypted, resolveAesKey } from "./encryption.mjs";

export const CONTAINER_KINDS = ["ini", "locres", "uplugin", "uproject"];

// Characters of `-i <entry>` arguments per repak call; Windows limits a command line to 32767.
const MAX_INCLUDE_CHARS = 8000;

function kindOf(entry) {
  const lower = entry.toLowerCase();
  return CONTAINER_KINDS.find((kind) => lower.endsWith(`.${kind}`)) || null;
}

// Entry paths come from the pak and are untrusted. Returns a reason when the entry could land
// outside the output folder, otherwise null.
function unsafeReason(entry, outDir) {
  if (entry.includes("\0")) return "contains a NUL character";
  if (entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:/.test(entry)) return "is an absolute path";
  if (entry.split(/[\\/]/).includes("..")) return "contains a '..' segment";
  const relative = path.relative(outDir, path.resolve(outDir, entry));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return "resolves outside the output folder";
  }
  return null;
}

function batches(entries) {
  const out = [];
  let current = [];
  let size = 0;
  for (const entry of entries) {
    if (current.length > 0 && size + entry.length + 4 > MAX_INCLUDE_CHARS) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += entry.length + 4;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function run(context, tool, args, label) {
  const result = await runResolvedTool(context, tool, args, { timeoutMs: context.timeoutMs || 1800000 });
  if (result.code !== 0) {
    const tail = `${result.stderr || ""}\n${result.stdout || ""}`.trim().split(/\r?\n/).slice(-8).join(" | ");
    throw gmfError("GMF-E-EXEC-001", `${label} failed (exit ${result.code}): ${tail}`, "Read the tool output above; nothing in the game was changed.");
  }
  return result;
}

export const readContainersOperation = {
  id: "unreal.read_containers",
  title: "Read text files from the game's paks",
  summary:
    "List each .pak in Content/Paks with repak and extract only the .ini, .locres, .uplugin and .uproject entries into extracted/unreal/text/<pak>/, for the docs builder. Paks in ~mods and LogicMods are skipped.",
  engine: "unreal",
  inputs: {
    type: "object",
    properties: {
      gameDir: { type: "string" },
      aesKey: {
        type: "string",
        description: "256-bit AES key for an encrypted game, as 0x-hex or base64. Also read from GMF_AES_KEY or the workspace gmf.local.json \"aesKey\". Never recorded.",
      },
    },
    required: [],
  },
  outputs: {
    type: "object",
    properties: {
      textDir: { type: "string" },
      paks: { type: "array" },
      none: { type: "array" },
      refused: { type: "array" },
    },
  },
  effects: ["read", "workspaceWrite"],
  requires: ["repak"],
  gates: ["auto"],
  skill: "unreal-first-dump",
  async handler(inputs, context = {}) {
    if (!context?.workspace?.root) {
      throw gmfError("GMF-E-EXEC-001", "unreal.read_containers needs a workspace.", "Run gmf init first.");
    }
    const root = context.workspace.root;
    const gameDir = resolveGameDirInput(inputs, context);
    const paksDir = path.join(gameDir, "Content", "Paks");
    const paks = isDirectory(paksDir)
      ? fs
          .readdirSync(paksDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pak"))
          .map((entry) => entry.name)
          .sort()
      : [];
    if (paks.length === 0) {
      throw gmfError(
        "GMF-E-GAME-001",
        `GMF-E-GAME-001: no .pak file in ${paksDir}`,
        "Pass the game's project folder, for example --input gameDir=<install>/<Project>.",
      );
    }
    const textDir = ensureInsideWorkspace(context, path.join(root, "extracted", "unreal", "text"), "textDir");
    const repak = requireTool(context, "repak");
    const aes = resolveAesKey(inputs, context, context.env || process.env);
    requireKeyIfEncrypted(paksDir, aes);
    const keyArgs = aesArgs(aes);

    const summary = [];
    const refused = [];
    for (const pakFile of paks) {
      const name = pakFile.replace(/\.pak$/i, "");
      const outDir = path.join(textDir, name);
      const listed = await run(context, repak, [...keyArgs, "list", path.join(paksDir, pakFile)], "repak list");
      const wanted = [];
      for (const line of String(listed.stdout || "").split(/\r?\n/)) {
        const entry = line.trim();
        if (!entry || !kindOf(entry)) continue;
        const reason = unsafeReason(entry, outDir);
        if (reason) {
          refused.push({ pak: name, entry, reason });
          continue;
        }
        wanted.push(entry);
      }
      const kept = { ini: 0, locres: 0, uplugin: 0, uproject: 0 };
      if (wanted.length > 0) {
        fs.mkdirSync(outDir, { recursive: true });
        for (const group of batches(wanted)) {
          await run(
            context,
            repak,
            [...keyArgs, "unpack", "-q", "-o", outDir, "-f", ...group.flatMap((entry) => ["-i", entry]), path.join(paksDir, pakFile)],
            "repak unpack",
          );
        }
        for (const entry of wanted) {
          if (fs.existsSync(path.join(outDir, entry))) kept[kindOf(entry)] += 1;
        }
      }
      summary.push({ name, kept });
    }

    const none = CONTAINER_KINDS.filter((kind) => summary.every((pak) => pak.kept[kind] === 0));
    const total = summary.reduce((sum, pak) => sum + CONTAINER_KINDS.reduce((inner, kind) => inner + pak.kept[kind], 0), 0);
    return {
      data: { textDir, paks: summary, none, refused },
      evidence: [
        evidence({
          claim: `Extracted ${total} text files from ${summary.length} pak file(s) into the workspace`,
          confidence: "observed",
          authority: "shipped-artifact",
          source: paksDir,
          detail: { none, refused: refused.length },
        }),
      ],
    };
  },
};
