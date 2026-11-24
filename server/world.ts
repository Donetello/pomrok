import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import type { Fighter, World } from "../shared/game.ts";

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validFighter(value: Fighter): boolean {
  return nonempty(value?.name)
    && Number.isSafeInteger(value.hp) && value.hp > 0
    && Number.isSafeInteger(value.attack) && value.attack > 0
    && Number.isSafeInteger(value.armor) && value.armor >= 0
    && Number.isSafeInteger(value.speed) && value.speed >= 0;
}

function validCatalog(entries: { id: string; name: string; mark: string; description: string }[]): boolean {
  return Array.isArray(entries) && entries.length > 0
    && entries.every((entry) => typeof entry.id === "string" && /^[a-z0-9-]{1,24}$/.test(entry.id)
      && nonempty(entry.name) && nonempty(entry.mark) && nonempty(entry.description))
    && new Set(entries.map((entry) => entry.id)).size === entries.length;
}

export async function loadWorld(path: string): Promise<World> {
  const world = parse(await readFile(path, "utf8")) as unknown as World;
  const story = world.story;
  if (!nonempty(story?.title) || !nonempty(story?.hook)
    || !Array.isArray(story.prologue) || !story.prologue.length || !story.prologue.every(nonempty)) {
    throw new Error("world.toml must contain a story with a title, hook, and prologue.");
  }
  if (!validCatalog(world.heroes) || !world.heroes.every(validFighter)) {
    throw new Error("world.toml must contain valid, uniquely named hero entries.");
  }
  for (const mode of ["dungeon", "bot"] as const) {
    if (!validCatalog(world[mode]) || !world[mode].every((entry) =>
      nonempty(entry.difficulty) && nonempty(entry.victory) && nonempty(entry.defeat) && validFighter(entry.opponent))) {
      throw new Error(`world.toml contains an invalid ${mode} catalog.`);
    }
  }
  return world;
}
