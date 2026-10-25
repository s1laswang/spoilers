import { createHash } from "node:crypto";
import seed from "@/data/cache.json";
import { modelView, pairKey } from "./cache";
import type { Viewer } from "./fit";
import { hasKey, jsonCall } from "./llm";
import type { Fit, Participant, Persona, Team } from "./types";

/**
 * The "% match" pill's explanation panel: why you fit, how you complement each
 * other, two weeks of working together, and the risks that come from being alike.
 * One LLM call grounded in the fit facts and personas; rules-only when there is no
 * key or the call is slow. The score itself still comes from the weekend runs.
 */

export type Explain = {
  label: string;
  headline: string;
  whyYouFit: string[];
  complement: { you: string; them: string; together: string }[];
  twoWeeks: { day: string; title: string; what: string }[];
  similarityRisks: { trait: string; risk: string; tip: string }[];
  verdict: string;
};

const LABEL = "AI agent explanation + simulation: a prediction, not a fact";

const s = seed as { explains?: Record<string, Omit<Explain, "label">> };
export const explains = new Map<string, Omit<Explain, "label">>(Object.entries(s.explains ?? {}));

export const explainKey = (p: Participant, team: Team, viewer: Viewer) =>
  createHash("sha1").update(`${pairKey(p, team.id)}|explain|${viewer}`).digest("hex").slice(0, 16);

const norm = (x: string) => x.trim().toLowerCase();
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function rulesExplain(p: Participant, team: Team, fit: Fit, score: number): Omit<Explain, "label"> {
  const teamSkills = [...new Set(team.members.flatMap((m) => m.skills))];
  const teamSkillSet = new Set(teamSkills.map(norm));
  const fresh = p.skills.filter((x) => !teamSkillSet.has(norm(x)));
  const sharedSkills = p.skills.filter((x) => teamSkillSet.has(norm(x)));
  const teamRoles = [...new Set(team.members.map((m) => m.preferredRole))];
  const sharedInterests = team.tags.filter((t) => p.interests.map(norm).includes(norm(t)));
  const holder = team.members.find((m) => m.preferredRole === p.preferredRole);

  const complement = [
    {
      you: `${p.preferredRole}`,
      them: teamRoles.length ? list(teamRoles) : "roles not listed yet",
      together: team.missingRoles.includes(p.preferredRole)
        ? `Fills the ${p.preferredRole} gap they listed.`
        : `Adds ${p.preferredRole} next to ${list(teamRoles) || "the team"}.`,
    },
  ];
  if (fresh.length && teamSkills.length) {
    complement.push({
      you: list(fresh.slice(0, 3)),
      them: list(teamSkills.slice(0, 3)),
      together: `Two different toolkits: less overlap, more of the build covered.`,
    });
  }

  const similarityRisks: Explain["similarityRisks"] = [];
  if (holder) similarityRisks.push({
    trait: `Same role: ${p.preferredRole} (${holder.firstName})`,
    risk: "Two people want the same job.",
    tip: "Split ownership in the first hour: one builds, one integrates.",
  });
  if (fit.parts.availability >= 0.8 && p.awakeListed !== false) similarityRisks.push({
    trait: `Same awake window (${p.awake.from}–${p.awake.to})`,
    risk: "You all crash at the same time and nobody covers the other half of the clock.",
    tip: "Stagger one sleep shift so someone is fresh for the morning.",
  });
  if (sharedSkills.length) similarityRisks.push({
    trait: `Overlapping skills: ${list(sharedSkills.slice(0, 2))}`,
    risk: "Duplicated work, and a gap nobody covers.",
    tip: "List what nobody on the team can do yet and assign it first.",
  });
  if (sharedInterests.length) similarityRisks.push({
    trait: `Same interests: ${list(sharedInterests.slice(0, 2))}`,
    risk: "Tunnel vision on one idea.",
    tip: "Have one person argue against the idea for ten minutes before you commit.",
  });

  const facts = [fit.facts.role, fit.facts.skills, fit.facts.interests, fit.facts.availability].filter(
    (f) => !/not listed yet|haven't listed|hasn't listed/.test(f)
  );
  const tone = score >= 75 ? "looks like a strong fit" : score >= 55 ? "could work, with some care" : "is a stretch";
  return {
    headline: `${team.name} ${tone} for ${p.firstName}.`,
    whyYouFit: facts.slice(0, 3),
    complement: complement.slice(0, 3),
    twoWeeks: [],
    similarityRisks: similarityRisks.slice(0, 3),
    verdict: `${score}% match. ${fit.facts.role}`,
  };
}

