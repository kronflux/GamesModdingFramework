// Multi-file writes into a game folder. Each overwritten file is backed up
// into the workspace first; when one copy fails, the files written so far are
// put back (from their backups, or removed when they were new) and the error
// carries the backups and the files it could not undo.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backupFile } from "./workspace.mjs";

function codedError(code, message, remediation) {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Puts written files back: an overwritten file from its backup, when the
// backup still has the recorded hash; a new file is removed.
function rollback(deployed) {
  const failed = [];
  for (const record of [...deployed].reverse()) {
    try {
      if (record.backup) {
        if (sha256File(record.backup) !== record.sha256) throw new Error(`backup ${record.backup} no longer matches its recorded hash`);
        fs.copyFileSync(record.backup, record.target);
      } else fs.rmSync(record.target, { force: true });
    } catch (error) {
      failed.push({ target: record.target, error: error.message });
    }
  }
  return failed;
}

// pairs: [{ source, target }]. Returns { deployed: [{ source, target, backup,
// sha256 }], backups: [backupPath] }. Throws GMF-E-GATE-001 before any write
// when a target exists and there is no workspace to hold its backup, and
// GMF-E-GAME-001 when a directory sits where a file must go.
export function copyFilesWithBackup(workspace, pairs) {
  const targets = pairs.map((pair) => path.resolve(pair.target));
  for (const target of targets) {
    if (fs.existsSync(target) && !isFile(target)) {
      throw codedError("GMF-E-GAME-001", `Refusing to overwrite a directory: ${target}`, "Remove the conflicting directory first.");
    }
    if (fs.existsSync(target) && !workspace?.root) {
      throw codedError(
        "GMF-E-GATE-001",
        `GMF-E-GATE-001: refusing to overwrite ${target} without a workspace backup.`,
        "Open a workspace with gmf init so the original can be backed up.",
      );
    }
  }
  const deployed = [];
  const backups = [];
  for (const [index, pair] of pairs.entries()) {
    const target = targets[index];
    const record = { source: path.resolve(pair.source), target, backup: null, sha256: null };
    try {
      if (fs.existsSync(target)) {
        const backup = backupFile(workspace, target);
        record.backup = backup.backupPath;
        record.sha256 = backup.sha256;
        backups.push(backup.backupPath);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(record.source, target);
      deployed.push(record);
    } catch (error) {
      const failed = rollback(deployed);
      const wrapped = error && error.code && String(error.code).startsWith("GMF-")
        ? error
        : codedError("GMF-E-EXEC-001", `GMF-E-EXEC-001: could not write ${target}: ${error.message}`, "Close the game and check that the folder is writable, then run the operation again.");
      wrapped.backups = backups;
      wrapped.deployed = [];
      wrapped.rollbackFailed = failed;
      if (failed.length > 0) {
        wrapped.remediation = `${wrapped.remediation || ""} ${failed.length} file(s) could not be put back; restore them with generic.restore from ${backups.join(", ") || "the workspace backups"}.`.trim();
      }
      throw wrapped;
    }
  }
  return { deployed, backups };
}
