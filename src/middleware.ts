import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "wpforge_session";

// Paths that never require auth.
const PUBLIC_PATHS = ["/login", "/register"];

function getSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.AUTH_SECRET ?? "");
}

async function isValid(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, getSecret());
    return true;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const authed = await isValid(token);

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Bounce authed users away from the auth pages.
  if (authed && isPublic) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  if (!authed && !isPublic) {
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Protect everything except Next internals, the auth API, and static assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
