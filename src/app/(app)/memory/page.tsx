"use client";

import { useEffect, useState } from "react";

type Entry = {
  id: string;
  kind: string;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  score?: number;
};

const KIND_CLS: Record<string, string> = {
  lesson: "sev-low",
  error: "sev-critical",
  pattern: "sev-info",
  preference: "sev-medium",
  snippet: "sev-info",
};

export default function MemoryPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: "lesson", title: "", content: "", tags: "" });

  async function load(query = "") {
    setLoading(true);
    const url = query ? `/api/memory?q=${encodeURIComponent(query)}` : "/api/memory";
    const res = await fetch(url);
    const data = await res.json();
    setEntries(data.entries ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: form.kind,
        title: form.title,
        content: form.content,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      }),
    });
    if (res.ok) {
      setForm({ kind: "lesson", title: "", content: "", tags: "" });
      setAdding(false);
      load();
    }
  }

  async function remove(id: string) {
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
    setEntries((e) => e.filter((x) => x.id !== id));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Memory</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Lessons, past mistakes and patterns the pipeline recalls when building new plugins.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "+ Add memory"}
        </button>
      </div>

      {adding && (
        <form onSubmit={add} className="card space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <div>
              <label className="label">Kind</label>
              <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {["lesson", "error", "pattern", "preference", "snippet"].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Title</label>
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
          </div>
          <div>
            <label className="label">Content</label>
            <textarea className="input min-h-[100px]" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} required />
          </div>
          <div>
            <label className="label">Tags (comma separated)</label>
            <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </div>
          <button className="btn-primary">Save memory</button>
        </form>
      )}

      <div className="flex gap-2">
        <input
          className="input"
          placeholder="Search memory (semantic if embeddings enabled)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(q)}
        />
        <button className="btn-ghost" onClick={() => load(q)}>Search</button>
        {q && (
          <button className="btn-ghost" onClick={() => { setQ(""); load(); }}>Clear</button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="card p-6 text-sm text-[var(--color-muted)]">
          No memories yet. They accumulate automatically as you generate plugins (especially from fixed mistakes).
        </div>
      ) : (
        <ul className="space-y-2">
          {entries.map((m) => (
            <li key={m.id} className="card p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className={`badge ${KIND_CLS[m.kind] ?? "sev-info"}`}>{m.kind}</span>
                <span className="font-medium">{m.title}</span>
                {typeof m.score === "number" && m.score > 0 && (
                  <span className="text-xs text-[var(--color-muted)]">match {(m.score * 100).toFixed(0)}%</span>
                )}
                <button className="ml-auto text-xs text-red-300 hover:underline" onClick={() => remove(m.id)}>
                  delete
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-[var(--color-muted)]">{m.content}</p>
              {m.tags?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {m.tags.map((t) => (
                    <span key={t} className="badge bg-[var(--color-panel-2)] text-[var(--color-muted)]">#{t}</span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
