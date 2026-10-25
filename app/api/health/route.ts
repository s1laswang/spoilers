import { NextResponse } from "next/server";
import { hasKey, lastErrorStatus, SIM_MODEL } from "@/lib/llm";

export const dynamic = "force-dynamic";

/** Whether live simulation can run here. Reports presence of the key only, never its value. */
export async function GET() {
  return NextResponse.json({ hasKey: hasKey(), model: SIM_MODEL, lastErrorStatus });
}
