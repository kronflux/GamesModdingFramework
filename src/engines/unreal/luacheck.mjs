// Lua structure checks without a Lua VM: block and bracket balance, module field references and an
// optional language-server pass. Nothing is installed; lua-language-server is used only when found on PATH.
// The scanner removes comments and strings sequentially, so an apostrophe in a comment never starts a string.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isFile, walkFiles } from "./operations/shared.mjs";

const issue = (file, line, message, severity = "error") => ({ file, line, message, severity });

function longOpen(source, at) {
  const match = /^\[(=*)\[/.exec(source.slice(at, at + 64));
  return match ? match[1] : null;
}

const newlines = (text) => text.replace(/[^\n]/g, "");
const lineAt = (source, offset) => source.slice(0, offset).split("\n").length;

// Returns {code, errors}. Line breaks are kept so line numbers stay right. With keepStrings the
// contents of short strings stay (needed to read require names); long strings are always emptied.
export function stripLua(source, { keepStrings = false } = {}) {
  let out = "";
  let i = 0;
  const errors = [];
  while (i < source.length) {
    if (source.startsWith("--", i)) {
      const eq = longOpen(source, i + 2);
      if (eq !== null) {
        const close = `]${eq}]`;
        const j = source.indexOf(close, i + 4 + eq.length);
        if (j < 0) {
          errors.push({ line: lineAt(source, i), message: "Unclosed long comment." });
          out += newlines(source.slice(i));
          break;
        }
        out += newlines(source.slice(i, j + close.length));
        i = j + close.length;
        continue;
      }
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    const c = source[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") {
        if (source[j] === "\\") {
          // A backslash continues the string over a line break; CRLF is one break.
          if (source[j + 1] === "\r" && source[j + 2] === "\n") j += 1;
          j += 1;
        }
        j += 1;
      }
      const closed = source[j] === c;
      if (!closed) errors.push({ line: lineAt(source, i), message: "Unclosed string." });
      // An unclosed string ends before its line break, which is kept for the scanner.
      const end = closed ? Math.min(j + 1, source.length) : Math.min(j, source.length);
      const consumed = source.slice(i, end);
      out += keepStrings ? consumed : `""${newlines(consumed)}`;
      i = end;
      continue;
    }
    if (c === "[") {
      const eq = longOpen(source, i);
      if (eq !== null) {
        const close = `]${eq}]`;
        const j = source.indexOf(close, i + 2 + eq.length);
        if (j < 0) {
          errors.push({ line: lineAt(source, i), message: "Unclosed long string." });
          out += newlines(source.slice(i));
          break;
        }
        out += `""${newlines(source.slice(i, j + close.length))}`;
        i = j + close.length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return { code: out, errors };
}

const BRACKETS = { ")": "(", "]": "[", "}": "{" };

export function checkLuaBalance(source, fileName) {
  const { code, errors } = stripLua(source);
  const issues = errors.map((error) => issue(fileName, error.line, error.message));
  const blocks = [];
  const brackets = [];
  let line = 1;
  for (const match of code.matchAll(/\n|[A-Za-z_]\w*|[()[\]{}]/g)) {
    const token = match[0];
    if (token === "\n") {
      line += 1;
    } else if (token === "function" || token === "if" || token === "repeat") {
      blocks.push({ kind: token, line });
    } else if (token === "for" || token === "while") {
      blocks.push({ kind: token, line, awaitingDo: true });
    } else if (token === "do") {
      const top = blocks[blocks.length - 1];
      if (top?.awaitingDo) top.awaitingDo = false;
      else blocks.push({ kind: "do", line });
    } else if (token === "end") {
      const top = blocks[blocks.length - 1];
      if (!top || top.kind === "repeat") {
        issues.push(issue(fileName, line, "Unexpected 'end' with no open block."));
      } else blocks.pop();
    } else if (token === "until") {
      const top = blocks[blocks.length - 1];
      if (top?.kind === "repeat") blocks.pop();
      else issues.push(issue(fileName, line, "Unexpected 'until' with no open repeat."));
    } else if ("([{".includes(token)) {
      brackets.push({ char: token, line });
    } else if (BRACKETS[token]) {
      if (brackets[brackets.length - 1]?.char === BRACKETS[token]) brackets.pop();
      else issues.push(issue(fileName, line, `Unmatched '${token}'.`));
    }
  }
  for (const block of blocks) {
    issues.push(issue(fileName, block.line, `Unclosed '${block.kind}' block: no matching 'end' or 'until'.`));
  }
  for (const bracket of brackets) {
    issues.push(issue(fileName, bracket.line, `Unclosed '${bracket.char}'.`));
  }
  return issues.sort((a, b) => a.line - b.line);
}

function resolveModuleFile(scriptsDir, name) {
  const dotted = path.join(scriptsDir, ...name.split("."));
  const candidates = [
    path.resolve(scriptsDir, `${name}.lua`),
    `${dotted}.lua`,
    path.resolve(dotted, "init.lua"),
    path.resolve(scriptsDir, name, "init.lua"),
  ];
  return candidates.find((candidate) => isFile(candidate)) || null;
}

// Keys written directly inside the table constructor `Name = { ... }`: `key = value` entries at depth 1.
function constructorFields(code, name) {
  const fields = new Set();
  const start = new RegExp(`(?:^|[^\\w.])${name}\\s*=\\s*\\{`, "m").exec(code);
  if (!start) return fields;
  let depth = 0;
  let entryStart = true;
  for (let i = start.index + start[0].length - 1; i < code.length; i += 1) {
    const char = code[i];
    if (char === "{" || char === "(" || char === "[") {
      depth += 1;
      entryStart = char === "{" && depth === 1;
    } else if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && (char === "," || char === ";")) {
      entryStart = true;
    } else if (depth === 1 && entryStart && /[A-Za-z_]/.test(char)) {
      const key = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(code.slice(i));
      if (key) fields.add(key[1]);
      entryStart = false;
      if (key) i += key[1].length - 1;
      else i += /^\w+/.exec(code.slice(i))[0].length - 1;
    }
  }
  return fields;
}

// A module's fields are `function Name.f`, `function Name:f`, `Name.f =` and the keys of a `Name = { ... }`
// constructor, for the name in its final `return Name`.
function moduleFields(source) {
  const { code } = stripLua(source);
  const returned = [...code.matchAll(/^\s*return\s+([A-Za-z_]\w*)\s*$/gm)].pop();
  if (!returned) return null;
  const name = returned[1];
  const fields = constructorFields(code, name);
  const pattern = new RegExp(
    `(?:function\\s+${name}[.:](\\w+)|(?:^|[^\\w.])${name}\\.(\\w+)\\s*=[^=])`,
    "gm",
  );
  for (const match of code.matchAll(pattern)) fields.add(match[1] || match[2]);
  return fields;
}

export function checkModuleRefs(scriptsDir) {
  const issues = [];
  const cache = new Map();
  const files = walkFiles(scriptsDir).filter((file) => file.toLowerCase().endsWith(".lua"));
  for (const file of files) {
    const rel = path.relative(scriptsDir, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    const aliases = new Map();
    const withStrings = stripLua(source, { keepStrings: true }).code;
    for (const match of withStrings.matchAll(
      /local\s+([A-Za-z_]\w*)\s*=\s*require\s*\(?\s*["']([\w.-]+)["']\s*\)?/g,
    )) {
      const [, alias, module] = match;
      const moduleFile = resolveModuleFile(scriptsDir, module);
      // Modules outside Scripts (UE4SS shared modules such as UEHelpers) are skipped.
      if (!moduleFile) continue;
      if (!cache.has(moduleFile)) cache.set(moduleFile, moduleFields(fs.readFileSync(moduleFile, "utf8")));
      const fields = cache.get(moduleFile);
      if (fields) aliases.set(alias, { fields, module });
    }
    if (aliases.size === 0) continue;
    const { code } = stripLua(source);
    const reference = new RegExp(`(?<![\\w.:])(${[...aliases.keys()].join("|")})[.:]([A-Za-z_]\\w*)`, "g");
    const rebind = new RegExp(`(?<![\\w.:])(${[...aliases.keys()].join("|")})\\s*=(?!=)`, "g");
    code.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(reference)) {
        const entry = aliases.get(match[1]);
        if (!entry) continue;
        const before = text.slice(0, match.index);
        const after = text.slice(match.index + match[0].length);
        // `function m.f`, `function m:f` and `m.f = v` define or assign a field instead of reading one.
        if (/\bfunction\s+$/.test(before) || /^\s*=(?!=)/.test(after)) continue;
        if (!entry.fields.has(match[2])) {
          issues.push(
            issue(rel, index + 1, `uses module field ${match[1]}.${match[2]}, but ${entry.module} does not define it.`),
          );
        }
      }
      // An alias assigned again no longer names the module from here on.
      if (!/\brequire\b/.test(text)) {
        for (const match of text.matchAll(rebind)) aliases.delete(match[1]);
      }
    });
  }
  return issues;
}

function defaultResolveOnPath(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

// Runs lua-language-server --check only when it is already on PATH. Never installs it.
// A spawn error or a kill by signal is reported as ran:false with the reason; it is not a clean pass.
export function runLanguageServer(scriptsDir, { resolveOnPath = defaultResolveOnPath, spawn = spawnSync } = {}) {
  const exe = resolveOnPath("lua-language-server");
  if (!exe) return { ran: false, issues: [], reason: "lua-language-server is not on PATH" };
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-lls-"));
  try {
    const args = [`--check=${scriptsDir}`, "--checklevel=Warning", `--logpath=${logDir}`];
    const luarc = path.join(scriptsDir, "..", ".luarc.json");
    if (isFile(luarc)) args.push(`--configpath=${path.resolve(luarc)}`);
    const result = spawn(exe, args, { encoding: "utf8", timeout: 300000, windowsHide: true });
    if (result.error) return { ran: false, issues: [], reason: `lua-language-server failed to run: ${result.error.message}` };
    if (result.signal) return { ran: false, issues: [], reason: `lua-language-server was stopped by ${result.signal}` };
    const text = `${result.stdout || ""}\n${result.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    const issues = [];
    const seen = new Set();
    for (const match of text.matchAll(/([^\s]+\.lua):(\d+):\d+ \[(\w+)\] ([^>\n]{0,90})/g)) {
      if (/Undefined global/.test(match[4])) continue;
      const key = match[0];
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(
        issue(
          path.relative(scriptsDir, match[1]).split(path.sep).join("/") || match[1],
          Number(match[2]),
          match[4].trim(),
          match[3].toLowerCase() === "error" ? "error" : "warning",
        ),
      );
    }
    return { ran: true, issues };
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}
