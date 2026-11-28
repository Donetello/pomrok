import Link from "next/link";
import { headers } from "next/headers";
import type { Catalog } from "../shared/game";
import { uptimeUserAgent } from "../shared/monitoring";
import { combatRules } from "../shared/uk";
import { gameApi } from "./game-api";
import { Arena } from "./arena";

export const dynamic = "force-dynamic";

export default async function Page() {
  let catalog: Catalog | undefined;
  try {
    const isUptimeProbe = (await headers()).get("user-agent") === uptimeUserAgent;
    const response = await gameApi("/catalog", isUptimeProbe ? { headers: { "User-Agent": uptimeUserAgent } } : undefined);
    if (response.ok) catalog = await response.json();
  } catch {
    // The page can still explain how to reach the game while the API starts.
  }

  return (
    <div className="shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Помрок. Головна">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span>Помрок</span>
        </Link>
        {catalog?.telegramUrl
          ? <a className="telegram-link" href={catalog.telegramUrl}>Грати в Telegram</a>
          : <span className="telegram-status">Гра для Telegram</span>}
      </header>
      <main>
        <section className="hero">
          <div className="hero-inner">
            <p className="eyebrow"><span aria-hidden="true">✦</span> Карпатська бувальщина</p>
            <h1>Помрок</h1>
            {catalog && <>
              <p className="hero-copy">{catalog.story.hook}</p>
              <a className="hero-link" href="#battleground">Рушити на пошуки</a>
            </>}
          </div>
        </section>
        {catalog && <details className="rules story">
          <summary>{catalog.story.title}</summary>
          {catalog.story.prologue.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </details>}
        {catalog
          ? <Arena catalog={catalog} />
          : <section className="unavailable"><h2>Гра тимчасово недоступна</h2><form action="/"><button>Оновити сторінку</button></form></section>}
        <details className="rules">
          <summary>Правила бою</summary>
          {combatRules.map((rule) => <p key={rule}>{rule}</p>)}
        </details>
      </main>
      <footer><span>Помрок</span><span>Двобої між гравцями й особистий літопис — у Telegram.</span></footer>
    </div>
  );
}
