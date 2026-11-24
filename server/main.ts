import { resolve } from "node:path";
import { createApi } from "./api.ts";
import { TomlStore } from "./store.ts";
import { readBotToken, runTelegram, telegramClient } from "./telegram.ts";
import { loadWorld } from "./world.ts";

const world = await loadWorld(resolve(process.env.WORLD_PATH || "config/world.toml"));
const token = readBotToken();
let botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
let polling = !token;
const api = createApi(world, () => botUsername && /^[a-zA-Z0-9_]{1,32}$/.test(botUsername)
  ? `https://t.me/${botUsername}` : undefined, () => polling);
const controller = new AbortController();
const call = token ? telegramClient(token, controller.signal) : undefined;
const store = new TomlStore(resolve(process.env.DATA_DIR || "data"));
if (call) await store.load();
await api.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT || 3001) });
const bot = call
  ? runTelegram(call, store, world, api.log, controller.signal, {
    onUsername: (username) => { botUsername = username; },
    onPolling: (ready) => { polling = ready; },
  })
  : undefined;
if (!call) api.log.info("Telegram disabled. Browser practice remains available.");

async function shutdown() {
  controller.abort();
  await Promise.all([bot, api.close()]);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
