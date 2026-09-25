# transport-telegram

Telegram forum-topic reference adapter.

## Generic adapter surface

- `TelegramForumTransport` implements `CoordinationTransport` by mapping a generic `room_id` to Telegram `message_thread_id`.
- `TelegramWorkOrderCodec` implements `WorkOrderCodec` using the `/task@Worker_Bot` and `@Coordinator_Bot deliver|blocked|failed` reference format.
- `toCoordinationMessage()` maps Telegram-specific `topic_id` messages to the generic `room_id` message contract.

## Compatibility surface

The earlier `TaskRoom`, `createTaskRoom()`, `closeTaskRoom()`, and `topic_id` APIs remain available during the pre-1.0 transition. New coordinator integrations should use the generic room contract.

Sender authorization and worker cold-start authorization remain Telegram-specific policy helpers because they operate on Telegram platform identities and addressing.
