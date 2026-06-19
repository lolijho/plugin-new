import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import { verifyPassword, signSession, setSessionCookie } from "@/lib/auth";
import { badRequest, json, serverError } from "@/lib/api";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = schema.safeParse(await req.json());
    if (!body.success) return badRequest("Invalid credentials");
    const { email, password } = body.data;

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return badRequest("Invalid email or password.");
    }

    const token = await signSession(user);
    await setSessionCookie(token);
    return json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (err) {
    return serverError(err);
  }
}
