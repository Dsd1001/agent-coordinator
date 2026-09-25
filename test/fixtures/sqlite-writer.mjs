import { SqliteEventLedger } from "../../dist/packages/core/index.js";

const [databasePath, prefix, countValue] = process.argv.slice(2);
const count = Number(countValue);
if (!databasePath || !prefix || !Number.isInteger(count) || count < 1) {
  throw new Error("usage: sqlite-writer <database-path> <prefix> <count>");
}

const ledger = new SqliteEventLedger(databasePath, { busy_timeout_ms: 10_000 });
try {
  for (let index = 0; index < count; index++) {
    ledger.append({
      type: "task.prepared",
      task_id: `${prefix}-task-${index}`,
      execution_id: `${prefix}-exec-${index}`
    });
  }
} finally {
  ledger.close();
}
