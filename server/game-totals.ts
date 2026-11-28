export const fightModes = ["dungeon", "bot", "pvp"] as const;
export const challengeOutcomes = ["created", "accepted", "declined", "expired"] as const;

export function emptyGameTotals() {
  return {
    fights: { dungeon: 0, bot: 0, pvp: 0 },
    challenges: { created: 0, accepted: 0, declined: 0, expired: 0 },
  };
}
