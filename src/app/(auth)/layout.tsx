export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold tracking-tight">
            🔧 WP Plugin <span className="text-[var(--color-accent)]">Forge</span>
          </div>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Multi-model AI pipeline for WordPress plugins
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
