import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { TomlStore } from "./store.ts";
import { createTelegramWebhook, ngrokWebhookUrl, registerTelegramWebhook } from "./telegram-webhook.ts";
import { loadWorld } from "./world.ts";

const world = await loadWorld("config/world.toml");
const secret = "local-test-secret";
const url = "https://pomrok.example.test/telegram/webhook";

test("webhook registration enables the Ukrainian Menu and keeps pending Telegram updates", async () => {
  const calls = new Map<string, object | undefined>();
  const call = async <T>(method: string, body?: object): Promise<T> => {
    calls.set(method, body);
    if (method === "getMe") return { is_bot: true, username: "pomrok_test_bot" } as T;
    if (method === "getWebhookInfo") return { url: "" } as T;
    return true as T;
  };
  assert.equal(await registerTelegramWebhook(call, url, secret), "pomrok_test_bot");
  assert.match(JSON.stringify(calls.get("setMyCommands")), /"command":"menu"/);
  assert.deepEqual(calls.get("setChatMenuButton"), { menu_button: { type: "commands" } });
  assert.deepEqual(calls.get("setWebhook"), {
    url, secret_token: secret, allowed_updates: ["message", "callback_query"],
    max_connections: 1, drop_pending_updates: false,
  });
  assert.equal(calls.has("getUpdates"), false);
});

test("a different active webhook is left in place", async () => {
  const call = async <T>(method: string): Promise<T> => {
    if (method === "getMe") return { is_bot: true, username: "pomrok_test_bot" } as T;
    if (method === "getWebhookInfo") return { url: "https://elsewhere.example.test/" } as T;
    assert.fail(`Unexpected Telegram mutation ${method}`);
  };
  await assert.rejects(registerTelegramWebhook(call, url, secret), /інший вебхук/);
});

test("registration follows a new ngrok address when the current webhook belongs to Pomrok", async () => {
  const next = await ngrokWebhookUrl("http://ngrok:4040/api/tunnels", new AbortController().signal, async () =>
    Response.json({ tunnels: [{ public_url: "http://insecure.test" }, { public_url: "https://new.example.test" }] }));
  assert.equal(next, "https://new.example.test/telegram/webhook");
  const changes: string[] = [];
  const call = async <T>(method: string, body?: object): Promise<T> => {
    if (method === "getMe") return { is_bot: true, username: "pomrok_test_bot" } as T;
    if (method === "getWebhookInfo") return { url } as T;
    if (method === "setWebhook") {
      assert.deepEqual(changes, [next]);
      assert.equal((body as { url: string }).url, next);
    }
    return true as T;
  };
  await registerTelegramWebhook(call, next, secret, [url], async (address) => { changes.push(address); });
});

test("the webhook authenticates updates and delivers the menu once across restarts", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-webhook-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const replies: object[] = [];
  const call = async <T>(method: string, body?: object): Promise<T> => {
    assert.equal(method, "sendMessage");
    assert.ok(body);
    replies.push(body);
    return true as T;
  };
  const store = new TomlStore(dir);
  await store.load();
  const first = createTelegramWebhook(call, store, world, secret).app;
  onTestFinished(() => first.close());
  const payload = {
    update_id: 50,
    message: { text: "/menu", chat: { id: 4, type: "private" }, from: { id: 4, first_name: "Орися" } },
  };
  const request = { method: "POST" as const, url: "/telegram/webhook", payload };
  assert.equal((await first.inject(request)).statusCode, 401);
  assert.equal((await first.inject("/catalog")).statusCode, 404);
  assert.equal(replies.length, 0);
  const headers = { "x-telegram-bot-api-secret-token": secret };
  assert.equal((await first.inject({ ...request, headers })).statusCode, 200);
  assert.equal((await first.inject({
    ...request, headers, payload: { update_id: 51, message: { ...payload.message, text: "Вітаю" } },
  })).statusCode, 200);
  const restored = new TomlStore(dir);
  await restored.load();
  assert.equal(restored.snapshot().lastUpdateId, 51);
  const second = createTelegramWebhook(call, restored, world, secret).app;
  onTestFinished(() => second.close());
  assert.equal((await second.inject({ ...request, headers })).statusCode, 200);
  assert.equal(replies.length, 1);
  assert.match(JSON.stringify(replies[0]), /Лісові пригоди/);
  assert.equal(restored.snapshot().players.length, 1);
});
