import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import LogoutButton from "@/components/LogoutButton";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <nav className="flex items-center gap-1">
            <Link href="/" className="mr-3 font-bold tracking-tight">
              🔧 <span className="hidden sm:inline">WP Plugin </span>
              <span className="text-[var(--color-accent)]">Forge</span>
            </Link>
            <NavLink href="/">Plugins</NavLink>
            <NavLink href="/memory">Memory</NavLink>
            <NavLink href="/settings">Settings</NavLink>
          </nav>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-[var(--color-muted)] sm:inline">{user.email}</span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-sm text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      {children}
    </Link>
  );
}
