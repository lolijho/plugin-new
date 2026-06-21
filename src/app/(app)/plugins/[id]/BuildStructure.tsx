"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginManifest } from "@/lib/types";
import SeverityBadge from "@/components/SeverityBadge";

type CreatedFile = { path: string; worstSeverity: string | null };
type Action = "generate-file" | "analyze-file" | "fix-file";
type Job = {
  id: string;
  path: string;
  action: Action;
  status: "queued" | "running" | "failed";
  progress: number;
  label: string | null;
  error: string | null;
};

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "(root)" : p.slice(0, i);
}
const ACTION_SHORT: Record<Action, string> = {
  "generate-file": "crea",
  "analyze-file": "analizza",
  "fix-file": "correggi",
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
  const [serverJobs, setServerJobs] = useState<Job[]>([]);
  const [paused, setPaused] = useState(false);
  const [display, setDisplay] = useState(0); // smoothed % for the running job
  const [error, setError] = useState<string | null>(null);

  const runningRef = useRef<{ id: string; floor: number } | null>(null);
  const prevRunningId = useRef<string | null>(null);
  const prevActive = useRef(0);

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

  const running = serverJobs.find((j) => j.status === "running") ?? null;
  const queued = serverJobs.filter((j) => j.status === "queued");
  const failed = serverJobs.filter((j) => j.status === "failed");

  const pendingKeys = useMemo(() => {
    const s = new Set<string>();
    for (const j of serverJobs) if (j.status !== "failed") s.add(`${j.path}|${j.action}`);
    return s;
  }, [serverJobs]);

  const total = manifest.files.length;
  const createdCount = manifest.files.filter((f) => createdMap.has(f.path)).length;
  const pendingPaths = manifest.files.filter((f) => !createdMap.has(f.path)).map((f) => f.path);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/plugins/${pluginId}/queue`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { paused: boolean; jobs: Job[] };
      setServerJobs(data.jobs);
      setPaused(data.paused);

      const run = data.jobs.find((j) => j.status === "running") ?? null;
      // Smooth progress bookkeeping.
      if (run) {
        if (runningRef.current?.id !== run.id) {
          runningRef.current = { id: run.id, floor: run.progress };
          setDisplay(run.progress);
        } else {
          runningRef.current.floor = run.progress;
          setDisplay((d) => Math.max(d, run.progress));
        }
      } else {
        runningRef.current = null;
        setDisplay(0);
      }

      // Refresh the file tree when a file finishes (running job changes / queue shrinks).
      const activeCount = data.jobs.filter((j) => j.status !== "failed").length;
      const runId = run?.id ?? null;
      if (runId !== prevRunningId.current || activeCount < prevActive.current) {
        await onChanged();
      }
      prevRunningId.current = runId;
      prevActive.current = activeCount;
    } catch {
      /* ignore transient poll errors */
    }
  }, [pluginId, onChanged]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [poll]);

  // Creep the running bar between server milestones so it always moves.
  useEffect(() => {
    const t = setInterval(() => {
      const r = runningRef.current;
      if (!r) return;
      const cap = Math.min(r.floor + 12, 96);
      setDisplay((d) => (d < cap ? Math.min(d + 1, cap) : d));
    }, 700);
    return () => clearInterval(t);
  }, []);

  async function enqueue(items: { path: string; action: Action }[]) {
    const toAdd = items.filter((it) => !pendingKeys.has(`${it.path}|${it.action}`));
    if (toAdd.length === 0) return;
    setError(null);
    try {
      const res = await fetch(`/api/plugins/${pluginId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: toAdd }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Impossibile accodare");
      }
      await poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "errore");
    }
  }

  async function control(action: string, jobId?: string) {
    await fetch(`/api/plugins/${pluginId}/queue/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, jobId }),
    });
    await poll();
  }

  const isCurrent = (path: string) => running?.path === path;
  const isPending = (path: string, action: Action) => pendingKeys.has(`${path}|${action}`);

  return (
    <div className="space-y-4">
      {/* Progress + global actions */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-semibold">File creati: {createdCount}/{total}</div>
          <div className="mt-1 h-1.5 w-56 overflow-hidden rounded bg-[var(--color-panel-2)]">
            <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${total ? (createdCount / total) * 100 : 0}%` }} />
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            La coda gira <b>sul server</b>: puoi chiudere l’app o spegnere il computer, la creazione continua. Riapri quando vuoi per vedere l’avanzamento.
          </p>
        </div>
        <button className="btn-ghost" disabled={pendingPaths.length === 0} onClick={() => enqueue(pendingPaths.map((p) => ({ path: p, action: "generate-file" as const })))}>
          ＋ Coda tutti i rimanenti ({pendingPaths.length})
        </button>
      </div>

      {/* Queue panel */}
      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold">
            Coda{" "}
            <span className="text-[var(--color-muted)]">
              · {running ? "in lavorazione" : paused ? "in pausa" : queued.length > 0 ? "in attesa" : "vuota"}
            </span>
          </span>
          <div className="flex items-center gap-2">
            {paused ? (
              <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => control("resume")}>▶ Riprendi</button>
            ) : (
              <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!running && queued.length === 0} onClick={() => control("pause")}>⏸ Pausa</button>
            )}
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={queued.length === 0 && failed.length === 0} onClick={() => control("clear")}>Svuota</button>
          </div>
        </div>

        {running && (
          <div className="mb-2 rounded-lg bg-[var(--color-panel-2)] px-3 py-2">
            <div className="mb-1.5 flex items-center gap-2 text-sm">
              <span className="animate-pulse">⏳</span>
              <span className="font-mono text-xs">{running.path}</span>
              <span className="text-xs text-[var(--color-accent)]">{running.label ?? `${ACTION_SHORT[running.action]}…`}</span>
              <span className="ml-auto text-sm font-semibold tabular-nums">{display}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-bg)]">
              <div className="h-full rounded bg-[var(--color-accent)] transition-all duration-500" style={{ width: `${display}%` }} />
            </div>
          </div>
        )}

        {queued.length === 0 && !running && failed.length === 0 ? (
          <p className="text-xs text-[var(--color-muted)]">Nessun elemento in coda.</p>
        ) : (
          <ul className="space-y-1">
            {queued.map((j, i) => (
              <li key={j.id} className="flex items-center gap-2 text-xs">
                <span className="w-5 text-center text-[var(--color-muted)]">{i + 1}</span>
                <span className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-muted)]">{ACTION_SHORT[j.action]}</span>
                <span className="font-mono">{j.path}</span>
                <button className="ml-auto text-red-300 hover:underline" onClick={() => control("remove", j.id)}>rimuovi</button>
              </li>
            ))}
            {failed.map((j) => (
              <li key={j.id} className="flex items-center gap-2 text-xs text-red-300">
                <span className="w-5 text-center">⚠</span>
                <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] uppercase">{ACTION_SHORT[j.action]}</span>
                <span className="font-mono">{j.path}</span>
                <span className="truncate text-[var(--color-muted)]">{j.error}</span>
                <span className="ml-auto flex gap-2">
                  <button className="hover:underline" onClick={() => control("retry", j.id)}>riprova</button>
                  <button className="text-red-300 hover:underline" onClick={() => control("remove", j.id)}>rimuovi</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Severity legend */}
      <div className="card flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-xs text-[var(--color-muted)]">
        <span className="font-semibold uppercase tracking-wide">Gravità:</span>
        <span><span className="badge sev-critical">critical</span> rompe il sito / sicurezza</span>
        <span><span className="badge sev-high">high</span> bug probabile</span>
        <span><span className="badge sev-medium">medium</span> standard / i18n</span>
        <span><span className="badge sev-low">low/info</span> minore</span>
      </div>

      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      {/* File tree grouped by folder */}
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
                disabled={pendingInDir.length === 0}
                onClick={() => enqueue(pendingInDir.map((p) => ({ path: p, action: "generate-file" as const })))}
              >
                ＋ Coda cartella ({pendingInDir.length})
              </button>
            </div>
            <ul className="divide-y divide-[var(--color-border)]">
              {files.map((f) => {
                const created = createdMap.get(f.path);
                const current = isCurrent(f.path);
                const base = f.path.slice(f.path.lastIndexOf("/") + 1);
                const hasIssues = created?.worstSeverity && created.worstSeverity !== "info";
                return (
                  <li key={f.path} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-5 text-center">{current ? "⏳" : created ? "✅" : "⚪"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{base}</span>
                        {created && <SeverityBadge severity={created.worstSeverity} />}
                      </div>
                      <p className="truncate text-xs text-[var(--color-muted)]">{f.purpose}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {current ? (
                        <span className="text-xs font-semibold tabular-nums text-[var(--color-accent)]">{display}%</span>
                      ) : !created ? (
                        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={isPending(f.path, "generate-file")} onClick={() => enqueue([{ path: f.path, action: "generate-file" }])}>
                          {isPending(f.path, "generate-file") ? "in coda" : "Crea"}
                        </button>
                      ) : (
                        <>
                          <button className="btn-ghost px-2.5 py-1 text-xs" disabled={isPending(f.path, "analyze-file")} onClick={() => enqueue([{ path: f.path, action: "analyze-file" }])}>
                            {isPending(f.path, "analyze-file") ? "in coda" : "Analizza"}
                          </button>
                          {hasIssues && (
                            <button className="btn-ghost px-2.5 py-1 text-xs text-amber-300" disabled={isPending(f.path, "fix-file")} onClick={() => enqueue([{ path: f.path, action: "fix-file" }])}>
                              {isPending(f.path, "fix-file") ? "in coda" : "Correggi"}
                            </button>
                          )}
                          <button className="btn-ghost px-2.5 py-1 text-xs" disabled={isPending(f.path, "generate-file")} onClick={() => enqueue([{ path: f.path, action: "generate-file" }])}>
                            {isPending(f.path, "generate-file") ? "in coda" : "Rigenera"}
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
