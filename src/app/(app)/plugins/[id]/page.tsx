"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type { PluginManifest } from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";
import SeverityBadge from "@/components/SeverityBadge";
import ManifestEditor from "./ManifestEditor";
import BuildStructure from "./BuildStructure";

type FileRow = {
  id: string;
  path: string;
  language: string;
  content: string;
  purpose: string;
  worstSeverity: string | null;
};
type Finding = {
  id: string;
  filePath: string;
  severity: string;
  category: string;
  line: number | null;
  message: string;
  suggestion: string | null;
  source: string;
};
type Message = {
  id: string;
  role: string;
  phase: string | null;
  content: string;
  model: string | null;
  fileId: string | null;
  createdAt: string;
};
type PluginRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  brief: string;
  manifest: PluginManifest | null;
  version: number;
};

type Tab = "architecture" | "structure" | "files" | "issues" | "log";

export default function PluginWorkspace() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();

  const [plugin, setPlugin] = useState<PluginRow | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [manifest, setManifest] = useState<PluginManifest | null>(null);
  const [brief, setBrief] = useState("");
  const [revisionNote, setRevisionNote] = useState("");
  const [tab, setTab] = useState<Tab>("architecture");
  const [selected, setSelected] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  // Manual file editing (Files tab)
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [savingFile, setSavingFile] = useState(false);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  // Per-file chat (Claude Opus)
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatStreaming, setChatStreaming] = useState("");
  const [chatPendingUser, setChatPendingUser] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/plugins/${id}`);
    if (!res.ok) {
      setError("Could not load plugin.");
      return;
    }
    const data = await res.json();
    setPlugin(data.plugin);
    setFiles(data.files ?? []);
    setFindings(data.findings ?? []);
    setMessages(data.messages ?? []);
    setBrief((b) => b || data.plugin.brief || "");
    if (data.plugin.manifest) setManifest((m) => m ?? data.plugin.manifest);
    const fileCount = data.files?.length ?? 0;
    const totalFiles = data.plugin.manifest?.files?.length ?? 0;
    setTab((t) => {
      if (t !== "architecture") return t; // don't fight manual navigation
      if (data.plugin.manifest && fileCount < totalFiles) return "structure";
      if (fileCount > 0) return "files";
      return t;
    });
    return data.plugin as PluginRow;
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const runArchitect = useCallback(
    async (opts: { brief?: string; revisionNote?: string }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/plugins/${id}/architect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Architect failed");
        setManifest(data.manifest);
        setRevisionNote("");
        setTab("architecture");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Architect failed");
      } finally {
        setBusy(false);
      }
    },
    [id, load],
  );

  // Auto-start architecture for freshly created plugins (?start=1).
  useEffect(() => {
    if (started.current) return;
    if (search.get("start") === "1" && plugin?.status === "draft") {
      started.current = true;
      runArchitect({ brief: plugin.brief });
    }
  }, [search, plugin, runArchitect]);

  async function saveManifest(silent = false) {
    if (!manifest) return;
    const res = await fetch(`/api/plugins/${id}/manifest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    if (!res.ok && !silent) {
      const d = await res.json();
      setError(d.error ?? "Could not save manifest");
    }
  }

  async function approveAndStructure() {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      await saveManifest(true);
      await load();
      setTab("structure");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setError(null);
    await saveManifest(true);
    setGenerating(true);
    setProgress([]);
    setTab("log");
    try {
      const res = await fetch(`/api/plugins/${id}/generate`, { method: "POST" });
      if (!res.body) throw new Error("No stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            handleEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      setProgress((p) => [...p, `⚠️ ${err instanceof Error ? err.message : "stream error"}`]);
    } finally {
      setGenerating(false);
      await load();
    }
  }

  function handleEvent(e: Record<string, unknown>) {
    const t = e.type as string;
    const push = (s: string) => setProgress((p) => [...p, s]);
    if (t === "file:start") push(`📝 [${e.index}/${e.total}] Coding ${e.path}…`);
    else if (t === "file:coded") push(`   ✓ written ${e.path}`);
    else if (t === "file:reviewed") push(`   🔍 reviewed ${e.path} — ${e.findings} finding(s)${e.worst ? `, worst: ${e.worst}` : ""}`);
    else if (t === "file:fixed") push(`   🛠️ autofix pass ${e.iteration} on ${e.path}`);
    else if (t === "file:done") push(`   ✅ done ${e.path}`);
    else if (t === "log") push(`ℹ️ ${e.message}`);
    else if (t === "phase") push(`— ${e.message}`);
    else if (t === "done") push(`🏁 Finished: ${e.status} (${e.critical} critical, ${e.high} high)`);
    else if (t === "error") push(`❌ ${e.message}`);
  }

  async function remove() {
    if (!confirm("Delete this plugin and all its files?")) return;
    await fetch(`/api/plugins/${id}`, { method: "DELETE" });
    router.push("/");
  }

  async function saveFile() {
    const sf = files.find((f) => f.path === selected) ?? files[0] ?? null;
    if (!sf) return;
    setSavingFile(true);
    setFileMsg(null);
    try {
      const res = await fetch(`/api/plugins/${id}/files/${sf.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Salvataggio fallito");
      setEditing(false);
      setFileMsg("Salvato ✓");
      await load();
      setTimeout(() => setFileMsg(null), 2500);
    } catch (err) {
      setFileMsg(err instanceof Error ? err.message : "errore");
    } finally {
      setSavingFile(false);
    }
  }

  async function sendChat() {
    const sf = files.find((f) => f.path === selected) ?? files[0] ?? null;
    if (!sf || chatInput.trim().length < 2) return;
    const msg = chatInput.trim();
    setChatSending(true);
    setChatError(null);
    setChatInput("");
    setChatPendingUser(msg);
    setChatStreaming("");
    try {
      const res = await fetch(`/api/plugins/${id}/files/${sf.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Chat fallita");
      }
      if (!res.body) throw new Error("Nessuno stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let evt: { type: string; text?: string; message?: string };
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (evt.type === "delta") setChatStreaming((s) => s + (evt.text ?? ""));
          else if (evt.type === "error") throw new Error(evt.message ?? "errore");
        }
      }
      await load();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "errore");
      setChatInput(msg);
    } finally {
      setChatSending(false);
      setChatPendingUser(null);
      setChatStreaming("");
    }
  }

  async function copyFile() {
    const sf = files.find((f) => f.path === selected) ?? files[0] ?? null;
    if (!sf) return;
    try {
      await navigator.clipboard.writeText(sf.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFileMsg("Copia non riuscita");
    }
  }

  // Tool: queue a fixer pass for every file that has a critical (or high) finding.
  async function fixCritical(severities: string[]) {
    const paths = [...new Set(findings.filter((f) => severities.includes(f.severity)).map((f) => f.filePath).filter(Boolean))];
    if (paths.length === 0) return;
    setError(null);
    try {
      const res = await fetch(`/api/plugins/${id}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: paths.map((p) => ({ path: p, action: "fix-file" })) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Errore nell'accodamento");
      }
      setTab("structure");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "errore");
    }
  }

  if (error && !plugin) return <div className="card p-6 text-red-300">{error}</div>;
  if (!plugin) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>;

  const hasFiles = files.length > 0;
  const builtCount = manifest ? manifest.files.filter((mf) => files.some((f) => f.path === mf.path)).length : 0;
  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  const criticalFiles = [...new Set(findings.filter((f) => f.severity === "critical").map((f) => f.filePath).filter(Boolean))];
  const selectedFile = files.find((f) => f.path === selected) ?? files[0] ?? null;
  const convoMessages = messages.filter((m) => !m.fileId);
  const fileChat = selectedFile ? messages.filter((m) => m.fileId === selectedFile.id) : [];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{plugin.name}</h1>
            <StatusBadge status={plugin.status} />
          </div>
          <p className="mt-0.5 font-mono text-xs text-[var(--color-muted)]">
            {plugin.slug} · v{plugin.version}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasFiles && (
            <a className="btn-ghost" href={`/api/plugins/${id}/zip`}>
              ⬇ Download ZIP
            </a>
          )}
          <button className="btn-danger" onClick={remove}>Delete</button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      {/* Critical-error fix tool */}
      {criticalFiles.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
          <div className="text-sm text-red-200">
            ⚠ Questo plugin ha <b>errori critici</b> in {criticalFiles.length} file. Lo strumento li mette in coda e fa riscrivere i file dal correttore (Claude) finché i critici sono risolti.
          </div>
          <button className="btn-primary shrink-0" onClick={() => fixCritical(["critical", "high"])}>
            🛠️ Risolvi errori critici ({criticalFiles.length})
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {(["architecture", "structure", "files", "issues", "log"] as Tab[]).map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm capitalize transition-colors ${
              tab === tb
                ? "border-[var(--color-accent)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {tb}
            {tb === "issues" && findings.length > 0 && (
              <span className="ml-1.5 rounded bg-[var(--color-panel-2)] px-1.5 text-xs">{findings.length}</span>
            )}
            {tb === "files" && hasFiles && (
              <span className="ml-1.5 rounded bg-[var(--color-panel-2)] px-1.5 text-xs">{files.length}</span>
            )}
            {tb === "structure" && manifest && (
              <span className="ml-1.5 rounded bg-[var(--color-panel-2)] px-1.5 text-xs">{builtCount}/{manifest.files.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ARCHITECTURE TAB */}
      {tab === "architecture" && (
        <div className="space-y-4">
          {!manifest ? (
            <div className="card space-y-3 p-4">
              <label className="label">Plugin brief</label>
              <textarea
                className="input min-h-[160px]"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Describe what the plugin should do…"
              />
              <button className="btn-primary" disabled={busy || brief.trim().length < 10} onClick={() => runArchitect({ brief })}>
                {busy ? "Designing…" : "Design architecture"}
              </button>
            </div>
          ) : (
            <>
              <div className="card p-4">
                <ManifestEditor value={manifest} onChange={setManifest} />
              </div>

              <div className="card space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn-primary" disabled={busy || generating} onClick={approveAndStructure}>
                    {busy ? "Salvataggio…" : "✓ Approva e crea la struttura"}
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => saveManifest()}>
                    Salva manifest
                  </button>
                  <button className="btn-ghost" disabled={generating || busy} onClick={generate}>
                    {generating ? "Generating…" : "Genera tutto in un colpo (streaming)"}
                  </button>
                </div>
                <div>
                  <label className="label">Request architecture changes</label>
                  <div className="flex gap-2">
                    <input
                      className="input flex-1"
                      value={revisionNote}
                      onChange={(e) => setRevisionNote(e.target.value)}
                      placeholder="e.g. add a REST endpoint and split the admin class"
                    />
                    <button
                      className="btn-ghost"
                      disabled={busy || revisionNote.trim().length < 3}
                      onClick={() => runArchitect({ brief: plugin.brief, revisionNote })}
                    >
                      {busy ? "Revising…" : "Re-design"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* STRUCTURE TAB */}
      {tab === "structure" &&
        (manifest ? (
          <BuildStructure
            pluginId={id}
            manifest={manifest}
            createdFiles={files.map((f) => ({ path: f.path, worstSeverity: f.worstSeverity }))}
            onChanged={async () => {
              await load();
            }}
          />
        ) : (
          <div className="card p-6 text-sm text-[var(--color-muted)]">
            Progetta prima l&apos;architettura nella scheda Architecture.
          </div>
        ))}

      {/* FILES TAB */}
      {tab === "files" && (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <ul className="card max-h-[70vh] overflow-auto p-2 text-sm">
            {files.length === 0 && <li className="p-3 text-[var(--color-muted)]">No files yet.</li>}
            {files.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => { setSelected(f.path); setEditing(false); setFileMsg(null); setChatError(null); setChatStreaming(""); setChatPendingUser(null); }}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-xs ${
                    selectedFile?.path === f.path ? "bg-[var(--color-panel-2)]" : "hover:bg-[var(--color-panel-2)]"
                  }`}
                >
                  <span className="truncate">{f.path}</span>
                  <SeverityBadge severity={f.worstSeverity} />
                </button>
              </li>
            ))}
          </ul>
          <div className="card overflow-hidden">
            {selectedFile ? (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2">
                  <span className="truncate font-mono text-xs">{selectedFile.path}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {fileMsg && <span className="text-xs text-emerald-300">{fileMsg}</span>}
                    {editing ? (
                      <>
                        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={savingFile} onClick={() => { setEditing(false); setFileMsg(null); }}>
                          Annulla
                        </button>
                        <button className="btn-primary px-2.5 py-1 text-xs" disabled={savingFile} onClick={saveFile}>
                          {savingFile ? "Salvataggio…" : "Salva"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn-ghost px-2.5 py-1 text-xs" onClick={copyFile}>
                          {copied ? "Copiato ✓" : "📋 Copia"}
                        </button>
                        <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => { setEditContent(selectedFile.content); setEditing(true); setFileMsg(null); }}>
                          ✎ Modifica
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {editing ? (
                  <textarea
                    className="block h-[64vh] w-full resize-none bg-[var(--color-bg)] p-4 font-mono text-xs leading-relaxed text-[var(--color-text)] outline-none"
                    spellCheck={false}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                  />
                ) : (
                  <pre className="max-h-[52vh] overflow-auto p-4 text-xs leading-relaxed">
                    <code>{selectedFile.content}</code>
                  </pre>
                )}

                {!editing && (
                  <div className="border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 px-3 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                      💬 Modifica con Claude Opus
                    </div>
                    {(fileChat.length > 0 || chatPendingUser || chatSending) && (
                      <div className="max-h-60 space-y-2 overflow-auto px-3 py-2">
                        {fileChat.map((m) => (
                          <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
                            <span className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-xs ${m.role === "user" ? "bg-[var(--color-accent)]/15" : "bg-[var(--color-panel-2)]"}`}>
                              {m.content}
                            </span>
                          </div>
                        ))}
                        {chatPendingUser && (
                          <div className="text-right">
                            <span className="inline-block max-w-[85%] whitespace-pre-wrap rounded-lg bg-[var(--color-accent)]/15 px-2.5 py-1.5 text-xs">
                              {chatPendingUser}
                            </span>
                          </div>
                        )}
                        {(chatStreaming || chatSending) && (
                          <div>
                            <span className="inline-block max-w-full whitespace-pre-wrap rounded-lg bg-[var(--color-panel-2)] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                              {chatStreaming || "…"}
                              <span className="animate-pulse">▌</span>
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2 p-3">
                      <input
                        className="input text-sm"
                        placeholder="es. “aggiungi un controllo nonce al form di salvataggio”"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !chatSending) sendChat(); }}
                        disabled={chatSending}
                      />
                      <button className="btn-primary px-3 text-sm" disabled={chatSending || chatInput.trim().length < 2} onClick={sendChat}>
                        {chatSending ? "…" : "Invia"}
                      </button>
                    </div>
                    {chatError && <div className="px-3 pb-2 text-xs text-red-300">{chatError}</div>}
                  </div>
                )}
              </>
            ) : (
              <div className="p-6 text-sm text-[var(--color-muted)]">Select a file.</div>
            )}
          </div>
        </div>
      )}

      {/* ISSUES TAB */}
      {tab === "issues" && (
        <div className="space-y-2">
          {findings.length === 0 ? (
            <div className="card p-6 text-sm text-[var(--color-muted)]">
              {hasFiles ? "No issues found 🎉" : "Generate the plugin to run reviews."}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2 text-sm">
                  <span className="badge sev-critical">{critical} critical</span>
                  <span className="badge sev-high">{high} high</span>
                  <span className="text-[var(--color-muted)]">· {findings.length} total</span>
                </div>
                {criticalFiles.length > 0 && (
                  <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => fixCritical(["critical", "high"])}>
                    🛠️ Risolvi errori critici ({criticalFiles.length} file)
                  </button>
                )}
              </div>
              <ul className="space-y-2">
                {findings.map((f) => (
                  <li key={f.id} className="card p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={f.severity} />
                      <span className="badge bg-[var(--color-panel-2)] text-[var(--color-muted)]">{f.category}</span>
                      <span className="font-mono text-xs text-[var(--color-muted)]">
                        {f.filePath}{f.line ? `:${f.line}` : ""}
                      </span>
                      <span className="ml-auto text-[10px] uppercase text-[var(--color-muted)]">{f.source}</span>
                    </div>
                    <p className="text-sm">{f.message}</p>
                    {f.suggestion && <p className="mt-1 text-xs text-[var(--color-muted)]">💡 {f.suggestion}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* LOG TAB */}
      {tab === "log" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card p-4">
            <h3 className="mb-2 text-sm font-semibold">Generation progress</h3>
            {progress.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">No active run. Approve an architecture to generate.</p>
            ) : (
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs leading-relaxed">{progress.join("\n")}</pre>
            )}
            {generating && <p className="mt-2 animate-pulse text-xs text-[var(--color-accent)]">running…</p>}
          </div>
          <div className="card p-4">
            <h3 className="mb-2 text-sm font-semibold">Conversation</h3>
            <ul className="max-h-[60vh] space-y-3 overflow-auto">
              {convoMessages.map((m) => (
                <li key={m.id}>
                  <div className="mb-0.5 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                    <span className="font-semibold uppercase">{m.role}</span>
                    {m.model && <span className="font-mono">{m.model}</span>}
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{m.content}</p>
                </li>
              ))}
              {convoMessages.length === 0 && <li className="text-sm text-[var(--color-muted)]">No messages yet.</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
