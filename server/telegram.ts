import { setTimeout as delay } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import type { World } from "../shared/game.ts";
import type { TomlStore } from "./store.ts";
import { handleGameInput, type TelegramUser } from "./telegram-game.ts";

type Chat = { id: number; type: string };
export type TelegramUpdate = {
  update_id: number;
  message?: { from?: TelegramUser; chat: Chat; text?: string };
  callback_query?: { id: string; from: TelegramUser; message?: { chat: Chat }; data?: string };
};
type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  parameters?: { retry_after?: number };
};

class TelegramError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(status: number, retryAfter?: number) {
    super(`Telegram returned HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function telegramClient(token: string, signal: AbortSignal, fetcher = fetch) {
  if (!/^\d+:[a-zA-Z0-9_-]+$/.test(token)) throw new Error("Некоректний формат токена Telegram.");
  return async function call<T>(method: string, body: object = {}): Promise<T> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(method === "getUpdates" ? 40_000 : 12_000)]);
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      throw new Error(`Telegram network request failed (${method})`);
    }
    const content = await response.json().catch(() => null) as TelegramResponse<T> | null;
    if (!response.ok || !content?.ok) {
      throw new TelegramError(content?.error_code ?? response.status, content?.parameters?.retry_after);
    }
    return content.result as T;
  };
}

export function readBotToken(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  return env.POMROK_BOT_KEY?.trim() || env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
}

export async function telegramUsername(call: ReturnType<typeof telegramClient>): Promise<string> {
  const bot = await call<{ is_bot: boolean; username?: string }>("getMe");
  if (!bot.is_bot || !bot.username || !/^[a-zA-Z0-9_]{1,32}$/.test(bot.username)) {
    throw new Error("Telegram не повернув дійсного імені бота.");
  }
  return bot.username;
}

export async function verifyPollingBot(call: ReturnType<typeof telegramClient>): Promise<string> {
  const username = await telegramUsername(call);
  const webhook = await call<{ url: string }>("getWebhookInfo");
  if (webhook.url) throw new Error("У бота вже є вебхук. Вимкни його перед запуском опитування.");
  return username;
}

export async function configureTelegramMenu(call: ReturnType<typeof telegramClient>) {
  await call("setMyCommands", { commands: [
    { command: "start", description: "Зайти до корчми" },
    { command: "menu", description: "Відкрити меню Помроку" },
    { command: "story", description: "Дізнатися, куди подівся світанок" },
    { command: "dungeon", description: "Рушити в лісову пригоду" },
    { command: "arena", description: "Обрати суперника для двобою" },
    { command: "challenge", description: "Викликати гравця за іменем @username" },
    { command: "hero", description: "Обрати героя" },
    { command: "profile", description: "Відкрити свій літопис" },
    { command: "help", description: "Прочитати правила бою" },
  ] });
  await call("setChatMenuButton", { menu_button: { type: "commands" } });
}

export async function applyTelegramUpdate(
  call: ReturnType<typeof telegramClient>, store: TomlStore, world: World, update: TelegramUpdate,
  webhook = false,
) {
  const state = store.snapshot();
  const callback = update.callback_query;
  if (callback) await call("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
  const chat = callback?.message?.chat ?? update.message?.chat;
  const user = callback?.from ?? update.message?.from;
  const seen = state.recentWebhookUpdates ?? [];
  if (state.lastUpdateId === update.update_id || (webhook && seen.includes(update.update_id))) return;
  if (chat?.type !== "private" || !user) return;

  handleGameInput(state, world, {
    user, chatId: chat.id, command: update.message?.text, callback: callback?.data,
  });
  state.lastUpdateId = update.update_id;
  if (webhook) state.recentWebhookUpdates = [...seen.slice(-255), update.update_id];
  await store.save(state);
}

export async function deliverTelegramMessage(
  call: ReturnType<typeof telegramClient>, store: TomlStore, logger: FastifyBaseLogger,
): Promise<boolean> {
  const state = store.snapshot();
  const delivery = state.outbox[0];
  if (!delivery) return false;
  try {
    await call("sendMessage", {
      chat_id: delivery.chatId,
      text: delivery.text,
      ...(delivery.keyboard.length ? { reply_markup: { inline_keyboard: delivery.keyboard } } : {}),
    });
  } catch (error) {
    if (!(error instanceof TelegramError) || ![400, 403].includes(error.status)) throw error;
    logger.warn({ chatId: delivery.chatId, status: error.status }, "Telegram could not deliver a game message");
  }
  state.outbox.shift();
  await store.save(state);
  return true;
}

export async function runTelegram(
  call: ReturnType<typeof telegramClient>, store: TomlStore, world: World,
  logger: FastifyBaseLogger, signal: AbortSignal,
  callbacks: { onUsername: (name: string) => void; onPolling: (ready: boolean) => void },
) {
  let offset: number | undefined;
  let configured = false;
  while (!signal.aborted) {
    try {
      if (!configured) {
        const username = await verifyPollingBot(call);
        await configureTelegramMenu(call);
        callbacks.onUsername(username);
        configured = true;
        logger.info("Telegram bot is ready");
      }

      if (await deliverTelegramMessage(call, store, logger)) continue;

      const updates = await call<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: offset === undefined ? 25 : 0,
        limit: 1,
        allowed_updates: ["message", "callback_query"],
      });
      callbacks.onPolling(true);
      const update = updates[0];
      if (!update) {
        offset = undefined;
        continue;
      }

      await applyTelegramUpdate(call, store, world, update);
      offset = update.update_id + 1;
    } catch (error) {
      if (signal.aborted) break;
      callbacks.onPolling(false);
      const telegramError = error instanceof TelegramError ? error : undefined;
      logger.warn({ message: error instanceof Error ? error.message : "Unknown error" }, "Telegram will retry");
      await delay((telegramError?.retryAfter ?? 3) * 1000, undefined, { signal }).catch(() => undefined);
    }
  }
}
