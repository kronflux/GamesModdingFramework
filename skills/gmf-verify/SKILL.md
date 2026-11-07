---
name: gmf-verify
description: Verify each plan step with evidence and report pass, fail and unresolved unknowns.
operations: [plan.validate, game.profile, unity.validate, unreal.validate, generic.hash, analyze.classes]
---

# Verify a plan step

Use this after a step ran, or before declaring a mod finished. Verification is
a separate action from doing the work.

## Steps

1. Read the step `verify` field and turn it into a concrete check.
2. Run the matching operation, for example `unity.validate` or
   `unreal.validate`, and read its result.
3. Compare file hashes with `generic.hash` when the claim is about a deployed
   file. Record the expected hash and the actual hash.
4. Confirm the result did not read stale state. A profile or dump from an older
   game build does not verify a current deployment.
5. Record the check, the command and the output as evidence. Mark the step
   passed only when the output shows it.
6. Report the unresolved unknowns separately. A known gap is not a pass.

Engine skill next: for Unity load unity-testing; for Unreal load
unreal-debugging for log and Lua checks.

## Evidence

A verification record names the check, the command, the exit code or compared
values, and the source. Quote the output; do not reconstruct it from memory.

## Pitfalls

- A passing command proves only what it checked. Say what it did not cover.
- A validation that resolves no targets because the dump is missing is not a
  pass. It is an unknown.
- Do not verify a deploy by reading the source file. Hash the deployed file.
- Do not remove a check because it fails. Report the failure.
