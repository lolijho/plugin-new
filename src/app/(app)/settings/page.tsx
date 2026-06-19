"use client";

import { useEffect, useState } from "react";

type Settings = {
  models?: { architect?: string; coder?: string; reviewer?: string };
  openrouterApiKey?: string;
  temperature?: { architect?: number; coder?: number; reviewer?: number };
  autofixIterations?: number;
};
type Model = { id: string; name: string };

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Model[]>([]);
  const [embeddings, setEmbeddings] = useState(false);
  const [hasServerKey, setHasServerKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setSettings(data.settings ?? {});
      setDefaults(data.defaults ?? {});
      setEmbeddings(data.embeddingsEnabled);
      setHasServerKey(data.hasServerKey);
      setLoading(false);
      // Models can fail if no key at all; don't block the page.
      try {
        const m = await fetch("/api/models");
        const md = await m.json();
        if (m.ok) setModels(md.models ?? []);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  function setModel(role: "architect" | "coder" | "reviewer", v: string) {
    setSettings((s) => ({ ...s, models: { ...s.models, [role]: v } }));
  }

  async function save() {
    setError(null);
    setSaved(false);
    const payload: Settings & { openrouterApiKey?: string } = { ...settings };
    if (apiKey) payload.openrouterApiKey = apiKey;
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not save");
      return;
    }
    setSettings(data.settings);
    setApiKey("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  if (loading) return <p className="text-sm text-[var(--color-muted)]">Loading…</p>;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">Models (OpenRouter)</h2>
        <p className="text-sm text-[var(--color-muted)]">
          Pick a model per role. {models.length > 0 ? `${models.length} models available.` : "Live model list unavailable — type an id manually."}
        </p>
        {(["architect", "coder", "reviewer"] as const).map((role) => (
          <div key={role}>
            <label className="label capitalize">{role} model</label>
            <input
              className="input font-mono"
              list="model-list"
              placeholder={defaults[role]}
              value={settings.models?.[role] ?? ""}
              onChange={(e) => setModel(role, e.target.value)}
            />
            <p className="mt-1 text-xs text-[var(--color-muted)]">Default: {defaults[role]}</p>
          </div>
        ))}
        <datalist id="model-list">
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </datalist>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">Pipeline</h2>
        <div>
          <label className="label">Autofix iterations per file (0–5)</label>
          <input
            className="input w-24"
            type="number"
            min={0}
            max={5}
            value={settings.autofixIterations ?? 2}
            onChange={(e) => setSettings((s) => ({ ...s, autofixIterations: Number(e.target.value) }))}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            How many times the coder may rewrite a file to clear critical/high review findings.
          </p>
        </div>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">API keys</h2>
        <div>
          <label className="label">Your OpenRouter API key (optional)</label>
          <input
            className="input font-mono"
            type="password"
            placeholder={settings.openrouterApiKey ? "•••••• (stored)" : hasServerKey ? "Using server key" : "sk-or-v1-…"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Overrides the server key. Leave empty to keep {hasServerKey ? "the server key" : "your stored key"}. Submit an empty save after clearing to remove a stored key.
          </p>
        </div>
        <div className="text-sm">
          Semantic memory (embeddings):{" "}
          {embeddings ? (
            <span className="badge sev-low">enabled</span>
          ) : (
            <span className="badge sev-info">disabled — using full-text fallback</span>
          )}
        </div>
      </section>

      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save}>Save settings</button>
        {saved && <span className="text-sm text-emerald-300">Saved ✓</span>}
      </div>
    </div>
  );
}
