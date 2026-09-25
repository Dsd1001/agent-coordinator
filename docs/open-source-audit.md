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

## Before first public push

1. Run repository secret scan.
2. Confirm every copied source file has clear provenance.
3. Decide top-level project license.
4. Add third-party notices/attribution.
5. Replace every production identifier with example placeholders.
6. Review git history, not only the working tree.
