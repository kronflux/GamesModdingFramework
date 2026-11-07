const VALUE_FLAGS = new Set([
  "game",
  "workspace",
  "author",
  "goal",
  "profile",
  "out",
  "tool",
  "engine",
  "source",
  "authorized",
  "input",
  "tag",
  "mod",
  "plan",
  "root",
  "kind",
]);

export function parseArgs(argv = []) {
  const positionals = [];
  const flags = { json: false, help: false, check: false, input: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--check") {
      flags.check = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const equals = withoutPrefix.indexOf("=");
      const name = equals >= 0 ? withoutPrefix.slice(0, equals) : withoutPrefix;
      const inline = equals >= 0 ? withoutPrefix.slice(equals + 1) : undefined;

      if (name === "input") {
        const value = inline ?? argv[++index];
        if (typeof value === "string") {
          const separator = value.indexOf("=");
          if (separator > 0) flags.input[value.slice(0, separator)] = value.slice(separator + 1);
        }
        continue;
      }

      if (VALUE_FLAGS.has(name)) {
        const next = inline ?? argv[index + 1];
        if (inline === undefined && (next === undefined || next.startsWith("--"))) {
          flags.usageError = `--${name} needs a value`;
          continue;
        }
        if (inline === undefined) index += 1;
        flags[name] = next;
      } else flags[name] = inline ?? true;
      continue;
    }
    positionals.push(arg);
  }

  return { command: positionals[0] || null, positionals: positionals.slice(1), flags };
}

export function formatResult(result, { json = false } = {}) {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  if (result.ok) {
    if (result.data === null || result.data === undefined) return "ok\n";
    if (typeof result.data === "string") return `${result.data}\n`;
    return `${JSON.stringify(result.data, null, 2)}\n`;
  }
  return `error ${result.error.code}: ${result.error.message}\n${result.error.remediation || ""}\n`;
}

export function exitCodeFor(result) {
  if (result?.ok) return 0;
  const code = result?.error?.code || "";
  if (code === "GMF-E-USAGE-001") return 2;
  if (code === "GMF-E-GATE-001") return 3;
  if (code === "GMF-E-TOOL-001") return 4;
  return 1;
}
