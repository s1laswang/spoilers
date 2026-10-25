import { NextResponse } from "next/server";
import participants from "@/data/participants.json";
import { soloFromAny, teamFromAny } from "@/lib/adapt";
import { fitFor } from "@/lib/fit";
import { allowLive } from "@/lib/limit";
import { scorePair, TEAMS } from "@/lib/match";
import { lastErrorStatus } from "@/lib/llm";
import { getPersona } from "@/lib/persona";
import type { Participant } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * The slot in the platform spec (MATCHMAKING.md): compatibility(solo, team) → { score, reasons }.
 * Works in both directions (a solo browsing teams, an open team browsing solos).
 *
 * mode "fit" (default): profile fit only, no LLM, fast enough to fill every "% match" pill.
 * mode "simulate": adds the AI-simulated weekend (cache first, then live, capped per IP).
 * `reasons` are only profile facts; the simulation comes back separately as `prediction`.
 *
 * Body: { mode?, viewer?: "solo" | "team", solo | soloId, team | teamId }. viewer "team" words the
 * reasons for an open team looking at a solo ("You're missing a designer, and Lina is one"). Whole objects in the platform's shape
 * (roles[], skills[], links, interests?, awake?, evidence?; bio, lookingFor[]) or ours.
 * soloId "silas" is the demo hero, whose simulations are pre-generated.
 */
export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const solo =
    typeof body?.soloId === "string"
      ? ((participants as Participant[]).find((p) => p.id === body.soloId) ?? null)
      : soloFromAny(body?.solo);
  const team =
    typeof body?.teamId === "string"
      ? (TEAMS.find((t) => t.id === body.teamId) ?? teamFromAny(body?.team))
      : teamFromAny(body?.team);
  if (!solo || !team) {
    return NextResponse.json({ error: "need solo (or soloId) and team (or teamId)" }, { status: 400 });
  }

  const viewer = body?.viewer === "team" ? "team" : "solo";
  const fit = fitFor(solo, team, undefined, viewer);
  const reasons = [fit.facts.role, fit.facts.skills, fit.facts.interests, fit.facts.availability];
  if (body?.mode !== "simulate") {
    return NextResponse.json({ score: Math.round(100 * fit.score), reasons, mode: "fit", source: "fit" });
  }

  const live = allowLive(req);
  const agent = await getPersona(solo, { live });
  const { match, source } = await scorePair(solo, agent, team, fit, live);
  return NextResponse.json({
    score: match.compatibility,
    reasons,
    mode: "simulate",
    prediction: {
      label: "AI-simulated weekend (a prediction, not a fact)",
      agent,
      shippedRuns: match.shippedRuns,
      totalRuns: match.totalRuns,
      soloRole: match.soloRole,
      spoiler: match.spoiler,
      headsUp: match.headsUp,
    },
    source,
    // Why a simulate request fell back to fit only: an HTTP status (401 key, 429 quota) or "capped".
    ...(source === "fit-only" ? { simError: live ? lastErrorStatus : "capped" } : {}),
  });
}
