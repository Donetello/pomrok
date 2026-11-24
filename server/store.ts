import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

export type Button = { text: string; callback_data: string };
export type Delivery = { chatId: number; text: string; keyboard: Button[][] };
export type Player = {
  id: number;
  name: string;
  username: string;
  heroId: string;
  wins: number;
  losses: number;
  draws: number;
  lastFight?: { id: string; language?: "uk"; summary: string; pages: string[] };
};
export type Challenge = { id: string; from: number; to: number; expires: number };
export type State = {
  lastUpdateId: number;
  recentWebhookUpdates?: number[];
  registeredWebhookUrls?: string[];
  players: Player[];
  challenges: Challenge[];
  outbox: Delivery[];
};

export class TomlStore {
  private readonly path: string;
  private state: State = { lastUpdateId: -1, players: [], challenges: [], outbox: [] };

  constructor(directory: string) {
    this.path = join(directory, "state.toml");
  }

  async load() {
    await mkdir(dirname(this.path), { recursive: true });
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = parse(source) as unknown as State;
    if (!Number.isSafeInteger(state.lastUpdateId) || !Array.isArray(state.players)
      || !Array.isArray(state.challenges) || !Array.isArray(state.outbox)) {
      throw new Error("Unexpected player state format in state.toml.");
    }
    this.state = state;
  }

  snapshot(): State {
    return structuredClone(this.state);
  }

  async save(next: State) {
    const temp = `${this.path}.tmp`;
    try {
      const file = await open(temp, "w", 0o600);
      try {
        await file.writeFile(stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.state = next;
  }
}
