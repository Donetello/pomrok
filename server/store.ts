import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { emptyGameTotals } from "./game-totals.ts";

export type Button = { text: string; callback_data: string };
export type Delivery = { chatId: number; text: string; keyboard: Button[][]; queuedAt?: number };
export type Player = {
  id: number;
  name: string;
  username: string;
  heroId: string;
  wins: number;
  losses: number;
  draws: number;
  createdAt?: number;
  lastActiveAt?: number;
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
  gameTotals?: ReturnType<typeof emptyGameTotals>;
};

const day = 86_400_000;
const playerWindows = [{ window: "24h", duration: day }, { window: "7d", duration: 7 * day }];

export class TomlStore {
  private readonly path: string;
  private readonly onSaveError?: () => void;
  private state: State = { lastUpdateId: -1, players: [], challenges: [], outbox: [] };
  private loadedAt = Date.now();

  constructor(directory: string, onSaveError?: () => void) {
    this.path = join(directory, "state.toml");
    this.onSaveError = onSaveError;
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
    this.loadedAt = Date.now();
  }

  snapshot(): State {
    return structuredClone(this.state);
  }

  playerMetrics(now: number) {
    return playerWindows.map(({ window, duration }) => {
      const after = now - duration;
      let newPlayers = 0;
      let activePlayers = 0;
      for (const { createdAt, lastActiveAt } of this.state.players) {
        if (createdAt !== undefined && createdAt > after && createdAt <= now) newPlayers++;
        if (lastActiveAt !== undefined && lastActiveAt > after && lastActiveAt <= now) activePlayers++;
      }
      return { window, newPlayers, activePlayers };
    });
  }

  gameMetrics(now: number) {
    const totals = this.state.gameTotals ?? emptyGameTotals();
    const pendingExpired = this.state.challenges.filter(({ expires }) => expires <= now).length;
    return { fights: totals.fights, challenges: { ...totals.challenges, expired: totals.challenges.expired + pendingExpired } };
  }

  outboxMetrics(now: number) {
    const next = this.state.outbox[0];
    return {
      depth: this.state.outbox.length,
      oldestAge: next ? Math.max(0, now - (next.queuedAt ?? this.loadedAt)) / 1000 : 0,
    };
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
      this.onSaveError?.();
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.state = next;
  }
}
