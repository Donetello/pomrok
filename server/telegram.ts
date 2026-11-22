import { setTimeout as delay } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import type { World } from "../shared/game.ts";
import type { TomlStore } from "./store.ts";
import { handleGameInput, type TelegramUser } from "./telegram-game.ts";

type Chat = { id: number; type: string };
type Update = {
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
  return async function call<T>(method: string, body: object = {}): Promise<T> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(method === "getUpdates" ? 40_000 : 12_000)]);
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      throw new Error(`Telegram network request failed (${method})`);
    }
    const content = await response.json() as TelegramResponse<T>;
    if (!content.ok) {
      throw new TelegramError(content.error_code ?? response.status, content.parameters?.retry_after);
    }
    return content.result as T;
  };
}

export async function runTelegram(
  call: ReturnType<typeof telegramClient>, store: TomlStore, world: World,
  logger: FastifyBaseLogger, signal: AbortSignal, setUsername: (name: string) => void,
) {
  let offset: number | undefined;
  let configured = false;
  while (!signal.aborted) {
    try {
      if (!configured) {
        const identity = await call<{ username: string }>("getMe");
        setUsername(identity.username);
        await call("setMyCommands", { commands: [
          { command: "start", description: "Open Pomrok" },
          { command: "dungeon", description: "Enter a dungeon" },
          { command: "arena", description: "Choose an arena opponent" },
          { command: "challenge", description: "Challenge a player by @username" },
          { command: "hero", description: "Choose your hero" },
          { command: "profile", description: "View your record and latest fight" },
          { command: "help", description: "Read the combat rules" },
        ] });
        configured = true;
        logger.info("Telegram bot is ready");
      }

      const state = store.snapshot();
      const delivery = state.outbox[0];
      if (delivery) {
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
        continue;
      }

      const updates = await call<Update[]>("getUpdates", {
        offset,
        timeout: offset === undefined ? 25 : 0,
        limit: 1,
        allowed_updates: ["message", "callback_query"],
      });
      const update = updates[0];
      if (!update) {
        offset = undefined;
        continue;
      }

      const callback = update.callback_query;
      if (callback) {
        await call("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
      }
      const chat = callback?.message?.chat ?? update.message?.chat;
      const user = callback?.from ?? update.message?.from;
      if (state.lastUpdateId !== update.update_id && chat?.type === "private" && user) {
        handleGameInput(state, world, {
          user, chatId: chat.id, command: update.message?.text, callback: callback?.data,
        });
        state.lastUpdateId = update.update_id;
        await store.save(state);
      }
      offset = update.update_id + 1;
    } catch (error) {
      if (signal.aborted) break;
      const telegramError = error instanceof TelegramError ? error : undefined;
      logger.warn({ message: error instanceof Error ? error.message : "Unknown error" }, "Telegram will retry");
      await delay((telegramError?.retryAfter ?? 3) * 1000, undefined, { signal }).catch(() => undefined);
    }
  }
}
