export function gameApi(path: "/catalog" | "/practice", init?: RequestInit) {
  const origin = process.env.GAME_API_URL || "http://127.0.0.1:3001";
  return fetch(new URL(path, origin), { ...init, cache: "no-store", signal: AbortSignal.timeout(5000) });
}
