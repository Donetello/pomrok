import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createApi } from "./api.ts";
import { fight, MarbleBox } from "./combat.ts";
import { TomlStore, type State } from "./store.ts";
import { handleGameInput } from "./telegram-game.ts";
import { readBotToken, runTelegram, telegramClient, verifyPollingBot } from "./telegram.ts";
import { loadWorld } from "./world.ts";

const world = await loadWorld("config/world.toml");

test("the marble box deals each D6 face once per refill", () => {
  const box = new MarbleBox((max) => max - 1);
  const cycle = [6, 5, 4, 3, 2, 1];
  assert.deepEqual(Array.from({ length: 12 }, () => box.draw()), [...cycle, ...cycle]);
});

test("either combatant can suffer a wound condition when crossing half health", () => {
  const first = { name: "Щитник", hp: 40, attack: 12, armor: 1, speed: 4 };
  const second = { name: "Олекса", hp: 40, attack: 11, armor: 2, speed: 3 };
  const faces = [6, 5, 4, 1, 3, 2, 5, 6];
  const box = new MarbleBox();
  box.draw = () => faces.shift() ?? 4;
  const result = fight(first, second, box);
  assert.ok(result.steps.some(({ text }) => text === "Олекса стікає кров’ю після поранення."));
  assert.ok(result.steps.some(({ text }) => text === "Олекса втрачає 2 ОЗ через кровотечу."));
  assert.ok(result.steps.some(({ text }) => text === "Щитник слабшає від поранення."));
  assert.ok(result.rounds <= 24);
});

test("the Fastify practice endpoint resolves encounters for both modes", async ({ onTestFinished }) => {
  const api = createApi(world);
  onTestFinished(() => api.close());
  const catalog = (await api.inject("/catalog")).json();
  assert.deepEqual(catalog.story, { ...world.story });
  for (const mode of ["dungeon", "bot"] as const) {
    const encounter = world[mode][0];
    const response = await api.inject({
      method: "POST", url: "/practice",
      payload: { heroId: "vanguard", mode, encounterId: encounter.id },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.right.name, encounter.opponent.name);
    assert.match(result.summary, /Раундів — \d+\./);
    if (result.winner !== "draw") assert.equal(result.aftermath, result.winner === "left" ? encounter.victory : encounter.defeat);
    assert.ok(result.steps.length >= 2);
    assert.ok(result.steps.every(({ hp }: { hp: number[] }) => hp.every((value) => value >= 0)));
  }
  assert.equal((await api.inject({
    method: "POST", url: "/practice",
    payload: { heroId: "vanguard", mode: "player", encounterId: "rook" },
  })).statusCode, 400);
  assert.equal((await api.inject({
    method: "POST", url: "/practice",
    payload: { heroId: "vanguard", mode: "bot", encounterId: "missing" },
  })).statusCode, 404);
});

test("a player challenge survives a restart and only the recipient can resolve it once", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const store = new TomlStore(dir);
  await store.load();
  const state = store.snapshot();
  const alice = { user: { id: 1, first_name: "Alice", username: "Alice" }, chatId: 1 };
  const bob = { user: { id: 2, first_name: "Bob", username: "Bob" }, chatId: 2 };
  handleGameInput(state, world, { ...alice, command: "/start" });
  handleGameInput(state, world, { ...bob, command: "/start" });
  handleGameInput(state, world, { ...alice, command: "/challenge @bob" });
  const invitation = state.outbox.find((message) => message.keyboard[0][0].callback_data.startsWith("accept:"));
  assert.ok(invitation);
  assert.equal(invitation.chatId, bob.chatId);
  const callback = invitation.keyboard[0][0].callback_data;
  await store.save(state);

  const reopened = new TomlStore(dir);
  await reopened.load();
  const saved = reopened.snapshot();
  assert.deepEqual(saved, state);
  saved.outbox = [];
  handleGameInput(saved, world, { ...alice, callback });
  assert.equal(saved.challenges.length, 1);
  handleGameInput(saved, world, { ...bob, callback });
  assert.equal(saved.challenges.length, 0);
  assert.equal(saved.players[0].lastFight?.summary, saved.players[1].lastFight?.summary);
  assert.ok(saved.players.every((player) => player.wins + player.losses + player.draws === 1));
  assert.deepEqual(saved.outbox.slice(-2).map((entry) => entry.chatId), [alice.chatId, bob.chatId]);
  handleGameInput(saved, world, { ...bob, callback });
  assert.ok(saved.players.every((player) => player.wins + player.losses + player.draws === 1));
  await reopened.save(saved);
  await store.load();
  assert.deepEqual(store.snapshot(), saved);
});

