"use client";

import { useMemo, useState } from "react";
import type { PluginManifest } from "@/lib/types";
import SeverityBadge from "@/components/SeverityBadge";

type CreatedFile = { path: string; worstSeverity: string | null };

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "(root)" : p.slice(0, i);
}

export default function BuildStructure({
  pluginId,
  manifest,
  createdFiles,
  onChanged,
}: {
  pluginId: string;
  manifest: PluginManifest;
  createdFiles: CreatedFile[];
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createdMap = useMemo(() => {
    const m = new Map<string, CreatedFile>();
    for (const f of createdFiles) m.set(f.path, f);
    return m;
  }, [createdFiles]);

  const groups = useMemo(() => {
    const map = new Map<string, PluginManifest["files"]>();
    for (const f of manifest.files) {
      const d = dirOf(f.path);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(f);
    }
    // root first, then alphabetical
    return [...map.entries()].sort(([a], [b]) =>
      a === "(root)" ? -1 : b === "(root)" ? 1 : a.localeCompare(b),
    );
  }, [manifest.files]);

  const total = manifest.files.length;
  const createdCount = manifest.files.filter((f) => createdMap.has(f.path)).length;
  const pendingPaths = manifest.files.filter((f) => !createdMap.has(f.path)).map((f) => f.path);

  async function buildOne(path: string): Promise<boolean> {
    setActive(path);
    setError(null);
    try {
      const res = await fetch(`/api/plugins/${pluginId}/generate-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      await onChanged();
      return true;
    } catch (err) {
      setError(`${path}: ${err instanceof Error ? err.message : "failed"}`);
      return false;
    } finally {
      setActive(null);
    }
  }

  async function buildSequential(paths: string[]) {
    if (paths.length === 0) return;
    setBusy(true);
    try {
      for (const p of paths) {
        const ok = await buildOne(p);
        if (!ok) break; // stop on first error so the user can intervene
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold">
            File creati: {createdCount}/{total}
          </div>
          <div className="mt-1 h-1.5 w-56 overflow-hidden rounded bg-[var(--color-panel-2)]">
            <div
              className="h-full bg-[var(--color-accent)] transition-all"
              style={{ width: `${total ? (createdCount / total) * 100 : 0}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Crea i file uno a uno (o per cartella) per non sovraccaricare. Il lavoro resta salvato: puoi riprendere quando vuoi.
          </p>
        </div>
        <button
          className="btn-primary"
          disabled={busy || pendingPaths.length === 0}
          onClick={() => buildSequential(pendingPaths)}
        >
          {busy ? "Creazione in corso…" : `Crea tutti i rimanenti (${pendingPaths.length})`}
        </button>
      </div>

      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      {groups.map(([dir, files]) => {
        const pendingInDir = files.filter((f) => !createdMap.has(f.path)).map((f) => f.path);
        const doneInDir = files.length - pendingInDir.length;
        return (
          <div key={dir} className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-2">
              <span className="font-mono text-sm">
                📁 {dir} <span className="text-xs text-[var(--color-muted)]">({doneInDir}/{files.length})</span>
              </span>
              <button
                className="btn-ghost px-2.5 py-1 text-xs"
                disabled={busy || pendingInDir.length === 0}
                onClick={() => buildSequential(pendingInDir)}
              >
                Crea cartella ({pendingInDir.length})
              </button>
            </div>
            <ul className="divide-y divide-[var(--color-border)]">
              {files.map((f) => {
                const created = createdMap.get(f.path);
                const isActive = active === f.path;
                const base = f.path.slice(f.path.lastIndexOf("/") + 1);
                return (
                  <li key={f.path} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-5 text-center">
                      {isActive ? "⏳" : created ? "✅" : "⚪"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{base}</span>
                        {created && <SeverityBadge severity={created.worstSeverity} />}
                      </div>
                      <p className="truncate text-xs text-[var(--color-muted)]">{f.purpose}</p>
                    </div>
                    <button
                      className="btn-ghost px-2.5 py-1 text-xs"
                      disabled={busy || isActive}
                      onClick={() => buildOne(f.path)}
                    >
                      {isActive ? "Creazione…" : created ? "Rigenera" : "Crea file"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
