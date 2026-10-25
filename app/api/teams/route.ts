import { NextResponse } from "next/server";
import { TEAMS } from "@/lib/match";

export async function GET() {
  return NextResponse.json({ teams: TEAMS });
}
