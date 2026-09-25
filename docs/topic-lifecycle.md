# Topic Lifecycle

The Telegram reference adapter preserves the useful invariant:

**one task = one forum topic = one worker namespace**

A typical lifecycle is:

1. Manager prepares a task and execution ID.
2. Coordinator creates a forum topic and records its thread ID.
3. Verified inputs are staged into the topic workspace.
4. Work order is dispatched into that topic.
5. Dispatcher cold-starts a worker bound to `<channel>#<thread>` only after the triggering update passes coordinator-UID and worker-address checks. Untrusted/unaddressed topic traffic advances the ingress cursor but allocates no worker.
6. Worker executes in its sandbox and reports progress, blocked, failed, or delivered.
7. Manager reviews the delivery.
8. Rework/resume creates a new execution under the same task/topic.
9. Accept closes the topic.

A transport adapter may implement a different human-visible namespace, but must preserve task/execution identity and delivery verification.