test("Telegram shows the shared prologue, an encounter preview, and the localized aftermath", () => {
  const state: State = { lastUpdateId: -1, players: [], challenges: [], outbox: [] };
  const player = { user: { id: 14, first_name: "Орися" }, chatId: 14 };
  handleGameInput(state, world, { ...player, command: "/start" });
  assert.ok(state.outbox.pop()?.text.includes(world.story.hook));
  handleGameInput(state, world, { ...player, command: "/story" });
  assert.ok(state.outbox.pop()?.text.includes(world.story.prologue[0]));

  handleGameInput(state, world, { ...player, command: "/dungeon" });
  const scene = state.outbox.pop()?.keyboard[0][0];
  assert.ok(scene);
  assert.equal(scene.callback_data, "scene:dungeon:crypt");
  handleGameInput(state, world, { ...player, callback: scene.callback_data });
  const preview = state.outbox.pop();
  assert.ok(preview);
  assert.ok(preview.text.includes(world.dungeon[0].description));
  assert.equal(state.players[0].lastFight, undefined);

  handleGameInput(state, world, { ...player, callback: preview.keyboard[0][0].callback_data });
  const fightMessage = state.outbox.pop();
  assert.ok(fightMessage);
  assert.ok(fightMessage.text.includes("Раундів"));
  assert.ok(fightMessage.text.includes(world.dungeon[0].victory) || fightMessage.text.includes(world.dungeon[0].defeat));
  handleGameInput(state, world, { ...player, callback: fightMessage.keyboard[0][0].callback_data });
  assert.match(state.outbox.at(-1)?.text ?? "", /Літопис бою[\s\S]*Раунд 1/);
});

test("the Docker health route waits for the bot when polling is enabled", async ({ onTestFinished }) => {
  let polling = false;
  const api = createApi(world, undefined, () => polling);
  onTestFinished(() => api.close());
  assert.equal((await api.inject("/health")).statusCode, 503);
  polling = true;
  assert.equal((await api.inject("/health")).statusCode, 200);
});

test("the Actions key takes precedence and Telegram preflight checks webhooks without polling", async () => {
  const token = readBotToken({ POMROK_BOT_KEY: " 123:fake ", TELEGRAM_BOT_TOKEN: "456:legacy" });
  assert.equal(token, "123:fake");
  assert.equal(readBotToken({ POMROK_BOT_KEY: " ", TELEGRAM_BOT_TOKEN: "456:legacy" }), "456:legacy");
  const methods: string[] = [];
  let webhookUrl = "";
  const call = telegramClient(token, new AbortController().signal, async (input) => {
    const method = new URL(input.toString()).pathname.split("/").at(-1) ?? "";
    methods.push(method);
    const result = method === "getMe" ? { is_bot: true, username: "test_bot" } : { url: webhookUrl };
    return Response.json({ ok: true, result });
  });
  assert.equal(await verifyPollingBot(call), "test_bot");
  assert.deepEqual(methods, ["getMe", "getWebhookInfo"]);
  webhookUrl = "https://example.test/telegram";
  await assert.rejects(verifyPollingBot(call), /вебхук/);
});

test("Telegram polling applies an update once and delivers its queued response", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "pomrok-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const store = new TomlStore(dir);
  await store.load();
  const controller = new AbortController();
  const api = createApi(world);
  onTestFinished(() => api.close());
  const sent: object[] = [];
  const update = {
    update_id: 42,
    callback_query: {
      id: "example",
      from: { id: 7, first_name: "Ana" },
      message: { chat: { id: 7, type: "private" } },
      data: "dungeon:crypt",
    },
  };
  let polls = 0;
  let acknowledged = 0;
  const call = async <T>(method: string, body?: object): Promise<T> => {
    if (method === "getMe") return { is_bot: true, username: "pomrok_test_bot" } as T;
    if (method === "getWebhookInfo") return { url: "" } as T;
    if (method === "setMyCommands") assert.match(JSON.stringify(body), /Дізнатися, куди подівся світанок/);
    if (method === "sendMessage") sent.push(body ?? {});
    if (method === "answerCallbackQuery") acknowledged++;
    if (method === "getUpdates") {
      polls++;
      if (polls > 2) {
        controller.abort();
        return [] as T;
      }
      return [update] as T;
    }
    return true as T;
  };
  let username = "";
  const polling: boolean[] = [];
  await runTelegram(call, store, world, api.log, controller.signal, {
    onUsername: (value) => { username = value; },
    onPolling: (ready) => polling.push(ready),
  });
  const state = store.snapshot();
  assert.equal(username, "pomrok_test_bot");
  assert.ok(polling.includes(true));
  assert.equal(acknowledged, 2);
  assert.equal(sent.length, 1);
  assert.equal(state.lastUpdateId, 42);
  assert.equal(state.outbox.length, 0);
  const [player] = state.players;
  assert.equal(player.wins + player.losses + player.draws, 1);
});
