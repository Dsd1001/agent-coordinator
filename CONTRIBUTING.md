# Contributing

This repository is in extraction/staging mode.

Before proposing implementation code:

1. Keep manager, worker runtime, and sandbox trust zones separate.
2. Preserve the one-task / one-topic namespace invariant in the Telegram reference adapter.
3. Treat `task_id` and `execution_id` as protocol identities, not display labels.
4. Reject stale or wrongly routed deliveries.
5. Remote workers must remain fail-closed when their sandbox is unavailable.
6. Never add production credentials, IDs, transcripts, task ledgers, sessions, memories, or user deliverables.
7. Do not copy source from components whose redistribution rights have not been established.
