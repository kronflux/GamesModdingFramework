// Parser for UE4SS PatternSleuth scan logs.
// Returns the resolved anchors, the signatures the user must supply, and the engine version when logged.

const ENGINE_VERSION = /Found EngineVersion:\s*(\S+)/;
const FOUND_ADDRESS = /Found\s+(?!EngineVersion\b)(\S+):\s*0x([0-9A-Fa-f]+)/;
const AOB_HINT = /You can supply your own AOB in\s*'UE4SS_Signatures\/([^']+?)\.lua'/;

export function parsePatternSleuthLog(text) {
  let engineVersion = null;
  const resolved = new Map(); // a later line for the same name wins
  const unresolved = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    let m = ENGINE_VERSION.exec(line);
    if (m) {
      if (engineVersion === null) engineVersion = m[1];
      continue;
    }
    m = FOUND_ADDRESS.exec(line);
    if (m) {
      resolved.set(m[1], parseInt(m[2], 16));
      continue;
    }
    m = AOB_HINT.exec(line);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      unresolved.push(m[1]);
    }
  }
  return { resolved: [...resolved].map(([name, offset]) => ({ name, offset })), unresolved, engineVersion };
}
