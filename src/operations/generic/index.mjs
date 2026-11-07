import backupOperation from "./backup.mjs";
import restoreOperation from "./restore.mjs";
import hashOperation from "./hash.mjs";
import runToolOperation from "./run_tool.mjs";

export const genericOperations = [backupOperation, restoreOperation, hashOperation, runToolOperation];

export default genericOperations;
