import { readBotToken, telegramClient, verifyPollingBot } from "./telegram.ts";

try {
  const token = readBotToken();
  if (!token) throw new Error("Задай секрет POMROK_BOT_KEY.");
  const call = telegramClient(token, AbortSignal.timeout(25_000));
  const username = await verifyPollingBot(call);
  console.log(`Telegram підтвердив @${username}. Вебхук відсутній.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Не вдалося перевірити Telegram.");
  process.exitCode = 1;
}
