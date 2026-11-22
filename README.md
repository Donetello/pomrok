# Pomrok

Pomrok is a Telegram auto-battler written in TypeScript with a Fastify game server and a Next.js browser practice ground. Enter dungeons to fight creatures, spar against arena bots, or challenge another Telegram player.

## Run with Docker

1. To enable Telegram, copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN` using a token from [BotFather](https://t.me/BotFather).
2. Run `docker compose up --build -d`.
3. Open [the practice ground](http://localhost:3000) or send `/start` in a private chat with your bot.

The browser practice ground works with an empty token. It uses the same fight engine for dungeon and bot matches. Telegram handles player duels and saves fight records. If port 3000 is in use, set `WEB_PORT` in `.env` and open that port instead. If reusing a Telegram bot that previously used a webhook, remove that webhook before running Pomrok so it can receive updates by long polling.

| Telegram command | Action |
| --- | --- |
| `/start` | Open the game menu |
| `/hero` | Choose a Vanguard, Duelist, or Hexblade |
| `/dungeon` | Choose a dungeon creature |
| `/arena` | Fight an arena bot or get the player duel command |
| `/challenge @username` | Invite another registered player |
| `/profile` | See your record and most recent fight |

Both players must open the bot before a duel. The invited player can accept or decline within 24 hours. A fight starts automatically upon acceptance and both players get the summary.

## Combat and storage

Each fighter starts at full health. Speed determines who acts first, with a D6 draw breaking a tie. The shared marble box holds one of each D6 face. A draw removes a face, and the next draw after the box is emptied refills it. An attack draw of 1 misses and a 6 adds critical damage. The first time a fighter survives damage at or below half health, a second draw can cause bleeding or weaken the next two attacks. A knockout ends the fight. A fight still running after 24 rounds is a draw. Telegram shows a short result with a button for the round log.

Edit `config/world.toml` to change classes and encounters. The API keeps Telegram players, pending challenges, latest fights, and queued messages in `state.toml` in the `game-data` Docker volume. Run one API replica per volume and bot token. Keep the volume to preserve player state across container replacements.

## Local development

Use Node.js 24 and run `npm ci`. Run `npm run dev:api` and `npm run dev` in separate terminals. The defaults are port 3001 for the game server and 3000 for the practice ground. Run `npm run check` and `npm test` to verify the game.
