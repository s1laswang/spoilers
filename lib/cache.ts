import { createHash } from "node:crypto";
import seed from "@/data/cache.json";
import type { Participant, Persona, Run } from "./types";

/**
 * Personas and simulation runs, keyed by a hash of the profile fields the model sees.
 * data/cache.json is pre-generated (POST /api/pregen in dev) and bundled, so the demo
 * path works with no key and no wifi. Live results only live in this instance's memory.
 */

export const SIM_VERSION = "v2";

type Seed = { personas: Record<string, Persona>; sims: Record<string, Run[]> };
const s = seed as Seed;

export const personas = new Map<string, Persona>(Object.entries(s.personas));
export const sims = new Map<string, Run[]>(Object.entries(s.sims));

const sha = (x: string) => createHash("sha1").update(x).digest("hex").slice(0, 16);

/** Only model-relevant fields: contact data can't change a key or reach the model. */
export function modelView(p: Participant) {
  return {
    firstName: p.firstName,
    background: p.background,
    studyWork: p.studyWork,
    proudProject: p.proudProject,
    interests: p.interests,
    motivation: p.motivation,
    skills: p.skills,
    preferredRole: p.preferredRole,
    awake: p.awake,
  };
}

export const personaKey = (p: Participant) => sha(JSON.stringify(modelView(p)));
export const pairKey = (p: Participant, teamId: string) =>
  sha(`${personaKey(p)}|${teamId}|${SIM_VERSION}`);

export function dump(extra: Record<string, unknown> = {}): Seed & Record<string, unknown> {
  return { ...(seed as object), personas: Object.fromEntries(personas), sims: Object.fromEntries(sims), ...extra };
}
