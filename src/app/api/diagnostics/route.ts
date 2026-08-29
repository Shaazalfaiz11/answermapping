import { NextResponse } from "next/server";
import { clearCallHistory, getCallHistory } from "@/lib/groq";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ history: getCallHistory() });
}

export async function DELETE() {
  clearCallHistory();
  return NextResponse.json({ ok: true });
}
