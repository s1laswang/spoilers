import { NextResponse } from "next/server";
import { allowLive } from "@/lib/limit";
import { matchFor, parseDeclines, parseParticipant } from "@/lib/match";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const participant = parseParticipant(body?.participant);
  if (!participant) {
    return NextResponse.json(
      { error: "participant needs firstName and preferredRole (design | code | hardware | AI | business)" },
      { status: 400 }
    );
  }
  const exclude = Array.isArray(body?.exclude)
    ? (body.exclude as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const declined = parseDeclines(body?.declined);

  const started = Date.now();
  const result = await matchFor(participant, { exclude, declined, live: allowLive(req) });
  console.error(`[match] ${participant.firstName} source=${result.source} ${Date.now() - started}ms`);
  return NextResponse.json(result);
}
