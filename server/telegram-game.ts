import { randomUUID } from "node:crypto";
import type { Fight, Mode, World } from "../shared/game.ts";
import { fight } from "./combat.ts";
import type { Button, Player, State } from "./store.ts";

export type TelegramUser = { id: number; first_name: string; username?: string };
export type GameInput = { user: TelegramUser; chatId: number; command?: string; callback?: string };

const button = (text: string, callback_data: string): Button => ({ text, callback_data });
const menu = [
  [button("Dungeons", "menu:dungeon"), button("Arena", "menu:arena")],
  [button("Choose hero", "menu:hero"), button("Profile", "menu:profile")],
];
const label = (player: Player) => player.username ? `@${player.username}` : player.name;

function fightPages(result: Fight): string[] {
  const pages: string[] = [];
  let page = "";
  let previousRound = 0;
  for (const step of result.steps) {
    const heading = step.round !== previousRound ? `\nRound ${step.round}\n` : "";
    const line = `${step.text}${step.roll === undefined ? "" : ` [D6 ${step.roll}]`}\n`;
    if (page.length + heading.length + line.length > 3000) {
      pages.push(page.trim());
      page = `Round ${step.round}\n`;
    } else {
      page += heading;
    }
    page += line;
    previousRound = step.round;
  }
  if (page) pages.push(page.trim());
  return pages;
}

