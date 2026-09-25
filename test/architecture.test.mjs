import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("coordinator source has no Telegram adapter dependency", async () => {
  const source = await readFile(new URL("../packages/coordinator/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /transport-telegram/);
});
