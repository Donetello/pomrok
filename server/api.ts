import Fastify from "fastify";
import type { Catalog, PracticeRequest, World } from "../shared/game.ts";
import { fight } from "./combat.ts";

export function createApi(world: World, telegramUrl: () => string | undefined = () => undefined) {
  const app = Fastify({ logger: true, bodyLimit: 4096 });
  app.get("/health", () => ({ ok: true }));
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
    if (!hero || !encounter) return reply.code(404).send({ message: "Hero or encounter unavailable." });
    return fight(hero, encounter.opponent);
  });
  return app;
}
