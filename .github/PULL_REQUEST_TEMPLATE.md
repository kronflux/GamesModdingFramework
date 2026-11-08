# Pull request

## What changes

One topic per pull request. Say what a user of gmf can now do, or what no longer goes wrong.

## Why

The reason, in one or two sentences. Link the issue if there is one.

## Checks

Paste the last lines of each command you ran. CI runs the first two.

```text
npm run check
node scripts/pre-commit.mjs --staged
```

- [ ] `npm run check` passes (catalog and host files are current, every test passes)
- [ ] A test covers the change, written against the specified behaviour, not against the implementation
- [ ] No game content, decompiled code, loader binary, extracted asset or credential is included
- [ ] Knowledge notes touched by the change label each statement verified, observed or inferred and name a source
- [ ] If an operation changed, `npm run build-catalog` and `npm run sync` were run and the generated files are committed

## Tested on

For a change that touches a game, name the engine, version and loader you ran it against, or say that it was tested on synthetic fixtures only.

## Not verified

Say plainly what you could not check.
