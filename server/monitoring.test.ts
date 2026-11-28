import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { test } from "vitest";
import { createHttpMetrics, createMetricsServer } from "../shared/monitoring.ts";
import { observeWebRequests } from "../shared/web-monitoring.ts";
import { createApi } from "./api.ts";
import { createGameMetrics } from "./monitoring.ts";
import { TomlStore } from "./store.ts";
import { applyTelegramUpdate, deliverTelegramMessage, telegramClient } from "./telegram.ts";
import { handleGameInput } from "./telegram-game.ts";
import { createTelegramWebhook } from "./telegram-webhook.ts";
import { loadWorld } from "./world.ts";

const world = await loadWorld("config/world.toml");
const day = 86_400_000;
const player = { user: { id: 1, first_name: "Марта", username: "marta" }, chatId: 1 };
const opponent = { user: { id: 2, first_name: "Іван", username: "ivan" }, chatId: 2 };
const call = async <T>(): Promise<T> => true as T;

function scrape(metrics: ReturnType<typeof createMetricsServer>) {
  // Drive the real exporter over HTTP with an ephemeral port.
  const server = createServer(metrics.exporter.getMetricsRequestHandler.bind(metrics.exporter));
  return new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      void fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text())
        .then(resolve, reject).finally(() => server.close());
    });
  });
}

test("rolling player counts survive a restart and leave legacy registration dates unknown", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-metrics-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "state.toml"), stringify({
    lastUpdateId: -1, challenges: [], outbox: [],
    players: [{ id: 1, name: "Марта", username: "marta", heroId: "vanguard", wins: 0, losses: 0, draws: 0 }],
  }));
  const store = new TomlStore(dir);
  await store.load();
  const state = store.snapshot();
  const now = day * 10;
  handleGameInput(state, world, { ...opponent, command: "/start" }, now - 2 * day);
  handleGameInput(state, world, { ...player, command: "/start" }, now - 2000);
  handleGameInput(state, world, { ...player, command: "/menu" }, now - 1000);
  await store.save(state);

  const restarted = new TomlStore(dir);
  await restarted.load();
  assert.deepEqual(restarted.playerMetrics(now), [
    { window: "24h", newPlayers: 0, activePlayers: 1 },
    { window: "7d", newPlayers: 1, activePlayers: 2 },
  ]);
  assert.deepEqual(restarted.playerMetrics(now + 7 * day), [
    { window: "24h", newPlayers: 0, activePlayers: 0 },
    { window: "7d", newPlayers: 0, activePlayers: 0 },
  ]);
});

test("expired challenges are visible before cleanup and materialized only once", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-metrics-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const store = new TomlStore(dir);
  await store.load();
  const state = store.snapshot();
  const now = day * 10;
  handleGameInput(state, world, { ...player, command: "/start" }, now);
  handleGameInput(state, world, { ...opponent, command: "/start" }, now);
  handleGameInput(state, world, { ...player, command: "/challenge @ivan" }, now);
  const callback = state.outbox.find(({ chatId, keyboard }) =>
    chatId === 2 && keyboard[0]?.[0]?.callback_data.startsWith("accept:"))?.keyboard[0][0].callback_data;
  assert.ok(callback);
  handleGameInput(state, world, { ...opponent, callback }, now + 1000);
  handleGameInput(state, world, { ...player, command: "/challenge @ivan" }, now + 1000);
  await store.save(state);
  const expires = now + day + 1000;
  assert.equal(store.gameMetrics(expires - 1).challenges.expired, 0);
  assert.equal(store.gameMetrics(expires).challenges.expired, 1);
  assert.equal(store.gameMetrics(expires).fights.pvp, 1);
  assert.equal(store.gameMetrics(expires).challenges.accepted, 1);

  const cleaned = store.snapshot();
  handleGameInput(cleaned, world, { ...player, command: "/menu" }, expires + 1000);
  await store.save(cleaned);
  assert.equal(store.gameMetrics(expires + 1000).challenges.expired, 1);
});

test("webhook retries export one new player, one processed update and a separate duplicate", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-metrics-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const metrics = createMetricsServer();
  onTestFinished(metrics.shutdown);
  const game = createGameMetrics(metrics.meter);
  const store = new TomlStore(dir, game.recordSaveFailure);
  game.observeStore(store);
  await store.load();
  const webhook = createTelegramWebhook(call, store, world, "test-secret", {
    game, http: createHttpMetrics(metrics.meter, ["telegram_webhook"]),
  }).app;
  onTestFinished(() => webhook.close());
  const request = {
    method: "POST" as const, url: "/telegram/webhook",
    headers: { "x-telegram-bot-api-secret-token": "test-secret" },
    payload: { update_id: 50, message: { text: "/start", chat: { id: 1, type: "private" }, from: player.user } },
  };
  const before = await scrape(metrics);
  assert.match(before, /^pomrok_telegram_updates_total\{transport="webhook",result="processed"\} 0$/m);
  assert.equal((await webhook.inject(request)).statusCode, 200);
  assert.equal((await webhook.inject(request)).statusCode, 200);
  const body = await scrape(metrics);
  assert.match(body, /^pomrok_players_new\{window="24h"\} 1$/m);
  assert.match(body, /^pomrok_telegram_updates_total\{transport="webhook",result="processed"\} 1$/m);
  assert.match(body, /^pomrok_telegram_updates_total\{transport="webhook",result="duplicate"\} 1$/m);
  assert.match(body, /^pomrok_telegram_delivery_duration_count 1$/m);
  assert.match(body, /^http_server_request_duration_count\{component="telegram_webhook",http_request_method="POST",http_response_status_code="200",http_route="\/telegram\/webhook"\} 2$/m);
  assert.doesNotMatch(body, /marta|Марта|test-secret/);
});

