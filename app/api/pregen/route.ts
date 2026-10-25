import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import participants from "@/data/participants.json";
import uiTeams from "@/data/ui-teams.json";
import { teamFromAny } from "@/lib/adapt";
import { dump } from "@/lib/cache";
import { rankTeams } from "@/lib/fit";
import { TEAMS } from "@/lib/match";
import { getPersona } from "@/lib/persona";
import { simulatePair } from "@/lib/simulate";
import type { Participant } from "@/lib/types";

export const maxDuration = 300;

/**
 * Dev only: builds data/cache.json so the demo path runs with no key and no wifi.
 * The hero gets every team simulated; other demo solos get their top 6 by fit.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "dev only" }, { status: 404 });

  const solos = participants as Participant[];
  // The platform UI's prototype teams (NovaThetop seed()), converted exactly as /api/compatibility converts them.
  const ui = (uiTeams as unknown[]).map(teamFromAny).filter((t): t is NonNullable<typeof t> => !!t);
  const everyone = [...solos, ...TEAMS.flatMap((t) => t.members), ...ui.flatMap((t) => t.members)];
  await Promise.all(everyone.map((p) => getPersona(p, { live: true })));

  const hero = solos[0];
  const pairs = [
    ...[...ui, ...TEAMS].map((team) => ({ p: hero, team })),
    ...solos.slice(1).flatMap((p) => rankTeams(p, TEAMS, { limit: 6 }).map(({ team }) => ({ p, team }))),
  ];

  let done = 0;
  const failed: string[] = [];
  const queue = [...pairs];
  async function worker() {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { p, team } = job;
      try {
        const solo = await getPersona(p, { live: true });
        const teamPersonas = await Promise.all(team.members.map((m) => getPersona(m, { live: true })));
        await simulatePair(p, solo, team, teamPersonas, 60_000);
        done++;
      } catch (err) {
        failed.push(`${p.firstName}→${team.name}: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  await writeFile(path.join(process.cwd(), "data/cache.json"), JSON.stringify(dump(), null, 1));
  return NextResponse.json({ pairs: pairs.length, done, failed });
}
