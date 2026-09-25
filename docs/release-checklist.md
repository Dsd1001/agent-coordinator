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
- [x] Create the public GitHub repository: `Dsd1001/agent-coordinator`.
- [x] Push `main` and verify the GitHub Actions CI run succeeds.

## Never publish

Production `.jsonl` ingress/session logs, task stores, Telegram updates, real bot/provider secrets, manager memories, customer/user input files, or generated customer deliverables.

## 0.1.0 tagged release

- [x] Stable protocol/API versions defined.
- [x] Public core uses transport-neutral `room_id`; Telegram `topic_id` remains adapter-local.
- [x] Resource quotas/concurrency tests pass.
- [x] Recovery semantic audit tests pass.
- [x] Extension API atomic-registration tests pass.
- [x] Workspace package versions set to `0.1.0`.
- [ ] Clean Node 22 CI succeeds on release commit.
- [ ] Tag `v0.1.0` from green `main`.
- [ ] Create GitHub Release `0.1.0`.
