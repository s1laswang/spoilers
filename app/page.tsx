"use client";

import { useEffect, useMemo, useState } from "react";
import participants from "@/data/participants.json";
import { INTERESTS, ROLES, type Decline, type Match, type Participant, type Persona } from "@/lib/types";

type Result = { agent: Persona; matches: Match[]; source: string };

const DEMO = participants as Participant[];
const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
const CRISIS_TICKER = [
  "Sat 14:00 · the API starts rate-limiting",
  "Sat 14:00 · a mentor hates the idea",
  "Sat 14:00 · two people want the same part",
  "Sat 14:00 · the night-shift hero falls asleep",
];

export default function Page() {
  const [me, setMe] = useState<Participant>(DEMO[0]);
  const [skillsText, setSkillsText] = useState(DEMO[0].skills.join(", "));
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [seen, setSeen] = useState<string[]>([]);
  const [declined, setDeclined] = useState<Decline[]>([]);
  const [declining, setDeclining] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading) return;
    setTick(0);
    const t = setInterval(() => setTick((n) => Math.min(n + 1, 11)), 550);
    return () => clearInterval(t);
  }, [loading]);

  const profile = useMemo(
    () => ({ ...me, skills: skillsText.split(",").map((s) => s.trim()).filter(Boolean) }),
    [me, skillsText]
  );

  async function run(opts: { exclude?: string[]; declined?: Decline[] } = {}) {
    setLoading(true);
    setError(null);
    setDeclining(null);
    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participant: profile, exclude: opts.exclude ?? [], declined: opts.declined ?? [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setResult(data);
      setSeen((s) => [...new Set([...s, ...data.matches.map((m: Match) => m.teamId)])]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function start() {
    setSeen([]);
    setDeclined([]);
    setAccepted({});
    run();
  }

  function decline(teamId: string, reason: Decline["reason"]) {
    const next = [...declined, { teamId, reason }];
    setDeclined(next);
    run({ declined: next, exclude: seen.filter((id) => id !== teamId) });
  }

  async function accept(m: Match) {
    await fetch("/api/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: me.id ?? me.firstName, teamId: m.teamId }),
    });
    setAccepted((a) => ({ ...a, [m.teamId]: true }));
  }

  function pick(id: string) {
    const p = DEMO.find((d) => d.id === id)!;
    setMe(p);
    setSkillsText(p.skills.join(", "));
    setResult(null);
  }

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">SPOILERS</div>
        <p className="tag">
          Before you join a team, your AI agent lives the hackathon weekend with them, four times. You see how it ends.
        </p>
      </header>

      <div className="grid">
        <section className="card profile">
          <div className="row between">
            <h2>Your Junction profile</h2>
            <select value={me.id} onChange={(e) => pick(e.target.value)} aria-label="Demo profile">
              {DEMO.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.firstName}
                </option>
              ))}
            </select>
          </div>
          <div className="status">Looking for a team</div>

          <label>
            Study / work
            <input value={me.studyWork} onChange={(e) => setMe({ ...me, studyWork: e.target.value })} />
          </label>
          <label>
            A project you're proud of
            <input value={me.proudProject} onChange={(e) => setMe({ ...me, proudProject: e.target.value })} />
          </label>
          <label>
            Skills
            <input value={skillsText} onChange={(e) => setSkillsText(e.target.value)} />
          </label>

          <div className="field">
            <span>Preferred role</span>
            <div className="chips">
              {ROLES.map((r) => (
                <button
                  key={r}
                  className={`chip ${me.preferredRole === r ? "on" : ""}`}
                  onClick={() => setMe({ ...me, preferredRole: r })}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Interests</span>
            <div className="chips">
              {INTERESTS.map((i) => {
                const on = me.interests.includes(i);
                return (
                  <button
                    key={i}
                    className={`chip small ${on ? "on" : ""}`}
                    onClick={() =>
                      setMe({ ...me, interests: on ? me.interests.filter((x) => x !== i) : [...me.interests, i] })
                    }
                  >
                    {i}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <span>Awake during the hackathon</span>
            <div className="row">
              <select value={me.awake.from} onChange={(e) => setMe({ ...me, awake: { ...me.awake, from: e.target.value } })}>
                {HOURS.map((h) => (
                  <option key={h}>{h}</option>
                ))}
              </select>
              <span className="muted">to</span>
              <select value={me.awake.to} onChange={(e) => setMe({ ...me, awake: { ...me.awake, to: e.target.value } })}>
                {HOURS.map((h) => (
                  <option key={h}>{h}</option>
                ))}
              </select>
            </div>
          </div>

          <button className="primary" onClick={start} disabled={loading}>
            {loading ? "Simulating…" : "Simulate my weekends"}
          </button>
          <p className="fine">
            Agents are AI simulations built from the profile. Demo profiles are fictional except Silas's. No email, phone or
            birth date is ever sent to the model.
          </p>
        </section>

        <section className="results">
          {loading && (
            <div className="card sim">
              <div className="counter">
                Simulating weekend <b>{tick + 1}</b> of 12
              </div>
              <div className="bar">
                <div style={{ width: `${((tick + 1) / 12) * 100}%` }} />
              </div>
              <div className="ticker">{CRISIS_TICKER[tick % 4]}</div>
            </div>
          )}

          {error && <div className="card warn">Couldn't simulate: {error}</div>}

          {!loading && !result && !error && (
            <div className="card empty">
              <p>
                Most matchmakers tell you what you have in common. This one shows you the weekend: who you'd be at 03:00,
                what breaks at 14:00, and whether you ship.
              </p>
            </div>
          )}

          {!loading && result && (
            <>
              <div className="card agent">
                <div className="row between">
                  <h3>Your AI agent</h3>
                  <span className="badge">AI · simulated</span>
                </div>
                <p>{result.agent.summary}</p>
                <p className="muted">
                  {result.agent.workingStyle} {result.agent.pushesFor}
                </p>
              </div>

              {result.matches.map((m) => (
                <article className="card match" key={m.teamId}>
                  <div className="row between">
                    <div>
                      <h3>{m.teamName}</h3>
                      <p className="muted idea">{m.idea}</p>
                    </div>
                    <div className="score">
                      <div className="pill">{m.compatibility}% match</div>
                      {m.totalRuns > 0 && (
                        <div className="shipped">
                          shipped in {m.shippedRuns} of {m.totalRuns} weekends
                        </div>
                      )}
                    </div>
                  </div>

                  <p className="why">{m.why}</p>

                  <div className="bars">
                    {(["role", "skills", "interests", "availability"] as const).map((k) => (
                      <div key={k} className="mini" title={m.fit[k]}>
                        <span>{k}</span>
                        <div className="track">
                          <div style={{ width: `${Math.round(m.fitParts[k] * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {m.spoiler.length > 0 && (
                    <div className="spoiler">
                      <div className="label">Spoiler · your best weekend with them, as {m.soloRole}</div>
                      {m.spoiler.map((s, i) => (
                        <div className="moment" key={i}>
                          <span className="time">{s.time}</span>
                          <span>
                            <b>{s.who}</b> {s.what}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="heads">
                    <b>Heads-up:</b> {m.headsUp}
                  </div>

                  {accepted[m.teamId] ? (
                    <div className="done">Request sent to {m.teamName}. They see your agent's weekend too.</div>
                  ) : declining === m.teamId ? (
                    <div className="row wrapline">
                      <span className="muted">Why not?</span>
                      {(
                        [
                          ["role", "wrong role"],
                          ["interests", "not my topic"],
                          ["schedule", "schedule"],
                          ["not_it", "just not it"],
                        ] as const
                      ).map(([r, label]) => (
                        <button key={r} className="chip" onClick={() => decline(m.teamId, r)}>
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="row">
                      <button className="primary slim" onClick={() => accept(m)}>
                        Accept
                      </button>
                      <button className="ghost" onClick={() => setDeclining(m.teamId)}>
                        Decline
                      </button>
                    </div>
                  )}
                </article>
              ))}

              <button className="ghost wide" onClick={() => run({ exclude: seen, declined })}>
                Show me other teams
              </button>
              {result.source === "fit-only" && (
                <p className="fine">Simulation unavailable right now: scores above are profile fit only.</p>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
