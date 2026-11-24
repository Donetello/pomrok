import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import type { Fighter, World } from "../shared/game.ts";

function validFighter(value: Fighter): boolean {
  return typeof value?.name === "string" && value.name.trim().length > 0
    && Number.isSafeInteger(value.hp) && value.hp > 0
    && Number.isSafeInteger(value.attack) && value.attack > 0
    && Number.isSafeInteger(value.armor) && value.armor >= 0
    && Number.isSafeInteger(value.speed) && value.speed >= 0;
}

function validCatalog(entries: { id: string; name: string; mark: string; description: string }[]): boolean {
  return Array.isArray(entries) && entries.length > 0
    && entries.every((entry) => /^[a-z0-9-]{1,24}$/.test(entry.id)
      && typeof entry.name === "string" && entry.name.trim()
      && typeof entry.mark === "string" && typeof entry.description === "string")
    && new Set(entries.map((entry) => entry.id)).size === entries.length;
}

export async function loadWorld(path: string): Promise<World> {
  const world = parse(await readFile(path, "utf8")) as unknown as World;
  if (!validCatalog(world.heroes) || !world.heroes.every(validFighter)) {
    throw new Error("world.toml must contain valid, uniquely named hero entries.");
  }
  for (const mode of ["dungeon", "bot"] as const) {
    if (!validCatalog(world[mode]) || !world[mode].every((entry) =>
      typeof entry.difficulty === "string" && validFighter(entry.opponent))) {
      throw new Error(`world.toml contains an invalid ${mode} catalog.`);
    }
  }
  return world;
}
