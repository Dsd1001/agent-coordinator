# First Public Release Checklist

## Required before creating a public GitHub repository

- [x] Separate production runtime/state from public source staging.
- [x] Remove real chat IDs, user IDs, bot IDs, credentials, host IPs, private API endpoints, sessions, memories, task ledgers, and deliverables.
- [x] Add automated release safety scan.
- [x] Add CI build/test/release-check workflow.
- [x] Add security model and contributor guidance.
- [x] Add protocol schemas and executable reference core.
- [x] Verify clean `npm ci` followed by tests.
- [x] Select the final repository name: `agent-coordinator`.
- [x] Select/approve the top-level project license: Apache-2.0.
- [x] Exclude private/local source whose redistribution provenance is not established.
- [x] Review the staged first commit diff and run `git diff --cached --check`.
- [ ] Create the GitHub repository and push only after all items above are satisfied.

## Never publish

Production `.jsonl` ingress/session logs, task stores, Telegram updates, real bot/provider secrets, manager memories, customer/user input files, or generated customer deliverables.