test("a failed state write does not surface a new player and is counted for alerting", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-metrics-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const metrics = createMetricsServer();
  onTestFinished(metrics.shutdown);
  const game = createGameMetrics(metrics.meter);
  const store = new TomlStore(join(dir, "missing"), game.recordSaveFailure);
  game.observeStore(store);
  await assert.rejects(applyTelegramUpdate(call, store, world, {
    update_id: 50, message: { text: "/start", chat: { id: 1, type: "private" }, from: player.user },
  }, false, game));
  const body = await scrape(metrics);
  assert.match(body, /^pomrok_players_new\{window="24h"\} 0$/m);
  assert.match(body, /^pomrok_state_save_failures_total 1$/m);
  assert.match(body, /^pomrok_telegram_updates_total\{transport="polling",result="error"\} 1$/m);
});

test("Telegram API failures retain the queued reply and expose its age and rate limit outcome", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-metrics-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const metrics = createMetricsServer();
  onTestFinished(metrics.shutdown);
  const game = createGameMetrics(metrics.meter);
  const store = new TomlStore(dir);
  game.observeStore(store);
  await store.load();
  const state = store.snapshot();
  handleGameInput(state, world, { ...player, command: "/start" }, Date.now() - 150_000);
  await store.save(state);
  const limited = telegramClient("123:test-token", new AbortController().signal, async () =>
    Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, { status: 429 }), game);
  const app = createApi(world);
  onTestFinished(() => app.close());
  const before = await scrape(metrics);
  assert.match(before, /^pomrok_telegram_api_requests_total\{method="sendMessage",result="429"\} 0$/m);
  await assert.rejects(deliverTelegramMessage(limited, store, app.log, game), /429/);
  const body = await scrape(metrics);
  assert.match(body, /^pomrok_telegram_api_requests_total\{method="sendMessage",result="429"\} 1$/m);
  assert.match(body, /^pomrok_telegram_outbox_depth 1$/m);
  const age = /^pomrok_telegram_outbox_oldest_age (\S+)$/m.exec(body)?.[1];
  assert.ok(Number(age) >= 150);
  assert.doesNotMatch(body, /test-token/);
});

test("HTTP histograms distinguish web and game API without using raw URLs as labels", async ({ onTestFinished }) => {
  const metrics = createMetricsServer();
  onTestFinished(metrics.shutdown);
  const http = createHttpMetrics(metrics.meter, ["api", "web"]);
  const game = createGameMetrics(metrics.meter);
  const before = await scrape(metrics);
  assert.match(before, /^pomrok_practice_fights_total\{mode="dungeon"\} 0$/m);
  const requestCounter = /^pomrok_http_requests_total\{component="web",http_response_status_code="502",http_response_status_class="5xx",http_route="\/api\/practice"\} (\d+)$/m;
  assert.equal(requestCounter.exec(before)?.[1], "0");
  const api = createApi(world, undefined, undefined, { http, game });
  onTestFinished(() => api.close());
  const server = createServer((_request, response) => { response.statusCode = 502; response.end(); });
  const stopObserving = observeWebRequests(http);
  onTestFinished(() => { stopObserving(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/practice?private=query`)).status, 502);
  assert.equal((await api.inject("/catalog?private=query")).statusCode, 200);
  assert.equal((await api.inject("/unrecognized/private-path")).statusCode, 404);
  assert.equal((await api.inject("/health")).statusCode, 200);
  assert.equal((await api.inject({
    method: "POST", url: "/practice",
    payload: { heroId: "vanguard", mode: "dungeon", encounterId: "crypt" },
  })).statusCode, 200);
  const body = await scrape(metrics);
  assert.match(body, /^http_server_request_duration_count\{component="web",http_request_method="GET",http_response_status_code="502",http_route="\/api\/practice"\} 1$/m);
  assert.match(body, /^http_server_request_duration_count\{component="api",http_request_method="GET",http_response_status_code="404"\} 1$/m);
  assert.match(body, /^pomrok_practice_fights_total\{mode="dungeon"\} 1$/m);
  assert.equal(requestCounter.exec(body)?.[1], "1");
  assert.doesNotMatch(body, /private|\/health/);
});
