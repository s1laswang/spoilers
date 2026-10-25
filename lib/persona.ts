import { modelView, personaKey, personas } from "./cache";
import { hasKey, jsonCall } from "./llm";
import type { Participant, Persona } from "./types";

const INSTRUCTIONS = `You turn a hackathon participant's registration into a short persona card that an AI agent will play in a simulated hackathon weekend.
Stay faithful to the profile: do not invent achievements, skills or facts. Write in third person using only the first name.
Each field is one sentence of at most 20 words.
- summary: who they are and what they bring.
- workingStyle: how they likely work in a team under time pressure.
- pushesFor: what they will push the team to build or prioritise.
- likelyFriction: the most likely source of friction with teammates.`;

const FORMAT = {
  type: "json_schema" as const,
  name: "persona",
  strict: true as const,
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      workingStyle: { type: "string" },
      pushesFor: { type: "string" },
      likelyFriction: { type: "string" },
    },
    required: ["summary", "workingStyle", "pushesFor", "likelyFriction"],
    additionalProperties: false,
  },
};

function fallback(p: Participant): Persona {
  return {
    summary: `${p.firstName}: ${p.studyWork}, proud of "${p.proudProject}".`,
    workingStyle: `Leads with ${p.skills.slice(0, 2).join(" and ")}.`,
    pushesFor: `Projects about ${p.interests.slice(0, 2).join(" and ")}.`,
    likelyFriction: `Wants to own ${p.preferredRole}.`,
  };
}

export async function getPersona(p: Participant, opts: { live: boolean }): Promise<Persona> {
  const key = personaKey(p);
  const hit = personas.get(key);
  if (hit) return hit;
  if (!opts.live || !hasKey()) return fallback(p);
  try {
    const persona = await jsonCall<Persona>({
      label: `persona ${p.firstName}`,
      instructions: INSTRUCTIONS,
      input: JSON.stringify(modelView(p)),
      format: FORMAT,
      cacheKey: "spoilers-persona-v1",
      timeoutMs: 15_000,
    });
    personas.set(key, persona);
    return persona;
  } catch (err) {
    console.error(`[persona] ${p.firstName} failed, using fallback:`, (err as Error).message);
    return fallback(p);
  }
}
