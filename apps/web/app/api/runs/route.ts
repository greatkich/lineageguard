import { NextResponse } from "next/server";
import { fetchRuns } from "@/lib/db";

export async function GET() {
  try {
    const runs = await fetchRuns();
    return NextResponse.json(runs);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
