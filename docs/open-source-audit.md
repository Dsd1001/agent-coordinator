# Open-source Extraction Audit

## Verified locally

- Hermes Agent: MIT.
- `@earendil-works/pi-coding-agent`: MIT.
- `@earendil-works/gondolin`: Apache-2.0.
- local `pi-chat`: package metadata and top-level LICENSE declare Apache-2.0.

## Do not copy directly yet

The legacy `/srv/consultant` coordination package is marked `private: true` and has no top-level license file. The public project must not copy that source unless ownership/licensing is explicitly established. Public coordinator code should be a clean generic implementation of the documented protocol or code whose provenance is independently clear.

## Production material excluded from release

- bot tokens and provider credentials
- production chat/user/bot IDs
- real task ledgers and ingress logs
- Pi/Hermes sessions and memories
- customer/user inputs and generated deliverables
- absolute deployment-specific paths
- private hostnames/endpoints

## Completed before first public push

- [x] Repository release/secret scan passed.
- [x] Public implementation was limited to source with clear provenance or clean generic implementation.
- [x] Top-level license selected: Apache-2.0.
- [x] Third-party notices/attribution added.
- [x] Production identifiers were replaced with example placeholders.
- [x] Staged content and git history were reviewed before publication.
- [x] GitHub Actions repeated `npm ci`, tests, and the release scan successfully after publication.
