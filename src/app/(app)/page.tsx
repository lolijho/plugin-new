"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/StatusBadge";

type Plugin = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  updatedAt: string;
};

export default function DashboardPage() {
  const router = useRouter();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/plugins");
    const data = await res.json();
    setPlugins(data.plugins ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, name: name || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create plugin");
      router.push(`/plugins/${data.plugin.id}?start=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Your plugins</h1>
        {loading ? (
          <p className="text-sm text-[var(--color-muted)]">Loading…</p>
        ) : plugins.length === 0 ? (
          <div className="card p-8 text-center text-sm text-[var(--color-muted)]">
            No plugins yet. Describe one on the right to get started →
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {plugins.map((p) => (
              <li key={p.id}>
                <Link href={`/plugins/${p.id}`} className="card block p-4 transition-colors hover:border-[var(--color-accent)]">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <span className="font-medium">{p.name}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  <p className="line-clamp-2 text-sm text-[var(--color-muted)]">
                    {p.description || "No description yet."}
                  </p>
                  <p className="mt-3 font-mono text-xs text-[var(--color-muted)]">{p.slug}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold">New plugin</h2>
        <form onSubmit={create} className="card space-y-3 p-4">
          <div>
            <label className="label">Name (optional)</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Smart FAQ Accordion" />
          </div>
          <div>
            <label className="label">What should the plugin do?</label>
            <textarea
              className="input min-h-[160px] resize-y"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Describe the plugin: features, admin settings, shortcodes/blocks, data it stores, integrations, security requirements…"
              required
            />
          </div>
          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
          <button className="btn-primary w-full" disabled={creating || brief.trim().length < 10}>
            {creating ? "Creating…" : "Create & design architecture"}
          </button>
          <p className="text-xs text-[var(--color-muted)]">
            The architect model will propose a full file structure for your approval before any code is written.
          </p>
        </form>
      </section>
    </div>
  );
}