export function handleGameInput(state: State, world: World, input: GameInput, now = Date.now()) {
  const say = (text: string, keyboard: Button[][] = menu, chatId = input.chatId) =>
    state.outbox.push({ chatId, text, keyboard });
  const rawCommand = input.command?.trim().split(/\s+/) ?? [];
  const command = rawCommand[0]?.split("@")[0]?.toLowerCase();
  const [action, value, pageNumber] = input.callback?.split(":") ?? [];
  if (!input.callback && !command?.startsWith("/")) return;

  state.challenges = state.challenges.filter((challenge) => challenge.expires > now);
  let player = state.players.find(({ id }) => id === input.user.id);
  if (!player) {
    player = {
      id: input.user.id, name: input.user.first_name, username: input.user.username ?? "",
      heroId: world.heroes[0].id, wins: 0, losses: 0, draws: 0,
    };
    state.players.push(player);
  }
  player.name = input.user.first_name;
  player.username = input.user.username ?? "";
  const currentPlayer = player;
  const heroFor = (owner: Player) => world.heroes.find(({ id }) => id === owner.heroId) ?? world.heroes[0];
  const combatant = (owner: Player) => ({ ...heroFor(owner), name: label(owner) });

  function finish(result: Fight, challenger: Player, opponent?: Player) {
    const report = { id: randomUUID(), summary: result.summary, pages: fightPages(result) };
    const participants = [challenger];
    if (opponent) participants.push(opponent);
    for (const [index, participant] of participants.entries()) {
      const side = index === 0 ? "left" : "right";
      if (result.winner === "draw") participant.draws++;
      else if (result.winner === side) participant.wins++;
      else participant.losses++;
      participant.lastFight = report;
      say(report.summary, [[button("View rounds", `log:${report.id}:0`)], ...menu], participant.id);
    }
  }

  function encounters(mode: Mode) {
    const title = mode === "dungeon" ? "Choose a dungeon." : "Choose an arena bot.";
    say(title, [
      ...world[mode].map((entry) => [button(`${entry.name} · ${entry.difficulty}`, `${mode}:${entry.id}`)]),
      [button("Main menu", "menu:home")],
    ]);
  }

  if (action === "log") {
    const log = currentPlayer.lastFight;
    const index = Number(pageNumber);
    if (!log || log.id !== value || !Number.isInteger(index) || !log.pages[index]) {
      say("This fight log is unavailable. Open your profile for your latest fight.");
      return;
    }
    const navigation: Button[] = [];
    if (index > 0) navigation.push(button("Previous", `log:${log.id}:${index - 1}`));
    if (index + 1 < log.pages.length) navigation.push(button("Next", `log:${log.id}:${index + 1}`));
    say(`Fight log · ${index + 1}/${log.pages.length}\n\n${log.pages[index]}`, navigation.length ? [navigation] : []);
    return;
  }

  if (action === "accept" || action === "decline") {
    const challenge = state.challenges.find(({ id, to }) => id === value && to === currentPlayer.id);
    const challenger = state.players.find(({ id }) => id === challenge?.from);
    if (!challenge || !challenger) {
      say("This challenge is no longer available.");
      return;
    }
    state.challenges = state.challenges.filter(({ id }) => id !== challenge.id);
    if (action === "decline") {
      say("Challenge declined.");
      say(`${label(currentPlayer)} declined your challenge.`, menu, challenger.id);
    } else {
      finish(fight(combatant(challenger), combatant(currentPlayer)), challenger, currentPlayer);
    }
    return;
  }

  if (action === "dungeon" || action === "bot") {
    const encounter = world[action].find(({ id }) => id === value);
    if (!encounter) say("This encounter is unavailable.");
    else finish(fight(combatant(currentPlayer), encounter.opponent), currentPlayer);
    return;
  }

  if (action === "hero") {
    const hero = world.heroes.find(({ id }) => id === value);
    if (hero) currentPlayer.heroId = hero.id;
    say(hero ? `Your hero is now ${hero.name}.` : "This hero is unavailable.");
    return;
  }

  if (command === "/challenge") {
    const username = rawCommand[1]?.toLowerCase();
    if (!username || !/^@[a-z0-9_]{1,32}$/.test(username)) {
      say("Use /challenge @username. Your opponent needs to have opened Pomrok.");
      return;
    }
    const target = state.players.find((candidate) => candidate.username.toLowerCase() === username.slice(1));
    if (!target || target.id === currentPlayer.id) {
      say("Choose another registered player with a Telegram username.");
      return;
    }
    const id = randomUUID();
    const exists = state.challenges.some((entry) =>
      (entry.from === currentPlayer.id && entry.to === target.id)
      || (entry.from === target.id && entry.to === currentPlayer.id));
    if (exists || state.challenges.filter((entry) => entry.from === currentPlayer.id).length >= 3) {
      say("You have a pending challenge with this player or have reached your pending limit.");
      return;
    }
    state.challenges.push({ id, from: currentPlayer.id, to: target.id, expires: now + 86_400_000 });
    say(`${label(currentPlayer)} challenged you to a duel. This challenge expires in 24 hours.`,
      [[button("Accept", `accept:${id}`), button("Decline", `decline:${id}`)]], target.id);
    say(`Challenge sent to ${label(target)}.`);
    return;
  }

  const screen = action === "menu" ? value : command?.slice(1);
  switch (screen) {
    case "dungeon":
      encounters("dungeon");
      return;
    case "bots":
      encounters("bot");
      return;
    case "arena":
      say("Fight an arena bot or use /challenge @username to duel another Telegram player.", [
        [button("Fight a bot", "menu:bots")], [button("Main menu", "menu:home")],
      ]);
      return;
    case "hero":
      say(`Current hero · ${heroFor(currentPlayer).name}\n\n${world.heroes.map((entry) => `${entry.name} · ${entry.description}`).join("\n")}`,
        world.heroes.map((entry) => [button(entry.name, `hero:${entry.id}`)]));
      return;
    case "profile": {
      const latest = currentPlayer.lastFight;
      const tally = `${currentPlayer.wins} wins · ${currentPlayer.losses} losses · ${currentPlayer.draws} draws`;
      say(`${label(currentPlayer)} · ${heroFor(currentPlayer).name}\n${tally}${latest ? `\n\nLatest fight\n${latest.summary}` : ""}`,
        latest ? [[button("View latest rounds", `log:${latest.id}:0`)], ...menu] : menu);
      return;
    }
    case "help":
      say("Pick a hero, then enter a dungeon or the arena. Fights resolve automatically. Every six D6 draws use each face once. At half health, a combatant can start bleeding or become weakened.");
      return;
    default:
      say("Welcome to Pomrok. Enter a dungeon or challenge a rival in the arena.");
  }
}
