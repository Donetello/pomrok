export type Fighter = {
  name: string;
  hp: number;
  attack: number;
  armor: number;
  speed: number;
};

export type Hero = Fighter & { id: string; description: string; mark: string };
export type Story = { title: string; hook: string; prologue: string[] };
export type Encounter = {
  id: string;
  name: string;
  description: string;
  difficulty: string;
  mark: string;
  opponent: Fighter;
  victory: string;
  defeat: string;
};

export type Mode = "dungeon" | "bot";
export type World = { story: Story; heroes: Hero[]; dungeon: Encounter[]; bot: Encounter[] };
export type Side = "left" | "right";
export type Step = {
  round: number;
  text: string;
  hp: [number, number];
  roll?: number;
};
export type Fight = {
  left: Fighter;
  right: Fighter;
  winner: Side | "draw";
  hp: [number, number];
  rounds: number;
  steps: Step[];
  summary: string;
  aftermath?: string;
};

export type Catalog = World & { telegramUrl?: string };
export type PracticeRequest = { heroId: string; mode: Mode; encounterId: string };
