import { NextResponse } from "next/server";
import { TEAMS } from "@/lib/match";

/** Demo only: join requests live in this instance's memory. */
const requests: { participantId: string; teamId: string; at: string }[] = [];

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const teamId = typeof body?.teamId === "string" ? body.teamId : "";
  const participantId = typeof body?.participantId === "string" ? body.participantId.slice(0, 60) : "anon";
  const team = TEAMS.find((t) => t.id === teamId);
  if (!team) return NextResponse.json({ error: "unknown teamId" }, { status: 400 });
  requests.push({ participantId, teamId, at: new Date().toISOString() });
  return NextResponse.json({ status: "requested", teamId, teamName: team.name });
}

export async function GET() {
  return NextResponse.json({ requests });
}
