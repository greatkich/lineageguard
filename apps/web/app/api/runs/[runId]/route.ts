import { NextResponse } from "next/server";
import { fetchRun } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const run = await fetchRun(runId);
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(run);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
