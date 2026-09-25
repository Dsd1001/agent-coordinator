# coordinator

Transport-independent task orchestration.

`TaskCoordinator` depends only on:

- an `EventLedger`
- a `CoordinationTransport`
- a `WorkOrderCodec`
- the immutable expected worker sender ID

It does not import Telegram or any other transport adapter.

A codec owns the human/machine wire representation. A transport owns room creation, message sending, and room closure. The coordinator owns task/execution lifecycle, routing identity binding, duplicate-delivery protection, rework/resume, and review state.

The test suite includes a JSON codec and a fake non-Telegram transport to keep this boundary executable rather than documentary.
