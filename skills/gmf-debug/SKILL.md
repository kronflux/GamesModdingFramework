---
name: gmf-debug
description: Diagnose a failed build, deploy or validation from the exact command, exit code and log tail.
operations: [generic.run_tool, analyze.strings, knowledge.search]
---

# Debug a failure

Use this after a build, deploy, launch or validation fails. The operation result
already contains the exact command, exit code and log tail; read them before
changing code.

## Steps

1. Copy the failing command, its exit code and the last lines of the log into
   your notes.
2. Confirm the failure reproduces with the same command. Do not change the
   command while reproducing.
3. Read the first error in the log, not the last line. Later errors are often
   consequences.
4. Search the knowledge base for the error text or the tool:
   `gmf run knowledge.search --input query="<error text>" --json`.
5. If the log names a symbol, search the dump or decompiled output with
   `analyze.strings` or `analyze.classes` before reading the whole assembly.
6. State one cause and the evidence for it. Make one change that tests that
   cause. Rerun the same command.
7. If two fixes in a row fail, change the hypothesis. After three failures with
   no new evidence, stop and report the state, the evidence and the next probe.

Engine skill next: for Unity failures load unity-testing; for Unreal load
unreal-debugging, plus unreal-aob when a signature scan failed.

## Evidence

Report the failing command, exit code, log tail, the cause you tested and the
result of the retest. A fix that was not rerun is unverified.

## Pitfalls

- Do not retry with guessed fixes. Each attempt costs the user time and hides
  the original error.
- Do not delete a failing test or lower a validation check to make a run pass.
- A missing tool is `GMF-E-TOOL-001`, not a code bug. Install it only when the
  plan authorizes `toolInstall`.
- A crash with no managed trace after a C++ mod change is often an ABI mismatch.
  Check the loader version before reading game code.
