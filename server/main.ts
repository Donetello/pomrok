import { resolve } from "node:path";
import { createApi } from "./api.ts";
import { TomlStore } from "./store.ts";
import { runTelegram, telegramClient } from "./telegram.ts";
import { loadWorld } from "./world.ts";

const world = await loadWorld(resolve(process.env.WORLD_PATH || "config/world.toml"));
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
let botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
const api = createApi(world, () => botUsername && /^[a-zA-Z0-9_]{1,32}$/.test(botUsername)
  ? `https://t.me/${botUsername}` : undefined);
const controller = new AbortController();
const store = new TomlStore(resolve(process.env.DATA_DIR || "data"));
if (token) await store.load();
await api.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT || 3001) });
const bot = token
  ? runTelegram(telegramClient(token, controller.signal), store, world, api.log, controller.signal,
    (username) => { botUsername = username; })
  : undefined;
if (!token) api.log.info("Telegram disabled. Browser practice remains available.");

async function shutdown() {
  controller.abort();
  await Promise.all([bot, api.close()]);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
