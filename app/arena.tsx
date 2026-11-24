"use client";

import { useEffect, useState } from "react";
import type { Catalog, Fight, Fighter, Mode } from "../shared/game";

const marks: Record<string, string> = { shield: "⬟", swords: "⚔", flame: "✦", skull: "☠", moon: "☾" };
const dice = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function Mark({ name }: { name: string }) {
  return <span className="mark" aria-hidden="true">{marks[name] || "◆"}</span>;
}

function Health({ fighter, hp, other = false }: { fighter: Fighter; hp: number; other?: boolean }) {
  return (
    <div className={other ? "health other" : "health"}>
      <div className="health-label"><strong>{fighter.name}</strong><span>{hp}/{fighter.hp} HP</span></div>
      <div className="health-track">
        <div className="health-fill" style={{ width: `${100 * hp / fighter.hp}%` }} />
      </div>
    </div>
  );
}

export function Arena({ catalog }: { catalog: Catalog }) {
  const [mode, setMode] = useState<Mode>("dungeon");
  const [selectedByMode, setSelectedByMode] = useState({
    dungeon: catalog.dungeon[0].id, bot: catalog.bot[0].id,
  });
  const [heroId, setHeroId] = useState(catalog.heroes[0].id);
  const [result, setResult] = useState<Fight>();
  const [visible, setVisible] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const entries = catalog[mode];
  const selected = entries.find((entry) => entry.id === selectedByMode[mode]) ?? entries[0];
  const hero = catalog.heroes.find((entry) => entry.id === heroId) ?? catalog.heroes[0];
  const complete = !!result && visible >= result.steps.length;
  const current = result?.steps[visible - 1];

  useEffect(() => {
    if (!result || !playing || complete) return;
    const timer = window.setTimeout(() => setVisible((count) => count + 1), 550);
    return () => window.clearTimeout(timer);
  }, [result, playing, complete, visible]);

  function clearFight() {
    setResult(undefined);
    setVisible(0);
    setPlaying(false);
    setError("");
  }

  async function startFight() {
    clearFight();
    setPending(true);
    try {
      const response = await fetch("/api/practice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heroId, mode, encounterId: selected.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message);
      setResult(body);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setVisible(reducedMotion ? body.steps.length : 1);
      setPlaying(!reducedMotion);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the fight.");
    } finally {
      setPending(false);
    }
  }

  const busy = pending || (!!result && !complete);

  return (
    <section className="arena" id="battleground" aria-labelledby="arena-title">
      <div className="section-header">
        <h2 id="arena-title">Choose a battleground</h2>
        <div className="mode-picker" aria-label="Fight mode" role="group">
          {(["dungeon", "bot"] as const).map((option) => (
            <button key={option} type="button" disabled={busy} aria-pressed={mode === option} onClick={() => {
              if (mode === option) return;
              clearFight();
              setMode(option);
            }}>
              {option === "dungeon" ? "Dungeons" : "Bot arena"}
            </button>
          ))}
        </div>
      </div>
      <div className="encounters" aria-label="Opponents" role="group">
        {entries.map((entry) => (
          <button className="encounter" key={entry.id} data-mark={entry.mark} aria-pressed={entry.id === selected.id}
            disabled={busy} onClick={() => {
              if (entry.id === selected.id) return;
              clearFight();
              setSelectedByMode((previous) => ({ ...previous, [mode]: entry.id }));
            }}>
            <span className="card-top"><Mark name={entry.mark} /><span className="difficulty">{entry.difficulty}</span></span>
            <span className="encounter-name">{entry.name}</span>
            <span className="encounter-description">{entry.description}</span>
          </button>
        ))}
      </div>
      <div className="preparation">
        <section className="panel hero-panel">
          <h3>Your hero</h3>
          <div className="hero-choices" aria-label="Hero class" role="group">
            {catalog.heroes.map((entry) => (
              <button key={entry.id} aria-pressed={hero.id === entry.id} disabled={busy} onClick={() => {
                if (entry.id === hero.id) return;
                clearFight();
                setHeroId(entry.id);
              }}>
                <Mark name={entry.mark} /><span>{entry.name}</span>
              </button>
            ))}
          </div>
          <p className="hero-description">{hero.description}</p>
          <dl className="stats">
            <div><dt>Health</dt><dd>{hero.hp}</dd></div>
            <div><dt>Attack</dt><dd>{hero.attack}</dd></div>
            <div><dt>Armour</dt><dd>{hero.armor}</dd></div>
            <div><dt>Speed</dt><dd>{hero.speed}</dd></div>
          </dl>
        </section>
        <section className="panel fight-panel" aria-label="Fight">
          <div className="fight-heading">
            <h3>{result ? (complete ? "Fight result" : "Fight in progress") : "Matchup"}</h3>
            <span className="fight-tag"><span aria-hidden="true">⚄</span> D6 marble box</span>
          </div>
          <div className="matchup">
            <Health fighter={hero} hp={current?.hp[0] ?? hero.hp} />
            <span className="versus" aria-hidden="true">VS</span>
            <Health fighter={selected.opponent} hp={current?.hp[1] ?? selected.opponent.hp} other />
          </div>
          <div className="fight-controls">
            {result && !complete ? <>
              <button className="secondary-button" onClick={() => setPlaying((active) => !active)}>{playing ? "Pause" : "Resume"}</button>
              <button className="secondary-button" onClick={() => setVisible(result.steps.length)}>Skip to result</button>
            </> : (
              <button className="fight-button" disabled={pending} onClick={startFight}>
                <span aria-hidden="true">⚔</span> {pending ? "Starting fight…" : result ? "Fight again" : "Start auto-fight"}
              </button>
            )}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      </div>
      {result && (
        <section className="panel replay" aria-labelledby="replay-title">
          <div className="fight-heading"><h3 id="replay-title">Fight log</h3><span className="fight-tag">{complete ? `${result.rounds} rounds` : current?.round ? `Round ${current.round}` : "Initiative"}</span></div>
          {complete && <p className="result" role="status">{result.summary}</p>}
          <ol className="turns">
            {result.steps.slice(0, visible).reverse().map((step, index) => (
              <li key={visible - index - 1}>
                <span className="turn-round">{step.round ? `Round ${step.round}` : "Initiative"}</span>
                <span>{step.text}</span>
                {step.roll !== undefined && <span className="die" aria-label={`D6 roll ${step.roll}`}>{dice[step.roll]}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
