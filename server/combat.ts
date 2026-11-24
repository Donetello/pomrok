import { randomInt } from "node:crypto";
import type { Fight, Fighter, Step } from "../shared/game.ts";

export class MarbleBox {
  private available: number[] = [];

  constructor(random: (max: number) => number = randomInt) {
    this.random = random;
  }

  private readonly random: (max: number) => number;

  draw(): number {
    if (!this.available.length) this.available = [1, 2, 3, 4, 5, 6];
    const [face] = this.available.splice(this.random(this.available.length), 1);
    return face;
  }
}

type Combatant = Fighter & { current: number; wounded: boolean; bleed: number; weakened: number };
const MAX_ROUNDS = 24;

export function fight(left: Fighter, right: Fighter, box = new MarbleBox()): Fight {
  const state: [Combatant, Combatant] = [left, right].map((fighter) => ({
    ...fighter, current: fighter.hp, wounded: false, bleed: 0, weakened: 0,
  })) as [Combatant, Combatant];
  const steps: Step[] = [];
  const health = (): [number, number] => [state[0].current, state[1].current];
  const alive = () => state[0].current > 0 && state[1].current > 0;
  let round = 0;
  const log = (text: string, roll?: number) => steps.push({ round, text, hp: health(), roll });
  const initiative = left.speed === right.speed ? box.draw() : undefined;
  const first = initiative !== undefined
    ? (initiative <= 3 ? 0 : 1)
    : (left.speed > right.speed ? 0 : 1);
  const order = [first, 1 - first];
  log(`${state[first].name} takes the first turn.`, initiative);

  function checkWound(target: Combatant) {
    if (target.wounded || target.current <= 0 || target.current * 2 > target.hp) return;
    target.wounded = true;
    const roll = box.draw();
    if (roll === 1) {
      target.bleed = 2;
      log(`${target.name} is wounded and starts bleeding.`, roll);
    } else if (roll === 2) {
      target.weakened = 2;
      log(`${target.name} is wounded and weakened.`, roll);
    } else {
      log(`${target.name} is wounded but avoids a condition.`, roll);
    }
  }

  while (alive() && round < MAX_ROUNDS) {
    round++;
    for (const index of order) {
      const actor = state[index];
      const target = state[1 - index];
      if (actor.bleed > 0) {
        actor.bleed--;
        actor.current = Math.max(0, actor.current - 2);
        log(`${actor.name} loses 2 HP to bleeding.`);
        if (!alive()) break;
      }
      const penalty = actor.weakened > 0 ? 3 : 0;
      actor.weakened = Math.max(0, actor.weakened - 1);
      const roll = box.draw();
      if (roll === 1) {
        log(`${actor.name} misses ${target.name}.`, roll);
        continue;
      }
      const damage = Math.max(1, actor.attack + roll - 3 - target.armor - penalty + (roll === 6 ? 3 : 0));
      target.current = Math.max(0, target.current - damage);
      log(`${actor.name} ${roll === 6 ? "lands a critical hit on" : "hits"} ${target.name} for ${damage} damage.`, roll);
      checkWound(target);
      if (!alive()) break;
    }
  }

  const hp = health();
  const winner = hp[0] === 0 ? "right" : hp[1] === 0 ? "left" : "draw";
  const result = winner === "draw" ? "Draw" : `${winner === "left" ? left.name : right.name} wins`;
  const summary = `${result} in ${round} ${round === 1 ? "round" : "rounds"}. ${left.name} ${hp[0]}/${left.hp} HP · ${right.name} ${hp[1]}/${right.hp} HP.`;
  return { left, right, winner, hp, rounds: round, steps, summary };
}
