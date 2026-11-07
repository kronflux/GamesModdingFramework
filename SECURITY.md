# Security

gmf writes into game folders, downloads and runs third-party tools, and runs as an MCP server and as an agent plugin. Problems in those paths matter.

## Reporting

Report a vulnerability privately through GitHub's security advisories for this repository ("Report a vulnerability" under the Security tab). Do not open a public issue for it. Include the gmf version, the operation or command involved, and the steps that reproduce it. You will get an acknowledgement within a week.

## Scope

In scope:

- An operation that writes outside the workspace or the declared game folder, or runs a tool or command outside what its inputs allow.
- A soft or hard gate that can be bypassed without an authorization the design requires.
- A downloaded tool that is installed without its published digest being checked.
- A restore that overwrites a file with content that is not its recorded backup.
- A hook or plugin manifest that runs something other than gmf's own entry point.

Out of scope: the behaviour of the third-party tools gmf installs (report those upstream), and anti-cheat consequences of running a mod, which gmf reports as risk information and does not prevent.

## Design notes for reviewers

- The executor gates every operation by its declared effects; `docs/authorization.md` describes the model, including that the calling agent is trusted to quote the user's instruction as the authorization source.
- Game writes go through a helper that backs up every overwritten file and rolls back on failure.
- Tool installs land in a temporary folder and replace the previous install only after verification.
