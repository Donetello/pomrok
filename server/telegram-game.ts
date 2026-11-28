import { randomUUID } from "node:crypto";
import type { Fight, Mode, World } from "../shared/game.ts";
import { combatRules, roundLabel } from "../shared/uk.ts";
import { fight, fightEncounter } from "./combat.ts";
import { emptyGameTotals } from "./game-totals.ts";
import type { Button, Player, State } from "./store.ts";

export type TelegramUser = { id: number; first_name: string; username?: string };
export type GameInput = { user: TelegramUser; chatId: number; command?: string; callback?: string };

const button = (text: string, callback_data: string): Button => ({ text, callback_data });
const home = button("До корчми", "menu:home");
const menu = [
  [button("Лісові пригоди", "menu:dungeon"), button("Двобої", "menu:arena")],
  [button("Обрати героя", "menu:hero"), button("Мій літопис", "menu:profile")],
  [button("Куди подівся світанок", "menu:story")],
];
const label = (player: Player) => player.username ? `@${player.username}` : player.name;

function fightPages(result: Fight): string[] {
  const pages: string[] = [];
  let page = "";
  let previousRound = -1;
  for (const step of result.steps) {
    const heading = step.round !== previousRound ? `\n${roundLabel(step.round)}\n` : "";
    const line = `${step.text}${step.roll === undefined ? "" : ` [випало ${step.roll}]`}\n`;
    if (page.length + heading.length + line.length > 3000) {
      pages.push(page.trim());
      page = `${roundLabel(step.round)}\n`;
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
    state.outbox.push({ chatId, text, keyboard, queuedAt: now });
  const rawCommand = input.command?.trim().split(/\s+/) ?? [];
  const command = rawCommand[0]?.split("@")[0]?.toLowerCase();
  const [action, value, detail] = input.callback?.split(":") ?? [];
  if (!input.callback && !command?.startsWith("/")) return;

  const totals = state.gameTotals ??= emptyGameTotals();
  const pending = state.challenges.filter((challenge) => challenge.expires > now);
  totals.challenges.expired += state.challenges.length - pending.length;
  state.challenges = pending;
  let player = state.players.find(({ id }) => id === input.user.id);
  if (!player) {
    player = {
      id: input.user.id, name: input.user.first_name, username: input.user.username ?? "",
      heroId: world.heroes[0].id, wins: 0, losses: 0, draws: 0,
      createdAt: now,
    };
    state.players.push(player);
  }
  player.name = input.user.first_name;
  player.username = input.user.username ?? "";
  player.lastActiveAt = now;
  const currentPlayer = player;
  const heroFor = (owner: Player) => world.heroes.find(({ id }) => id === owner.heroId) ?? world.heroes[0];
  const combatant = (owner: Player) => ({ ...heroFor(owner), name: label(owner) });

  function finish(result: Fight, challenger: Player, opponent?: Player) {
    const report = { id: randomUUID(), language: "uk" as const, summary: result.summary, pages: fightPages(result) };
    const participants = [challenger];
    if (opponent) participants.push(opponent);
    for (const [index, participant] of participants.entries()) {
      const side = index === 0 ? "left" : "right";
      if (result.winner === "draw") participant.draws++;
      else if (result.winner === side) participant.wins++;
      else participant.losses++;
      participant.lastFight = report;
      const text = result.aftermath ? `${report.summary}\n\n${result.aftermath}` : report.summary;
      say(text, [[button("Ходи бою", `log:${report.id}:0`)], ...menu], participant.id);
    }
  }

  function encounters(mode: Mode) {
    const title = mode === "dungeon" ? "Куди підеш шукати світанок?" : "З ким станеш до двобою?";
    say(title, [
      ...world[mode].map((entry) => [button(`${entry.name} · ${entry.difficulty}`, `scene:${mode}:${entry.id}`)]),
      [home],
    ]);
  }

  if (action === "log") {
    const log = currentPlayer.lastFight;
    const index = Number(detail);
    if (log?.language !== "uk" || log.id !== value || !Number.isInteger(index) || !log.pages[index]) {
      say("Цей запис недоступний. Останній бій шукай у своєму літописі.");
      return;
    }
    const navigation: Button[] = [];
    if (index > 0) navigation.push(button("Назад", `log:${log.id}:${index - 1}`));
    if (index + 1 < log.pages.length) navigation.push(button("Далі", `log:${log.id}:${index + 1}`));
    say(`Літопис бою · ${index + 1}/${log.pages.length}\n\n${log.pages[index]}`, navigation.length ? [navigation, [home]] : [[home]]);
    return;
  }

  if (action === "accept" || action === "decline") {
    const challenge = state.challenges.find(({ id, to }) => id === value && to === currentPlayer.id);
    const challenger = state.players.find(({ id }) => id === challenge?.from);
    if (!challenge || !challenger) {
      say("Цей виклик уже недійсний.");
      return;
    }
    state.challenges = state.challenges.filter(({ id }) => id !== challenge.id);
    if (action === "decline") {
      totals.challenges.declined++;
      say("Виклик відхилено.");
      say(`${label(currentPlayer)} відхиляє твій виклик.`, menu, challenger.id);
    } else {
      finish(fight(combatant(challenger), combatant(currentPlayer)), challenger, currentPlayer);
      totals.challenges.accepted++;
      totals.fights.pvp++;
    }
    return;
  }

  if (action === "scene" && (value === "dungeon" || value === "bot")) {
    const encounter = world[value].find(({ id }) => id === detail);
    if (!encounter) say("Ця пригода вже недоступна.");
    else say(`${encounter.name}\n\n${encounter.description}\n\nСуперник — ${encounter.opponent.name}`, [
      [button("До бою", `${value}:${encounter.id}`)],
      [button("Інша зустріч", value === "dungeon" ? "menu:dungeon" : "menu:bots"), home],
    ]);
    return;
  }

  if (action === "dungeon" || action === "bot") {
    const encounter = world[action].find(({ id }) => id === value);
    if (!encounter) say("Ця пригода вже недоступна.");
    else {
      finish(fightEncounter(combatant(currentPlayer), encounter), currentPlayer);
      totals.fights[action]++;
    }
    return;
  }

  if (action === "hero") {
    const hero = world.heroes.find(({ id }) => id === value);
    if (hero) currentPlayer.heroId = hero.id;
    say(hero ? `Твій герой — ${hero.name}.` : "Цей герой недоступний.");
    return;
  }

  if (command === "/challenge") {
    const username = rawCommand[1]?.toLowerCase();
    if (!username || !/^@[a-z0-9_]{1,32}$/.test(username)) {
      say("Напиши /challenge @username. Суперник має спершу відкрити «Помрок».");
      return;
    }
    const target = state.players.find((candidate) => candidate.username.toLowerCase() === username.slice(1));
    if (!target || target.id === currentPlayer.id) {
      say("Обери іншого гравця, який уже відкрив гру й має ім’я користувача в Telegram.");
      return;
    }
    const id = randomUUID();
    const exists = state.challenges.some((entry) =>
      (entry.from === currentPlayer.id && entry.to === target.id)
      || (entry.from === target.id && entry.to === currentPlayer.id));
    if (exists || state.challenges.filter((entry) => entry.from === currentPlayer.id).length >= 3) {
      say(exists ? "Ви вже маєте незавершений виклик." : "Зачекай відповіді на один із трьох своїх викликів.");
      return;
    }
    state.challenges.push({ id, from: currentPlayer.id, to: target.id, expires: now + 86_400_000 });
    totals.challenges.created++;
    say(`${label(currentPlayer)} кличе тебе на двобій. Маєш 24 години на відповідь.`,
      [[button("Прийняти", `accept:${id}`), button("Відхилити", `decline:${id}`)]], target.id);
    say(`Виклик для ${label(target)} надіслано.`);
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
      say("На майдані вже чекають суперники. А щоб викликати іншого гравця, напиши /challenge @username.", [
        [button("Битися з ботом", "menu:bots")], [home],
      ]);
      return;
    case "hero":
      say(`Твій герой — ${heroFor(currentPlayer).name}\n\n${world.heroes.map((entry) => `${entry.name} · ${entry.description}`).join("\n")}`,
        [...world.heroes.map((entry) => [button(entry.name, `hero:${entry.id}`)]), [home]]);
      return;
    case "profile": {
      const latest = currentPlayer.lastFight?.language === "uk" ? currentPlayer.lastFight : undefined;
      const tally = `Перемоги — ${currentPlayer.wins} · Поразки — ${currentPlayer.losses} · Нічиї — ${currentPlayer.draws}`;
      say(`${label(currentPlayer)} · ${heroFor(currentPlayer).name}\n${tally}${latest ? `\n\nОстанній бій\n${latest.summary}` : ""}`,
        latest ? [[button("Ходи останнього бою", `log:${latest.id}:0`)], ...menu] : menu);
      return;
    }
    case "story":
      say([world.story.title, ...world.story.prologue].join("\n\n"));
      return;
    case "help":
      say(["Обери героя й зустріч. Бій відбудеться сам, а ходи запише літописець.", ...combatRules].join("\n\n"));
      return;
    default:
      say(`Помрок\n\n${world.story.hook}`);
  }
}
