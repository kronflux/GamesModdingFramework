import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`GMF-E-TIMEOUT-001: operation timed out after ${ms} ms`);
      error.code = "GMF-E-TIMEOUT-001";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function spawnOwned(cmd, args = [], options = {}) {
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, pid: child.pid, cmd, args };
}

export async function stopOwned(owned) {
  const child = owned?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 2000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export function runProcess(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const owned = spawnOwned(cmd, args, options);
    const { child } = owned;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => finish(null, { code, signal, stdout, stderr, timedOut: false }));

    // The timeout settles the promise first, so the child's later close event
    // cannot turn a timed-out run into a normal result.
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error(`GMF-E-TIMEOUT-001: ${cmd} timed out after ${options.timeoutMs} ms`);
        error.code = "GMF-E-TIMEOUT-001";
        error.timedOut = true;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(error);
        stopOwned(owned).catch(() => {});
      }, options.timeoutMs);
    }
  });
}

function execError(program, detail) {
  const error = new Error(`GMF-E-EXEC-001: ${program} could not be started: ${detail}`);
  error.code = "GMF-E-EXEC-001";
  error.remediation = `Check that ${program} exists and can be run.`;
  return error;
}

// Starts a process that outlives this one. No handle is kept, so it is never stopped from here.
// Resolves with { pid } once the child has started; rejects with GMF-E-EXEC-001 when it cannot start.
export function launchDetached(cmd, args = [], options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(cmd, args, {
        cwd: options.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        shell: false,
      });
    } catch (error) {
      reject(execError(cmd, error.message));
      return;
    }
    if (typeof child.once !== "function") {
      child.unref?.();
      resolve({ pid: child.pid });
      return;
    }
    child.once("error", (error) => reject(execError(cmd, error.message)));
    child.once("spawn", () => {
      child.unref?.();
      resolve({ pid: child.pid });
    });
  });
}

const OPENABLE_SCHEMES = new Set(["steam:", "http:", "https:"]);
const URL_ALLOWED = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

// Opens a URL with the platform handler, never through a shell. Only steam, http and https URLs
// made of URL characters are allowed.
export async function openUrl(url, options = {}) {
  const text = String(url);
  let scheme = "";
  try {
    scheme = new URL(text).protocol;
  } catch {
    scheme = "";
  }
  if (!OPENABLE_SCHEMES.has(scheme)) {
    const error = new Error(`GMF-E-PLAN-001: refusing to open a URL with scheme "${scheme || "none"}"`);
    error.code = "GMF-E-PLAN-001";
    error.remediation = "Use a steam://, http:// or https:// URL.";
    throw error;
  }
  if (!URL_ALLOWED.test(text)) {
    const error = new Error("GMF-E-PLAN-001: refusing to open a URL with spaces, control characters or characters outside the URL character set");
    error.code = "GMF-E-PLAN-001";
    error.remediation = "Percent-encode the URL.";
    throw error;
  }
  const platform = options.platform || process.platform;
  let command;
  let args;
  if (platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", text];
  } else if (platform === "darwin") {
    command = "open";
    args = [text];
  } else {
    command = "xdg-open";
    args = [text];
  }
  await launchDetached(command, args, { spawnImpl: options.spawnImpl });
  return { command, args };
}

// Reports whether a process runs from exactly this executable path. Only reads the process list.
export async function isExecutableRunning(exePath, options = {}) {
  const platform = options.platform || process.platform;
  const runImpl = options.runImpl || runProcess;
  if (platform === "linux") {
    const procDir = options.procDir || "/proc";
    const procFs = options.procFs || fs;
    const wanted = path.posix.normalize(String(exePath));
    const segments = (value) => String(value).replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
    const wantedTail = segments(exePath).slice(-2);
    let entries = [];
    try {
      entries = procFs.readdirSync(procDir).filter((name) => /^\d+$/.test(name));
    } catch {
      return false;
    }
    for (const pid of entries) {
      try {
        if (path.posix.normalize(procFs.readlinkSync(`${procDir}/${pid}/exe`)) === wanted) return true;
      } catch {
        // process exited or is not readable
      }
      // Under Proton the exe link is the wine preloader; the game path is in the arguments.
      try {
        const args = String(procFs.readFileSync(`${procDir}/${pid}/cmdline`, "utf8")).split("\0");
        for (const arg of args) {
          const tail = segments(arg).slice(-2);
          if (wantedTail.length === 2 && tail.length === 2 && tail[0] === wantedTail[0] && tail[1] === wantedTail[1]) return true;
        }
      } catch {
        // process exited or is not readable
      }
    }
    return false;
  }
  const win = platform === "win32";
  const result = win
    ? await runImpl(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { $_.ExecutablePath }",
        ],
        { timeoutMs: 15000 },
      )
    : await runImpl("ps", ["-axo", "comm="], { timeoutMs: 15000 });
  const norm = (value) => {
    const text = String(value).trim();
    return win ? path.win32.normalize(text).toLowerCase() : path.posix.normalize(text);
  };
  const wanted = norm(exePath);
  return String(result.stdout || "")
    .split(/\r?\n/)
    .some((line) => line.trim() !== "" && norm(line) === wanted);
}
