import { clearSessionCookie } from "@/lib/auth";
import { json } from "@/lib/api";

export async function POST() {
  await clearSessionCookie();
  return json({ ok: true });
}