const INSTRUCTIONS = `You explain why a hackathon newcomer and a team would or would not work well together, for a matchmaking panel.
Ground everything in the given profiles, personas and fit facts. Never invent skills, projects or facts. Use first names only.
Address the reader as "you"; the reader is named in "viewer".
- headline: one friendly sentence.
- whyYouFit: exactly 3 items, each citing a real profile fact (prefer the given fit facts).
- complement: 2 to 3 items. "you" and "them" name concrete roles or skills from the profiles; "together" says what the combination makes possible.
- twoWeeks: 6 to 8 beats from "Day 1" to "Day 14" of working together after the hackathon, using real roles and skills. Include exactly one rough patch and how they get through it.
- similarityRisks: 2 to 3 problems that arise BECAUSE they are alike (same preferred role, overlapping skills, same awake window, same interests). "trait" cites the shared trait; "tip" is one practical fix.
- verdict: one honest sentence.`;

const FORMAT = {
  type: "json_schema" as const,
  name: "explain",
  strict: true as const,
  schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      whyYouFit: { type: "array", items: { type: "string" } },
      complement: {
        type: "array",
        items: {
          type: "object",
          properties: { you: { type: "string" }, them: { type: "string" }, together: { type: "string" } },
          required: ["you", "them", "together"],
          additionalProperties: false,
        },
      },
      twoWeeks: {
        type: "array",
        items: {
          type: "object",
          properties: { day: { type: "string" }, title: { type: "string" }, what: { type: "string" } },
          required: ["day", "title", "what"],
          additionalProperties: false,
        },
      },
      similarityRisks: {
        type: "array",
        items: {
          type: "object",
          properties: { trait: { type: "string" }, risk: { type: "string" }, tip: { type: "string" } },
          required: ["trait", "risk", "tip"],
          additionalProperties: false,
        },
      },
      verdict: { type: "string" },
    },
    required: ["headline", "whyYouFit", "complement", "twoWeeks", "similarityRisks", "verdict"],
    additionalProperties: false,
  },
};

/** A pregenerated or earlier explanation, without touching personas or the model. */
export function cachedExplain(p: Participant, team: Team, viewer: Viewer): Explain | null {
  const hit = explains.get(explainKey(p, team, viewer));
  return hit ? { label: LABEL, ...hit } : null;
}

export async function explainPair(opts: {
  solo: Participant;
  soloPersona: Persona;
  team: Team;
  teamPersonas: Persona[];
  fit: Fit;
  score: number;
  viewer: Viewer;
  live: boolean;
  timeoutMs?: number;
}): Promise<{ explain: Explain; source: "cache" | "live" | "rules" }> {
  const { solo, team, fit, score, viewer } = opts;
  const key = explainKey(solo, team, viewer);
  const hit = explains.get(key);
  if (hit) return { explain: { label: LABEL, ...hit }, source: "cache" };

  if (opts.live && hasKey()) {
    try {
      const out = await jsonCall<Omit<Explain, "label">>({
        label: `explain ${solo.firstName}→${team.name}`,
        instructions: INSTRUCTIONS,
        input: JSON.stringify({
          viewer: viewer === "team" ? `the team ${team.name}` : solo.firstName,
          team: { name: team.name, idea: team.idea, missingRoles: team.missingRoles },
          members: team.members.map((m, i) => ({ ...modelView(m), persona: opts.teamPersonas[i] })),
          newcomer: { ...modelView(solo), persona: opts.soloPersona },
          fitFacts: fit.facts,
          score,
        }),
        format: FORMAT,
        cacheKey: "spoilers-explain-v1",
        timeoutMs: opts.timeoutMs ?? 15_000,
      });
      explains.set(key, out);
      return { explain: { label: LABEL, ...out }, source: "live" };
    } catch (err) {
      console.error(`[explain] ${team.name}:`, (err as Error).message);
    }
  }
  return { explain: { label: LABEL, ...rulesExplain(solo, team, fit, score) }, source: "rules" };
}
