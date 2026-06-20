"use client";

import { useMemo, useState } from "react";
import type { PluginManifest } from "@/lib/types";
import SeverityBadge from "@/components/SeverityBadge";

type CreatedFile = { path: string; worstSeverity: string | null };
type Action = "generate-file" | "analyze-file" | "fix-file";

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "(root)" : p.slice(0, i);
}

const ACTION_LABEL: Record<Action, string> = {
  "generate-file": "Creazione…",
  "analyze-file": "Analisi…",
  "fix-file": "Correzione…",
};

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
  const [active, setActive] = useState<{ path: string; action: Action } | null>(null);
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
    return [...map.entries()].sort(([a], [b]) =>
      a === "(root)" ? -1 : b === "(root)" ? 1 : a.localeCompare(b),
    );
  }, [manifest.files]);

  const total = manifest.files.length;
  const createdCount = manifest.files.filter((f) => createdMap.has(f.path)).length;
  const pendingPaths = manifest.files.filter((f) => !createdMap.has(f.path)).map((f) => f.path);

  async function callAction(path: string, action: Action): Promise<boolean> {
    setActive({ path, action });
    setError(null);
    try {
      const res = await fetch(`/api/plugins/${pluginId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Operazione fallita");
      await onChanged();
      return true;
    } catch (err) {
      setError(`${path}: ${err instanceof Error ? err.message : "errore"}`);
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
        const ok = await callAction(p, "generate-file");
        if (!ok) break; // stop on first error so the user can intervene
      }
    } finally {
      setBusy(false);
    }
  }

  const anyRunning = busy || active !== null;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold">File creati: {createdCount}/{total}</div>
          <div className="mt-1 h-1.5 w-56 overflow-hidden rounded bg-[var(--color-panel-2)]">
            <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${total ? (createdCount / total) * 100 : 0}%` }} />
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Crea i file uno a uno (o per cartella) per non sovraccaricare. Il lavoro resta salvato: puoi riprendere quando vuoi.
          </p>
        </div>
        <button className="btn-primary" disabled={anyRunning || pendingPaths.length === 0} onClick={() => buildSequential(pendingPaths)}>
          {busy ? "Creazione in corso…" : `Crea tutti i rimanenti (${pendingPaths.length})`}
        </button>
      </div>

      {/* Severity legend */}
      <div className="card flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-xs text-[var(--color-muted)]">
        <span className="font-semibold uppercase tracking-wide">Gravità:</span>
        <span><span className="badge sev-critical">critical</span> rompe il sito / falla di sicurezza</span>
        <span><span className="badge sev-high">high</span> bug probabile</span>
        <span><span className="badge sev-medium">medium</span> standard / i18n</span>
        <span><span className="badge sev-low">low/info</span> minore</span>
        <span className="w-full pt-1">Usa <b>Analizza</b> per ri-controllare un file e <b>Correggi</b> per farlo riscrivere risolvendo i problemi.</span>
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
              <button className="btn-ghost px-2.5 py-1 text-xs" disabled={anyRunning || pendingInDir.length === 0} onClick={() => buildSequential(pendingInDir)}>
                Crea cartella ({pendingInDir.length})
              </button>
            </div>
            <ul className="divide-y divide-[var(--color-border)]">
              {files.map((f) => {
                const created = createdMap.get(f.path);
                const isActive = active?.path === f.path;
                const base = f.path.slice(f.path.lastIndexOf("/") + 1);
                const hasIssues = created?.worstSeverity && created.worstSeverity !== "info";
                return (
                  <li key={f.path} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-5 text-center">{isActive ? "⏳" : created ? "✅" : "⚪"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{base}</span>
                        {created && <SeverityBadge severity={created.worstSeverity} />}
                      </div>
                      <p className="truncate text-xs text-[var(--color-muted)]">{f.purpose}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {isActive ? (
                        <span className="text-xs text-[var(--color-accent)]">{ACTION_LABEL[active!.action]}</span>
                      ) : !created ? (
                        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={anyRunning} onClick={() => callAction(f.path, "generate-file")}>
                          Crea file
                        </button>
                      ) : (
                        <>
                          <button className="btn-ghost px-2.5 py-1 text-xs" disabled={anyRunning} onClick={() => callAction(f.path, "analyze-file")}>
                            Analizza
                          </button>
                          {hasIssues && (
                            <button className="btn-ghost px-2.5 py-1 text-xs text-amber-300" disabled={anyRunning} onClick={() => callAction(f.path, "fix-file")}>
                              Correggi
                            </button>
                          )}
                          <button className="btn-ghost px-2.5 py-1 text-xs" disabled={anyRunning} onClick={() => callAction(f.path, "generate-file")}>
                            Rigenera
                          </button>
                        </>
                      )}
                    </div>
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
