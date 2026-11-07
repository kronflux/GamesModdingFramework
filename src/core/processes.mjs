import { spawn, spawnSync } from "node:child_process";

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
