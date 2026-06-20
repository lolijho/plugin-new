"use client";

import { useMemo, useRef, useState } from "react";
import type { PluginManifest } from "@/lib/types";
import SeverityBadge from "@/components/SeverityBadge";

type CreatedFile = { path: string; worstSeverity: string | null };
type Action = "generate-file" | "analyze-file" | "fix-file";
type QueueItem = { path: string; action: Action };

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "(root)" : p.slice(0, i);
}
const keyOf = (it: QueueItem) => `${it.path}|${it.action}`;
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
  // The queue is held in a ref (source of truth for the async worker) and
  // mirrored to state for rendering.
  const queueRef = useRef<QueueItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const processingRef = useRef(false);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = () => setQueue([...queueRef.current]);

  const createdMap = useMemo(() => {
    const m = new Map<string, CreatedFile>();
    for (const f of createdFiles) m.set(f.path, f);
    return m;
  }, [createdFiles]);

  const queuedKeys = useMemo(() => {
    const s = new Set(queue.map(keyOf));
    if (current) s.add(keyOf(current));
    return s;
  }, [queue, current]);

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

  async function callAction(item: QueueItem): Promise<boolean> {
    const res = await fetch(`/api/plugins/${pluginId}/${item.action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: item.path }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Operazione fallita");
    return true;
  }

  async function runWorker() {
    if (processingRef.current || pausedRef.current) return;
    processingRef.current = true;
    setError(null);
    try {
      while (!pausedRef.current && queueRef.current.length > 0) {
        const item = queueRef.current[0];
        setCurrent(item);
        try {
          await callAction(item);
          queueRef.current.shift();
          sync();
          setCurrent(null);
          await onChanged();
        } catch (err) {
          // Pause the queue on error so the user can intervene; keep the item.
          setCurrent(null);
          setError(`${item.path} (${ACTION_SHORT[item.action]}): ${err instanceof Error ? err.message : "errore"}`);
          pausedRef.current = true;
          setPaused(true);
          break;
        }
      }
    } finally {
      processingRef.current = false;
    }
  }

  function enqueue(items: QueueItem[]) {
    const toAdd = items.filter((it) => !queuedKeys.has(keyOf(it)));
    if (toAdd.length === 0) return;
    queueRef.current.push(...toAdd);
    sync();
    // If not paused, the worker starts/continues. If the user paused (or an
    // error paused the queue), added items wait until they press Resume.
    runWorker();
  }

  function pause() {
    pausedRef.current = true;
    setPaused(true);
  }
  function resume() {
    pausedRef.current = false;
    setPaused(false);
    runWorker();
  }
  function clearQueue() {
    queueRef.current = [];
    sync();
  }
  function removeAt(i: number) {
    queueRef.current.splice(i, 1);
    sync();
  }

  const busy = current !== null;
  const waiting = queue.length;

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
            Aggiungi file e cartelle alla coda (anche mentre lavora). Vengono creati uno alla volta, così il sistema non si sovraccarica e il lavoro resta salvato.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" disabled={pendingPaths.length === 0} onClick={() => enqueue(pendingPaths.map((p) => ({ path: p, action: "generate-file" as const })))}>
            ＋ Coda tutti i rimanenti ({pendingPaths.length})
          </button>
        </div>
      </div>

      {/* Queue panel */}
      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold">
            Coda{" "}
            <span className="text-[var(--color-muted)]">
              · {busy ? "in lavorazione" : paused ? "in pausa" : waiting > 0 ? "in attesa" : "vuota"}
            </span>
          </span>
          <div className="flex items-center gap-2">
            {paused ? (
              <button className="btn-ghost px-2.5 py-1 text-xs" disabled={waiting === 0} onClick={resume}>▶ Riprendi</button>
            ) : (
              <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!busy && waiting === 0} onClick={pause}>⏸ Pausa</button>
            )}
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={waiting === 0} onClick={clearQueue}>Svuota</button>
          </div>
        </div>

        {current && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-[var(--color-panel-2)] px-3 py-2 text-sm">
            <span className="animate-pulse">⏳</span>
            <span className="font-mono text-xs">{current.path}</span>
            <span className="text-xs text-[var(--color-accent)]">{ACTION_SHORT[current.action]}…</span>
          </div>
        )}

        {waiting === 0 && !current ? (
          <p className="text-xs text-[var(--color-muted)]">Nessun elemento in coda. Usa “Crea”, “Coda cartella” o i pulsanti per file.</p>
        ) : (
          <ul className="space-y-1">
            {queue.map((it, i) => (
              <li key={`${keyOf(it)}-${i}`} className="flex items-center gap-2 text-xs">
                <span className="w-5 text-center text-[var(--color-muted)]">{i + 1}</span>
                <span className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 uppercase text-[10px] text-[var(--color-muted)]">{ACTION_SHORT[it.action]}</span>
                <span className="font-mono">{it.path}</span>
                <button className="ml-auto text-red-300 hover:underline" onClick={() => removeAt(i)}>rimuovi</button>
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
                const isCurrent = current?.path === f.path;
                const base = f.path.slice(f.path.lastIndexOf("/") + 1);
                const hasIssues = created?.worstSeverity && created.worstSeverity !== "info";
                const isQueued = (a: Action) => queuedKeys.has(`${f.path}|${a}`);
                return (
                  <li key={f.path} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-5 text-center">{isCurrent ? "⏳" : created ? "✅" : "⚪"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{base}</span>
                        {created && <SeverityBadge severity={created.worstSeverity} />}
                      </div>
                      <p className="truncate text-xs text-[var(--color-muted)]">{f.purpose}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!created ? (
                        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={isQueued("generate-file")} onClick={() => enqueue([{ path: f.path, action: "generate-file" }])}>
                          {isQueued("generate-file") ? "in coda" : "Crea"}
                        </button>
                      ) : (
                        <>
                          <button className="btn-ghost px-2.5 py-1 text-xs" disabled={isQueued("analyze-file")} onClick={() => enqueue([{ path: f.path, action: "analyze-file" }])}>
                            {isQueued("analyze-file") ? "in coda" : "Analizza"}
                          </button>
                          {hasIssues && (
                            <button className="btn-ghost px-2.5 py-1 text-xs text-amber-300" disabled={isQueued("fix-file")} onClick={() => enqueue([{ path: f.path, action: "fix-file" }])}>
                              {isQueued("fix-file") ? "in coda" : "Correggi"}
                            </button>
                          )}
                          <button className="btn-ghost px-2.5 py-1 text-xs" disabled={isQueued("generate-file")} onClick={() => enqueue([{ path: f.path, action: "generate-file" }])}>
                            {isQueued("generate-file") ? "in coda" : "Rigenera"}
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
