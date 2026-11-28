import Fastify from "fastify";
import type { Catalog, PracticeRequest, World } from "../shared/game.ts";
import { fightEncounter } from "./combat.ts";
import { observeFastify, type ApiMetrics } from "./monitoring.ts";

export function createApi(
  world: World,
  telegramUrl: () => string | undefined = () => undefined,
  isReady: () => boolean = () => true,
  metrics?: ApiMetrics,
) {
  const app = Fastify({ logger: true, bodyLimit: 4096 });
  if (metrics?.http) observeFastify(app, metrics.http, "api");
  app.get("/health", (_, reply) => {
    const ok = isReady();
    return reply.code(ok ? 200 : 503).send({ ok });
  });
  app.get("/catalog", (): Catalog => ({ ...world, telegramUrl: telegramUrl() }));
  app.post<{ Body: PracticeRequest }>("/practice", {
    schema: {
      body: {
        type: "object",
        required: ["heroId", "mode", "encounterId"],
        additionalProperties: false,
        properties: {
          heroId: { type: "string", maxLength: 24 },
          mode: { type: "string", enum: ["dungeon", "bot"] },
          encounterId: { type: "string", maxLength: 24 },
        },
      },
    },
  }, async ({ body }, reply) => {
    const hero = world.heroes.find(({ id }) => id === body.heroId);
    const encounter = world[body.mode].find(({ id }) => id === body.encounterId);
    if (!hero || !encounter) return reply.code(404).send({ message: "Ця зустріч або цей герой недоступні." });
    const result = fightEncounter(hero, encounter);
    metrics?.game?.recordPractice(body.mode);
    return result;
  });
  return app;
}
