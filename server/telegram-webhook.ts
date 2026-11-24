import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { World } from "../shared/game.ts";
import type { TomlStore } from "./store.ts";
import {
  applyTelegramUpdate, configureTelegramMenu, deliverTelegramMessage, telegramUsername,
  type telegramClient, type TelegramUpdate,
} from "./telegram.ts";

const path = "/telegram/webhook";
const digest = (value: string) => createHash("sha256").update(value).digest();

export function validateTelegramWebhook(url: string, secret: string) {
  const address = URL.parse(url);
  if (address?.protocol !== "https:" || address.pathname !== path
    || address.username || address.password || address.search || address.hash) {
    throw new Error("TELEGRAM_WEBHOOK_URL має бути HTTPS-адресою зі шляхом /telegram/webhook.");
  }
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(secret)) throw new Error("Некоректний TELEGRAM_WEBHOOK_SECRET.");
}

export async function ngrokWebhookUrl(apiUrl: string, signal: AbortSignal, fetcher = fetch): Promise<string> {
  const response = await fetcher(apiUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
  if (!response.ok) throw new Error("Локальний API ngrok недоступний.");
  const body = await response.json() as { tunnels?: { public_url?: string }[] };
  const address = body.tunnels?.find((tunnel) => tunnel.public_url?.startsWith("https://"))?.public_url;
  if (!address) throw new Error("ngrok ще не відкрив HTTPS-тунель.");
  return new URL(path, address).href;
}

export async function registerTelegramWebhook(
  call: ReturnType<typeof telegramClient>, url: string, secret: string, ownedUrls: string[] = [],
  rememberUrl?: (address: string) => Promise<void>,
) {
  validateTelegramWebhook(url, secret);
  const username = await telegramUsername(call);
  const current = await call<{ url: string }>("getWebhookInfo");
  if (current.url && current.url !== url && !ownedUrls.includes(current.url)) {
    throw new Error("У бота вже налаштовано інший вебхук.");
  }
  await configureTelegramMenu(call);
  await rememberUrl?.(url);
  const registered = await call<boolean>("setWebhook", {
    url, secret_token: secret, allowed_updates: ["message", "callback_query"],
    max_connections: 1, drop_pending_updates: false,
  });
  if (!registered) throw new Error("Telegram не підтвердив реєстрацію вебхука.");
  return username;
}

export function createTelegramWebhook(
  call: ReturnType<typeof telegramClient>, store: TomlStore, world: World, secret: string,
) {
  const app = Fastify({ bodyLimit: 256 * 1024 });
  const expected = digest(secret);
  let pending = Promise.resolve();
  const serialize = (operation: () => Promise<void>) => {
    const task = pending.then(operation);
    pending = task.catch(() => undefined);
    return task;
  };
  async function drain() {
    for (;;) {
      if (!await deliverTelegramMessage(call, store, app.log)) return;
    }
  }

  app.post<{ Body: TelegramUpdate }>(path, {
    async onRequest(request, reply) {
      const token = request.headers["x-telegram-bot-api-secret-token"];
      if (typeof token !== "string" || !timingSafeEqual(digest(token), expected)) {
        return reply.code(401).send();
      }
    },
    schema: { body: { type: "object", required: ["update_id"], properties: {
      update_id: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    } } },
  }, async (request, reply) => {
    try {
      await serialize(async () => {
        await applyTelegramUpdate(call, store, world, request.body, true);
        await drain();
      });
      return reply.send({ ok: true });
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  async function rememberUrl(address: string) {
    await serialize(async () => {
      const state = store.snapshot();
      const known = state.registeredWebhookUrls ?? [];
      if (!known.includes(address)) {
        state.registeredWebhookUrls = [...known, address];
        await store.save(state);
      }
    });
  }
  return { app, flush: () => serialize(drain), rememberUrl };
}
