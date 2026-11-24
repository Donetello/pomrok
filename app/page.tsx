import Link from "next/link";
import type { Catalog } from "../shared/game";
import { gameApi } from "./game-api";
import { Arena } from "./arena";

export const dynamic = "force-dynamic";

export default async function Page() {
  let catalog: Catalog | undefined;
  try {
    const response = await gameApi("/catalog");
    if (response.ok) catalog = await response.json();
  } catch {
    // The page can still explain how to reach the game while the API starts.
  }

  return (
    <div className="shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Pomrok home">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span>Pomrok</span>
        </Link>
        {catalog?.telegramUrl
          ? <a className="telegram-link" href={catalog.telegramUrl}>Play on Telegram</a>
          : <span className="telegram-status">Telegram auto-battler</span>}
      </header>
      <main>
        <section className="hero">
          <div className="hero-inner">
            <p className="eyebrow"><span aria-hidden="true">✦</span> The practice grounds</p>
            <h1>Pomrok</h1>
            <p className="hero-copy">Venture into the dark or face a rival in the arena. Every strike comes from the marble box.</p>
            {catalog && <a className="hero-link" href="#battleground">Choose a battleground</a>}
          </div>
        </section>
        {catalog
          ? <Arena catalog={catalog} />
          : <section className="unavailable"><h2>The arena is unavailable</h2><form action="/"><button>Reload the game</button></form></section>}
        <details className="rules">
          <summary>Combat rules</summary>
          <p>The faster fighter opens. On a speed tie, a D6 draw decides who goes first. The fighters take turns until one falls or 24 rounds pass.</p>
          <p>The marble box holds one of each D6 face. Each draw removes a face, and the box refills when empty. A 1 misses and a 6 lands a critical hit.</p>
          <p>The first time a fighter survives a hit at or below half health, another draw checks for a wound condition. A 1 causes bleeding for two turns, and a 2 weakens the fighter’s next two attacks.</p>
        </details>
      </main>
      <footer><span>Pomrok</span><span>Player duels and fight records live in Telegram.</span></footer>
    </div>
  );
}
