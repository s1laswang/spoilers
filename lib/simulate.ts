import { modelView, pairKey, sims } from "./cache";
import { hasKey, jsonCall } from "./llm";
import type { Participant, Persona, Run, Team } from "./types";

/**
 * Each run gets a different crisis. Without one, the model writes a weekend where
 * everything works out and every score lands around 85%.
 */
export const CRISES = [
  "The core component they planned around breaks (an API starts rate-limiting them, or the key part stops working). 20 hours left.",
  "A mentor tells them the idea is not convincing. They must pivot or defend it, fast.",
  "Two people both want to own the most visible part of the build.",
  "Whoever worked the night shift is exhausted and disappears to sleep for six hours.",
];

const INSTRUCTIONS = `You simulate a 24-hour hackathon weekend for a team of strangers, to predict whether a newcomer fits the team.
You are a realistic, unsentimental simulator. Many hackathon teams struggle and some fall apart. Do not default to success.
Ground every event in the profiles and personas: skills, preferred roles, interests, awake hours. Use first names only.

Play these five beats in order, exactly one moment per beat, with these exact times:
1. "Fri 18:00" kickoff: first impressions. Does the newcomer's agenda fit the team's idea?
2. "Fri 22:00" roles: who owns what. If the newcomer's preferred role is already owned, decide realistically whether they flex, clash or get sidelined.
3. "Sat 03:00" night shift: only people whose awake hours include 03:00 can work. Name who is asleep.
4. "Sat 14:00" crisis: the given crisis hits. Show how the team, and the newcomer specifically, respond.
5. "Sun 11:00" demo prep: what actually works for the demo.

Each moment's "what" is one vivid, friendly sentence of at most 25 words that mentions a concrete skill or tool.
"who" is a first name, or names joined with " + ". At least three of the five moments involve the newcomer.

Then judge, and let the profiles decide, not a default:
- A team whose roles complement each other, whose hours overlap and who share the topic usually ships despite the crisis.
- Role clashes, a missing critical skill, or nobody awake at the same time often end in "partial" or "fell_apart".
- outcome: "shipped" (a working demo, even if rough), "partial" (demo with major parts faked) or "fell_apart" (no coherent demo, or the team split).
- solo_contribution: "core" (newcomer owned a critical piece), "helpful", or "sidelined".
- solo_role: the newcomer's actual role this weekend, in at most 6 words.
- conflicts: 0 to 3 concrete frictions, each one sentence naming the people involved.
- one_liner: how the weekend ended, one friendly sentence.`;

const FORMAT = {
  type: "json_schema" as const,
  name: "weekend",
  strict: true as const,
  schema: {
    type: "object",
    properties: {
      solo_role: { type: "string" },
      moments: {
        type: "array",
        items: {
          type: "object",
          properties: { time: { type: "string" }, who: { type: "string" }, what: { type: "string" } },
          required: ["time", "who", "what"],
          additionalProperties: false,
        },
      },
      conflicts: { type: "array", items: { type: "string" } },
      solo_contribution: { type: "string", enum: ["core", "helpful", "sidelined"] },
      outcome: { type: "string", enum: ["shipped", "partial", "fell_apart"] },
      one_liner: { type: "string" },
    },
    required: ["solo_role", "moments", "conflicts", "solo_contribution", "outcome", "one_liner"],
    additionalProperties: false,
  },
};

function brief(p: Participant, persona: Persona) {
  return { ...modelView(p), persona };
}

function scenario(solo: Participant, soloPersona: Persona, team: Team, teamPersonas: Persona[], crisis: string) {
  return JSON.stringify(
    {
      team: { name: team.name, idea: team.idea, missingRoles: team.missingRoles },
      members: team.members.map((m, i) => brief(m, teamPersonas[i])),
      newcomer: brief(solo, soloPersona),
      crisis,
    },
    null,
    1
  );
}

export function cachedRuns(solo: Participant, team: Team): Run[] | undefined {
  return sims.get(pairKey(solo, team.id));
}

/** K parallel weekends, one crisis each. Keeps whatever runs finish; throws only if none do. */
export async function simulatePair(
  solo: Participant,
  soloPersona: Persona,
  team: Team,
  teamPersonas: Persona[],
  timeoutMs = 25_000
): Promise<Run[]> {
  const key = pairKey(solo, team.id);
  const hit = sims.get(key);
  if (hit) return hit;
  if (!hasKey()) throw new Error("no OPENAI_API_KEY");

  const settled = await Promise.allSettled(
    CRISES.map(async (crisis, i) => {
      const run = await jsonCall<Omit<Run, "crisis">>({
        label: `sim ${solo.firstName}→${team.name} #${i + 1}`,
        instructions: INSTRUCTIONS,
        input: scenario(solo, soloPersona, team, teamPersonas, crisis),
        format: FORMAT,
        cacheKey: "spoilers-sim-v1",
        timeoutMs,
      });
      return { crisis, ...run } as Run;
    })
  );
  const runs = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  for (const s of settled) if (s.status === "rejected") console.error("[sim] run failed:", (s.reason as Error)?.message);
  if (!runs.length) throw new Error(`all runs failed for ${team.name}`);
  sims.set(key, runs);
  return runs;
}
