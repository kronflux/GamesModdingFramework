// Read a UE4SS or cdb crash stack from text: frames, the faulting module and the nearest mod file.
// Reads crash text that already exists (Event Log text, UE4SS and cdb frame dumps);
// it never runs a debugger itself.

// "<module>!<symbol>+0x<offset>", optionally followed by a cdb source location "[file @ line]".
const FRAME = /(?:^|\s)([A-Za-z0-9_.\-]+)(?:!(\S+?))?\+(0x[0-9a-fA-F]+)(?:\s+\[[^\]]*@\s*\d+\])?\s*$/;
const FAULT_HEADER = /\b(?:in|faulting)\s+module\s+(?:name\s*:\s*)?([A-Za-z0-9_.\-]+)/i;
const MOD_FILE = /\bMods[\\/]+[^\s:'"()]+?\.(?:lua|dll)\b/i;

const SYSTEM_MODULES = /^(ntdll|kernel32|kernelbase|ucrtbase|msvcrt|user32|win32u|gdi32|combase|vcruntime\d*|msvcp\d*)(\.dll)?$/i;
// Unreal's CrashContext.runtime-xml lists frames as "<module>  0x<base> + <offset>".
const XML_FRAME = /^\s*([A-Za-z0-9_.\-]+)\s+0x[0-9a-fA-F]+\s+\+\s+([0-9a-fA-F]+)\s*$/;

function xmlTag(text, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1].trim() : null;
}

// Frames live in the top-level <CallStack> on some builds and, on UE 5.6, in
// one <Thread> per thread with <IsCrashed>true</IsCrashed> on the crashed one.
function crashedCallStack(text) {
  const top = xmlTag(text, "CallStack");
  const threads = [...text.matchAll(/<Thread>([\s\S]*?)<\/Thread>/g)].map((match) => match[1]);
  const crashed = threads.find((thread) => /<IsCrashed>\s*true\s*<\/IsCrashed>/i.test(thread));
  if (crashed) return { stack: xmlTag(crashed, "CallStack") || "", thread: xmlTag(crashed, "ThreadName") };
  return { stack: top || (threads[0] ? xmlTag(threads[0], "CallStack") || "" : ""), thread: null };
}

function parseCrashContextXml(text) {
  const frames = [];
  const { stack, thread } = crashedCallStack(text);
  for (const line of stack.split(/\r?\n/)) {
    const frame = XML_FRAME.exec(line.replace(/<\/?CallStack>/g, ""));
    if (frame) frames.push({ module: frame[1], offset: `0x${frame[2].toLowerCase()}`, symbol: null });
  }
  const firstNonSystem = frames.find((frame) => !SYSTEM_MODULES.test(frame.module));
  const mod = MOD_FILE.exec(text);
  return {
    frames,
    error: xmlTag(text, "ErrorMessage"),
    engineVersion: xmlTag(text, "EngineVersion"),
    faultingModule: firstNonSystem?.module || frames[0]?.module || null,
    allSystemFrames: frames.length > 0 && !firstNonSystem,
    crashedThread: thread,
    nearestMod: mod ? mod[0].replace(/\\/g, "/").replace(/\/{2,}/g, "/") : null,
  };
}

export function parseCrashStack(text) {
  if (/<FGenericCrashContext|<CallStack>/.test(String(text || ""))) return parseCrashContextXml(String(text));
  const frames = [];
  let header = null;
  let nearestMod = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!header) header = FAULT_HEADER.exec(line)?.[1] || null;
    if (!nearestMod) {
      const mod = MOD_FILE.exec(line);
      if (mod) nearestMod = mod[0].replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    }
    const frame = FRAME.exec(line);
    if (frame) {
      frames.push({ module: frame[1], offset: frame[3].toLowerCase(), symbol: frame[2] || null });
    }
  }
  const firstNonSystem = frames.find((frame) => !SYSTEM_MODULES.test(frame.module));
  const headerIsSystem = header !== null && SYSTEM_MODULES.test(header);
  return {
    frames,
    error: null,
    engineVersion: null,
    faultingModule: (headerIsSystem ? null : header) || firstNonSystem?.module || header || frames[0]?.module || null,
    allSystemFrames: frames.length > 0 && !firstNonSystem,
    crashedThread: null,
    nearestMod,
  };
}
