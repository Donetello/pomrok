import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configuredMetricsServer, createHttpMetrics } from "../shared/monitoring.ts";
import { createApi } from "./api.ts";
import { createGameMetrics } from "./monitoring.ts";
import { TomlStore } from "./store.ts";
import { createTelegramWebhook, ngrokWebhookUrl, registerTelegramWebhook, validateTelegramWebhook } from "./telegram-webhook.ts";
import { readBotToken, runTelegram, telegramClient } from "./telegram.ts";
import { loadWorld } from "./world.ts";

const world = await loadWorld(resolve(process.env.WORLD_PATH || "config/world.toml"));
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim();
const ngrokApiUrl = process.env.TELEGRAM_NGROK_API_URL?.trim();
const webhookEnabled = Boolean(webhookUrl || ngrokApiUrl);
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
const token = webhookEnabled ? process.env.POMROK_BOT_KEY?.trim() : readBotToken();
if (webhookEnabled) {
  if (!token) throw new Error("Задай POMROK_BOT_KEY для вебхука Помроку.");
  validateTelegramWebhook(webhookUrl || "https://localhost/telegram/webhook", webhookSecret);
}
let botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
let telegramReady = !token;
const metricsServer = configuredMetricsServer();
const metrics = metricsServer && {
  game: createGameMetrics(metricsServer.meter),
  http: createHttpMetrics(metricsServer.meter, token && webhookEnabled ? ["api", "telegram_webhook"] : ["api"]),
};
const api = createApi(world, () => botUsername && /^[a-zA-Z0-9_]{1,32}$/.test(botUsername)
  ? `https://t.me/${botUsername}` : undefined, () => telegramReady, metrics);
const controller = new AbortController();
const call = token ? telegramClient(token, controller.signal, fetch, metrics?.game) : undefined;
const store = new TomlStore(resolve(process.env.DATA_DIR || "data"), metrics?.game.recordSaveFailure);
if (call) await store.load();
metrics?.game.observeStore(store);
metrics?.game.recordTelegramEnabled(Boolean(call));
await api.listen({ host: "0.0.0.0", port: Number(process.env.API_PORT || 3001) });
const webhook = call && webhookEnabled ? createTelegramWebhook(call, store, world, webhookSecret, metrics) : undefined;
if (webhook) await webhook.app.listen({ host: "0.0.0.0", port: 3002 });
void metricsServer?.start().catch((error: unknown) => {
  api.log.error({ err: error }, "Pomrok metrics exporter could not start");
});

async function startWebhook(client: NonNullable<typeof call>, listener: NonNullable<typeof webhook>) {
  let registered: string | undefined;
  while (!controller.signal.aborted) {
    try {
      const address = ngrokApiUrl ? await ngrokWebhookUrl(ngrokApiUrl, controller.signal) : webhookUrl;
      if (!address) throw new Error("Вебхук не має HTTPS-адреси.");
      if (address !== registered) {
        botUsername = await registerTelegramWebhook(
          client, address, webhookSecret, store.snapshot().registeredWebhookUrls, listener.rememberUrl,
        );
        await listener.flush();
        registered = address;
        api.log.info("Telegram webhook is ready");
      }
      telegramReady = true;
      if (!ngrokApiUrl) return;
    } catch (error) {
      if (controller.signal.aborted) return;
      telegramReady = false;
      api.log.warn({ message: error instanceof Error ? error.message : "Unknown error" }, "Telegram webhook will retry");
    }
    await delay(5000, undefined, { signal: controller.signal }).catch(() => undefined);
  }
}

const bot = call && webhook ? startWebhook(call, webhook)
  : call
  ? runTelegram(call, store, world, api.log, controller.signal, {
    onUsername: (username) => { botUsername = username; },
    onPolling: (ready) => { telegramReady = ready; },
  }, metrics?.game)
  : undefined;
if (!call) api.log.info("Telegram disabled. Browser practice remains available.");

async function shutdown() {
  controller.abort();
  await Promise.all([bot, api.close(), webhook?.app.close(), metricsServer?.shutdown()]);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
