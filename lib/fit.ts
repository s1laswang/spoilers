import type { Awake, Decline, Fit, Participant, Team } from "./types";

/**
 * The deterministic half of the score. It picks which teams get simulated and
 * supplies the facts the "why" line cites, so every suggestion is explainable
 * without trusting the model. A fact is only stated when the profile actually
 * holds it: missing interests or hours give a neutral score and say so.
 */

const BASE_WEIGHTS = { role: 0.3, skills: 0.2, interests: 0.3, availability: 0.2 };
type Weights = typeof BASE_WEIGHTS;

/** Who reads the reasons: the solo browsing teams, or an open team browsing solos. */
export type Viewer = "solo" | "team";

const norm = (s: string) => s.trim().toLowerCase();

function minutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) % 1440;
}

/** 48 half-hour slots on a 24 h clock; awake windows may wrap past midnight. */
function slots(a: Awake): boolean[] {
  const from = minutes(a.from);
  const to = minutes(a.to);
  return Array.from({ length: 48 }, (_, i) => {
    const t = i * 30;
    return from <= to ? t >= from && t < to : t >= from || t < to;
  });
}

function overlap(a: Awake, b: Awake): number {
  const sa = slots(a);
  const sb = slots(b);
  const mine = sa.filter(Boolean).length || 1;
  return sa.filter((x, i) => x && sb[i]).length / mine;
}

const hh = (t: string) => t.slice(0, 2);

function list(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Each decline reason nudges its criterion up for the next round. */
export function weightsFor(declined: Decline[] = []): Weights {
  const w = { ...BASE_WEIGHTS };
  for (const d of declined) {
    if (d.reason === "role") w.role += 0.1;
    if (d.reason === "interests") w.interests += 0.1;
    if (d.reason === "schedule") w.availability += 0.15;
  }
  const sum = w.role + w.skills + w.interests + w.availability;
  return {
    role: w.role / sum,
    skills: w.skills / sum,
    interests: w.interests / sum,
    availability: w.availability / sum,
  };
}

export function fitFor(p: Participant, team: Team, w: Weights = BASE_WEIGHTS, viewer: Viewer = "solo"): Fit {
  const solo = viewer === "solo";
  const name = p.firstName;

  const holder = team.members.find((m) => m.preferredRole === p.preferredRole);
  let role: number;
  let roleFact: string;
  if (team.missingRoles.includes(p.preferredRole)) {
    role = 1;
    roleFact = solo
      ? `They're missing a ${p.preferredRole} person, and that's you.`
      : `You're missing a ${p.preferredRole} person, and ${name} is one.`;
  } else if (!holder) {
    role = 0.6;
    roleFact = solo
      ? `Nobody on the team does ${p.preferredRole} yet.`
      : `${name} does ${p.preferredRole}, which nobody on your team covers yet.`;
  } else {
    role = 0.15;
    roleFact = solo
      ? `${holder.firstName} already owns ${p.preferredRole}, so you'd need to flex.`
      : `${holder.firstName} already owns ${p.preferredRole}, so ${name} would need to flex.`;
  }

  const teamSkills = new Set(team.members.flatMap((m) => m.skills.map(norm)));
  const fresh = p.skills.filter((s) => !teamSkills.has(norm(s)));
  const skills = p.skills.length ? fresh.length / p.skills.length : 0;
  const skillsFact = !p.skills.length
    ? solo ? `You haven't listed skills yet.` : `${name} hasn't listed skills yet.`
    : fresh.length
      ? solo
        ? `You bring ${list(fresh.slice(0, 3))}, which nobody there has.`
        : `${name} brings ${list(fresh.slice(0, 3))}, which nobody on your team has.`
      : solo
        ? `Your skills are already covered on the team.`
        : `${name}'s skills are already covered on your team.`;

  const mine = new Set(p.interests.map(norm));
  const shared = team.tags.filter((t) => mine.has(norm(t)));
  let interests: number;
  let interestsFact: string;
  if (!p.interests.length || !team.tags.length) {
    interests = 0.5;
    interestsFact = "Interests not listed yet.";
  } else {
    interests = shared.length / Math.min(p.interests.length, team.tags.length);
    interestsFact = shared.length
      ? `You're both into ${list(shared.slice(0, 3))}.`
      : solo
        ? `Different interests: they're about ${list(team.tags.slice(0, 2))}.`
        : `Different interests: ${name} is into ${list(p.interests.slice(0, 2))}.`;
  }

  // Only members who listed their hours count; the solo's must be listed too.
  const listed = team.members.filter((m) => m.awakeListed !== false);
  const perMember = p.awakeListed === false ? [] : listed.map((m) => ({ m, o: overlap(p.awake, m.awake) }));
  let availability: number;
  let availabilityFact: string;
  if (!perMember.length) {
    availability = 0.75;
    availabilityFact = "Schedules not listed yet.";
  } else {
    availability = perMember.reduce((s, x) => s + x.o, 0) / perMember.length;
    const worst = perMember.reduce((a, b) => (b.o < a.o ? b : a));
    availabilityFact =
      availability >= 0.8
        ? solo
          ? `You're awake ${hh(p.awake.from)}–${hh(p.awake.to)} and so are they.`
          : `${name} is awake ${hh(p.awake.from)}–${hh(p.awake.to)}, like your team.`
        : `${worst.m.firstName} sleeps at ${hh(worst.m.awake.to)} while ${solo ? "you go" : `${name} goes`} till ${hh(p.awake.to)}: ${Math.round(availability * 100)}% overlap.`;
  }

  const parts = { role, skills, interests, availability };
  const score =
    w.role * role + w.skills * skills + w.interests * interests + w.availability * availability;

  return {
    score,
    parts,
    facts: { role: roleFact, skills: skillsFact, interests: interestsFact, availability: availabilityFact },
  };
}

export function rankTeams(
  p: Participant,
  teams: Team[],
  opts: { exclude?: string[]; declined?: Decline[]; limit?: number } = {}
): { team: Team; fit: Fit }[] {
  const skip = new Set([...(opts.exclude ?? []), ...(opts.declined ?? []).map((d) => d.teamId)]);
  const w = weightsFor(opts.declined);
  return teams
    .filter((t) => !skip.has(t.id))
    .map((team) => ({ team, fit: fitFor(p, team, w) }))
    .sort((a, b) => b.fit.score - a.fit.score)
    .slice(0, opts.limit ?? 3);
}

/** One friendly sentence: the role fact, plus the strongest other reason, plus a schedule warning if needed. */
export function whyLine(fit: Fit): string {
  const others = (["skills", "interests", "availability"] as const)
    .map((k) => ({ k, v: fit.parts[k] }))
    .sort((a, b) => b.v - a.v);
  const best = others[0].k;
  const parts = [fit.facts.role, fit.facts[best]];
  if (best !== "availability" && fit.parts.availability < 0.7) parts.push(fit.facts.availability);
  return parts.join(" ");
}
