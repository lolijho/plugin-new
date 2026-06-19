import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser } from "./auth";
import type { DbUser } from "@/db/schema";

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function notFound(message = "Not found") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api] error:", err);
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Returns the user or a 401 response. Use: const u = await authed(); if (u instanceof NextResponse) return u; */
export async function authed(): Promise<DbUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  return user;
}
