import teamsData from "@/data/teams.json";
import { rankTeams, whyLine } from "./fit";
import { hasKey } from "./llm";
import { getPersona } from "./persona";
import { cachedRuns, simulatePair } from "./simulate";
import { ROLES, type Decline, type Fit, type Match, type Participant, type Persona, type Role, type Run, type Team } from "./types";

export const TEAMS = teamsData as Team[];

const OUTCOME = { shipped: 1, partial: 0.5, fell_apart: 0 } as const;
const CONTRIBUTION = { core: 1, helpful: 0.8, sidelined: 0.5 } as const;
const runScore = (r: Run) => OUTCOME[r.outcome] * CONTRIBUTION[r.solo_contribution];

function build(p: Participant, team: Team, fit: Fit, runs: Run[] | undefined): Match {
  const base = {
    teamId: team.id,
    teamName: team.name,
    idea: team.idea,
    why: whyLine(fit),
    fit: fit.facts,
    fitParts: fit.parts,
  };
  if (!runs?.length) {
    return {
      ...base,
      compatibility: Math.round(100 * fit.score),
      shippedRuns: 0,
      totalRuns: 0,
      spoiler: [],
      headsUp: "Simulation offline: this score is profile fit only.",
      soloRole: p.preferredRole,
    };
  }

  const sim = runs.reduce((s, r) => s + runScore(r), 0) / runs.length;
  const ordered = [...runs].sort((a, b) => runScore(b) - runScore(a));
  const best = ordered[0];
  const worst = ordered[ordered.length - 1];

  // The spoiler is how the best weekend ends: the night shift, the crisis and the demo.
  const spoiler = best.moments.slice(-3);

  const headsUp =
    worst.conflicts[0] ??
    runs.flatMap((r) => r.conflicts)[0] ??
    `No real clashes in ${runs.length} weekends. That's rare.`;

  return {
    ...base,
    compatibility: Math.round(100 * (0.5 * fit.score + 0.5 * sim)),
    shippedRuns: runs.filter((r) => r.outcome === "shipped").length,
    totalRuns: runs.length,
    spoiler,
    headsUp,
    soloRole: best.solo_role,
  };
}

export async function matchFor(
  p: Participant,
  opts: { exclude?: string[]; declined?: Decline[]; live: boolean }
): Promise<{ agent: Persona; matches: Match[]; source: "cache" | "live" | "fit-only" }> {
  const ranked = rankTeams(p, TEAMS, { exclude: opts.exclude, declined: opts.declined, limit: 3 });
  const agent = await getPersona(p, { live: opts.live });

  const scored = await Promise.all(ranked.map(({ team, fit }) => scorePair(p, agent, team, fit, opts.live)));
  const matches = scored.map((s) => s.match).sort((a, b) => b.compatibility - a.compatibility);
  const source = scored.some((s) => s.source === "fit-only")
    ? "fit-only"
    : scored.some((s) => s.source === "live")
      ? "live"
      : "cache";
  return { agent, matches, source };
}

/** One (solo, team) pair: cached runs if we have them, else a live simulation, else fit only. */
export async function scorePair(
  p: Participant,
  agent: Persona,
  team: Team,
  fit: Fit,
  live: boolean
): Promise<{ match: Match; source: "cache" | "live" | "fit-only" }> {
  let runs = cachedRuns(p, team);
  let source: "cache" | "live" | "fit-only" = runs ? "cache" : "fit-only";
  if (!runs && live && hasKey()) {
    try {
      const teamPersonas = await Promise.all(team.members.map((m) => getPersona(m, { live: true })));
      runs = await simulatePair(p, agent, team, teamPersonas);
      source = "live";
    } catch (err) {
      console.error(`[match] ${team.name}:`, (err as Error).message);
    }
  }
  return { match: build(p, team, fit, runs), source };
}

const str = (x: unknown, max = 300) => (typeof x === "string" ? x.slice(0, max) : "");
const strs = (x: unknown) =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").slice(0, 12).map((s) => s.slice(0, 60)) : [];
const clock = (x: unknown, d: string) => (typeof x === "string" && /^\d{1,2}:\d{2}$/.test(x) ? x.padStart(5, "0") : d);

/**
 * Keeps only the fields the matcher uses. Anything else in the request (email,
 * phone, birth date) is dropped here and never reaches the model.
 */
export function parseParticipant(x: unknown): Participant | null {
  const o = (x ?? {}) as Record<string, unknown>;
  // Demo people arrive without names (the platform strips them); any label will do.
  const firstName = str(o.firstName, 40).trim() || "Builder";
  const role = o.preferredRole as Role;
  if (!ROLES.includes(role)) return null;
  const awake = (o.awake ?? {}) as Record<string, unknown>;
  const awakeListed = typeof awake.from === "string" && typeof awake.to === "string";
  return {
    id: str(o.id, 60) || undefined,
    firstName,
    background: str(o.background),
    studyWork: str(o.studyWork),
    proudProject: str(o.proudProject),
    interests: strs(o.interests),
    motivation: str(o.motivation),
    githubUrl: str(o.githubUrl, 200) || undefined,
    skills: strs(o.skills),
    preferredRole: role,
    awake: { from: clock(awake.from, "09:00"), to: clock(awake.to, "01:00") },
    ...(awakeListed ? {} : { awakeListed: false }),
  };
}

export function parseDeclines(x: unknown): Decline[] {
  if (!Array.isArray(x)) return [];
  const reasons = ["role", "interests", "schedule", "not_it"];
  return x.flatMap((d) => {
    const o = (d ?? {}) as Record<string, unknown>;
    return typeof o.teamId === "string" && reasons.includes(o.reason as string)
      ? [{ teamId: o.teamId, reason: o.reason as Decline["reason"] }]
      : [];
  });
}
