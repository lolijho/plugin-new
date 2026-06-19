import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, users } from "@/db";
import { hashPassword, signSession, setSessionCookie } from "@/lib/auth";
import { badRequest, json, serverError } from "@/lib/api";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().trim().max(120).optional(),
});

export async function POST(req: Request) {
  try {
    const body = schema.safeParse(await req.json());
    if (!body.success) return badRequest(body.error.issues[0]?.message ?? "Invalid input");
    const { email, password, name } = body.data;

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
    const allow = (process.env.ALLOW_REGISTRATION ?? "true") !== "false";
    if (count > 0 && !allow) {
      return badRequest("Registration is disabled.");
    }

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    if (existing.length) return badRequest("An account with this email already exists.");

    const [user] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        name: name || null,
        passwordHash: await hashPassword(password),
        role: count === 0 ? "admin" : "user", // first user is admin
      })
      .returning();

    const token = await signSession(user);
    await setSessionCookie(token);
    return json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (err) {
    return serverError(err);
  }
}
