import type { FastifyInstance } from "fastify";
import { uptimeUserAgent, type HttpMetrics, type createMetricsServer } from "../shared/monitoring.ts";
import { challengeOutcomes, fightModes } from "./game-totals.ts";
import type { TomlStore } from "./store.ts";

const telegramMethods = new Set([
  "answerCallbackQuery", "getMe", "getUpdates", "getWebhookInfo", "sendMessage", "setChatMenuButton",
  "setMyCommands", "setWebhook", "other",
]);
const telegramResults = new Set([
  "ok", "cancelled", "timeout", "network_error", "invalid_response", "400", "401", "403", "404", "409", "429", "4xx", "5xx",
]);

export function observeFastify(app: FastifyInstance, http: HttpMetrics, component: "api" | "telegram_webhook") {
  app.addHook("onResponse", (request, reply, done) => {
    const route = request.is404 ? undefined : request.routeOptions.url;
    if (route !== "/health" && request.headers["user-agent"] !== uptimeUserAgent) {
      http.record(component, request.method, route, reply.statusCode, reply.elapsedTime / 1000);
    }
    done();
  });
}

export function createGameMetrics(meter: ReturnType<typeof createMetricsServer>["meter"]) {
  const newPlayers = meter.createObservableGauge("pomrok.players.new", { description: "Telegram profiles created within the window." });
  const activePlayers = meter.createObservableGauge("pomrok.players.active", { description: "Unique Telegram players acting within the window." });
  const telegramFights = meter.createObservableCounter("pomrok.telegram.fights", { description: "Completed Telegram fights." });
  const challenges = meter.createObservableCounter("pomrok.challenges", { description: "PvP challenges by lifecycle event." });
  const depth = meter.createObservableGauge("pomrok.telegram.outbox.depth", { description: "Telegram replies waiting to be delivered." });
  const oldest = meter.createObservableGauge("pomrok.telegram.outbox.oldest_age", {
    unit: "s", description: "Age of the oldest queued Telegram reply.",
  });
  const practice = meter.createCounter("pomrok.practice.fights", { description: "Completed web practice fights." });
  const updates = meter.createCounter("pomrok.telegram.updates", { description: "Incoming Telegram updates by processing result." });
  const telegramEnabled = meter.createGauge("pomrok.telegram.enabled", { description: "Whether a Telegram bot token is configured." });
  const telegramApi = meter.createCounter("pomrok.telegram.api.requests", { description: "Telegram Bot API requests by result." });
  const delivery = meter.createHistogram("pomrok.telegram.delivery.duration", {
    unit: "s", description: "Time from queuing a reply to successful delivery to Telegram.",
    advice: { explicitBucketBoundaries: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120] },
  });
  const saveFailures = meter.createCounter("pomrok.state.save.failures", { description: "Failed writes of the Telegram game state." });
  saveFailures.add(0);
  for (const mode of ["dungeon", "bot"]) practice.add(0, { mode });
  for (const transport of ["polling", "webhook"]) {
    for (const result of ["processed", "duplicate", "ignored", "error"]) updates.add(0, { transport, result });
  }
  for (const method of telegramMethods) {
    for (const result of telegramResults) telegramApi.add(0, { method, result });
  }

  return {
    observeStore(store: TomlStore) {
      meter.addBatchObservableCallback((observer) => {
        const now = Date.now();
        for (const { window, newPlayers: registered, activePlayers: active } of store.playerMetrics(now)) {
          observer.observe(newPlayers, registered, { window });
          observer.observe(activePlayers, active, { window });
        }
        const game = store.gameMetrics(now);
        for (const mode of fightModes) observer.observe(telegramFights, game.fights[mode], { mode });
        for (const outcome of challengeOutcomes) observer.observe(challenges, game.challenges[outcome], { outcome });
        const outbox = store.outboxMetrics(now);
        observer.observe(depth, outbox.depth);
        observer.observe(oldest, outbox.oldestAge);
      }, [newPlayers, activePlayers, telegramFights, challenges, depth, oldest]);
    },
    recordPractice(mode: "dungeon" | "bot") { practice.add(1, { mode }); },
    recordTelegramEnabled(enabled: boolean) { telegramEnabled.record(Number(enabled)); },
    recordUpdate(transport: "polling" | "webhook", result: "processed" | "duplicate" | "ignored" | "error") {
      updates.add(1, { transport, result });
    },
    recordTelegramRequest(method: string, result: string) {
      const outcome = telegramResults.has(result) ? result : result.startsWith("5") ? "5xx" : "4xx";
      telegramApi.add(1, { method: telegramMethods.has(method) ? method : "other", result: outcome });
    },
    recordDelivery(queuedAt: number) { delivery.record(Math.max(0, Date.now() - queuedAt) / 1000); },
    recordSaveFailure() { saveFailures.add(1); },
  };
}

export type GameMetrics = ReturnType<typeof createGameMetrics>;
export type ApiMetrics = { http?: HttpMetrics; game?: GameMetrics };
