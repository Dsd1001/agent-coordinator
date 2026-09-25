import assert from "node:assert/strict";
import test from "node:test";

import {
  COORDINATION_TRANSPORT_POINT,
  EXTENSION_API_VERSION,
  ExtensionRegistry,
  MANAGER_ADAPTER_POINT,
  PROTOCOL_VERSION,
  WORK_ORDER_CODEC_POINT,
  defineExtensionPoint,
  validateExtensionManifest
} from "../dist/packages/extension-api/index.js";

function manifest(overrides = {}) {
  return {
    id: "example.extension",
    version: "0.1.0",
    api_version: "0.1.7",
    protocol_version: "0.1.9",
    provides: [{ point: "agent.transport", name: "fake" }],
    ...overrides
  };
}

test("extension manifest accepts compatible 0.1 patch lines and rejects incompatible minor lines", () => {
  assert.equal(EXTENSION_API_VERSION, "0.1.0");
  assert.equal(PROTOCOL_VERSION, "0.1.0");
  assert.doesNotThrow(() => validateExtensionManifest(manifest()));
  assert.throws(() => validateExtensionManifest(manifest({ api_version: "0.2.0" })), /incompatible extension API/);
  assert.throws(() => validateExtensionManifest(manifest({ protocol_version: "0.2.0" })), /incompatible extension protocol/);
});

test("registry atomically installs and resolves typed providers", async () => {
  const registry = new ExtensionRegistry({ now: () => new Date("2026-01-01T00:00:00Z") });
  const transport = {
    async createRoom() { return { channel_id: "c", room_id: "r" }; },
    async send() { return { message_id: "m" }; },
    async closeRoom() {}
  };
  const installed = await registry.install({
    manifest: manifest(),
    register(registrar, context) {
      assert.equal(context.extension_api_version, "0.1.0");
      assert.equal(context.protocol_version, "0.1.0");
      registrar.provide(COORDINATION_TRANSPORT_POINT, "fake", transport);
    }
  });
  assert.equal(registry.require(COORDINATION_TRANSPORT_POINT, "fake"), transport);
  assert.deepEqual(installed, {
    id: "example.extension",
    version: "0.1.0",
    providers: [{ point: "agent.transport", name: "fake" }]
  });
});

test("failed multi-provider install leaves no partial registration", async () => {
  const registry = new ExtensionRegistry();
  const codec = { roomTitle: () => "x", renderTask: () => "x", parseWorkerReply: () => undefined };
  await assert.rejects(
    () => registry.install({
      manifest: manifest({
        id: "example.atomic",
        provides: [
          { point: "agent.codec", name: "json" },
          { point: "agent.manager", name: "manager" }
        ]
      }),
      register(registrar) {
        registrar.provide(WORK_ORDER_CODEC_POINT, "json", codec);
        throw new Error("setup failed");
      }
    }),
    /setup failed/
  );
  assert.equal(registry.resolve(WORK_ORDER_CODEC_POINT, "json"), undefined);
  assert.deepEqual(registry.installed(), []);
});

test("registry rejects undeclared, missing, duplicate and conflicting providers", async () => {
  const registry = new ExtensionRegistry();
  const manager = { async prepareTask() {}, async reviewDelivery() {} };
  await assert.rejects(
    () => registry.install({
      manifest: manifest({ id: "example.undeclared", provides: [] }),
      register(registrar) { registrar.provide(MANAGER_ADAPTER_POINT, "x", manager); }
    }),
    /undeclared provider/
  );
  await assert.rejects(
    () => registry.install({
      manifest: manifest({ id: "example.missing", provides: [{ point: "agent.manager", name: "x" }] }),
      register() {}
    }),
    /did not register all declared providers/
  );

  await registry.install({
    manifest: manifest({ id: "example.owner", provides: [{ point: "agent.manager", name: "x" }] }),
    register(registrar) { registrar.provide(MANAGER_ADAPTER_POINT, "x", manager); }
  });
  await assert.rejects(
    () => registry.install({
      manifest: manifest({ id: "example.conflict", provides: [{ point: "agent.manager", name: "x" }] }),
      register(registrar) { registrar.provide(MANAGER_ADAPTER_POINT, "x", manager); }
    }),
    /provider already exists/
  );
});

test("hosts may define typed custom extension points", async () => {
  const CUSTOM = defineExtensionPoint("example.metric", "custom");
  const registry = new ExtensionRegistry();
  await registry.install({
    manifest: manifest({ id: "example.custom", provides: [{ point: "example.metric", name: "counter" }] }),
    register(registrar) { registrar.provide(CUSTOM, "counter", { value: 42 }); }
  });
  assert.deepEqual(registry.require(CUSTOM, "counter"), { value: 42 });
});


test("concurrent installs cannot race provider ownership", async () => {
  const registry = new ExtensionRegistry();
  const make = (id) => ({
    manifest: manifest({ id, provides: [{ point: "agent.codec", name: "shared" }] }),
    async register(registrar) {
      await Promise.resolve();
      registrar.provide(WORK_ORDER_CODEC_POINT, "shared", {
        roomTitle: () => id, renderTask: () => id, parseWorkerReply: () => undefined
      });
    }
  });
  const results = await Promise.allSettled([registry.install(make("example.race-a")), registry.install(make("example.race-b"))]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(registry.installed().length, 1);
});
