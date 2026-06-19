"use client";

import { useState } from "react";
import type { PluginManifest, FileSpec } from "@/lib/types";

const LANGS = ["php", "js", "css", "json", "md", "txt", "pot", "html", "yml"] as const;

export default function ManifestEditor({
  value,
  onChange,
}: {
  value: PluginManifest;
  onChange: (m: PluginManifest) => void;
}) {
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);

  function set<K extends keyof PluginManifest>(key: K, v: PluginManifest[K]) {
    onChange({ ...value, [key]: v });
  }

  function setFile(i: number, patch: Partial<FileSpec>) {
    const files = value.files.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    set("files", files);
  }
  function addFile() {
    set("files", [...value.files, { path: "", language: "php", purpose: "", responsibilities: [] }]);
  }
  function removeFile(i: number) {
    set("files", value.files.filter((_, idx) => idx !== i));
  }

  if (raw) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Raw manifest (JSON)</span>
          <button
            className="btn-ghost text-xs"
            onClick={() => {
              try {
                onChange(JSON.parse(rawText));
                setRawError(null);
                setRaw(false);
              } catch {
                setRawError("Invalid JSON");
              }
            }}
          >
            Apply JSON
          </button>
        </div>
        {rawError && <div className="text-sm text-red-300">{rawError}</div>}
        <textarea
          className="input min-h-[400px] font-mono text-xs"
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <button
          className="btn-ghost text-xs"
          onClick={() => {
            setRawText(JSON.stringify(value, null, 2));
            setRaw(true);
          }}
        >
          Edit raw JSON
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={value.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Slug"><input className="input font-mono" value={value.slug} onChange={(e) => set("slug", e.target.value)} /></Field>
        <Field label="Version"><input className="input" value={value.version} onChange={(e) => set("version", e.target.value)} /></Field>
        <Field label="Prefix"><input className="input font-mono" value={value.prefix} onChange={(e) => set("prefix", e.target.value)} /></Field>
        <Field label="Text domain"><input className="input font-mono" value={value.textDomain} onChange={(e) => set("textDomain", e.target.value)} /></Field>
        <Field label="Author"><input className="input" value={value.author} onChange={(e) => set("author", e.target.value)} /></Field>
        <Field label="Requires WP"><input className="input" value={value.requiresWp} onChange={(e) => set("requiresWp", e.target.value)} /></Field>
        <Field label="Requires PHP"><input className="input" value={value.requiresPhp} onChange={(e) => set("requiresPhp", e.target.value)} /></Field>
      </div>

      <Field label="Description">
        <textarea className="input min-h-[60px]" value={value.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <Field label="Architecture summary">
        <textarea className="input min-h-[80px]" value={value.summary} onChange={(e) => set("summary", e.target.value)} />
      </Field>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label mb-0">Files ({value.files.length})</span>
          <button className="btn-ghost text-xs" onClick={addFile}>+ Add file</button>
        </div>
        <ul className="space-y-2">
          {value.files.map((f, i) => (
            <li key={i} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
              <div className="flex gap-2">
                <input
                  className="input font-mono flex-1"
                  value={f.path}
                  placeholder="includes/class-thing.php"
                  onChange={(e) => setFile(i, { path: e.target.value })}
                />
                <select
                  className="input w-24"
                  value={f.language}
                  onChange={(e) => setFile(i, { language: e.target.value as FileSpec["language"] })}
                >
                  {LANGS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <button className="btn-danger px-2 text-xs" onClick={() => removeFile(i)}>✕</button>
              </div>
              <input
                className="input mt-2 text-sm"
                value={f.purpose}
                placeholder="Purpose of this file"
                onChange={(e) => setFile(i, { purpose: e.target.value })}
              />
              <textarea
                className="input mt-2 text-xs"
                value={f.responsibilities.join("\n")}
                placeholder="One responsibility per line"
                onChange={(e) => setFile(i, { responsibilities: e.target.value.split("\n").filter(Boolean) })}
              />
            </li>
          ))}
        </ul>
      </div>

      {(value.hooks.length > 0 || value.database.length > 0 || value.security.length > 0) && (
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <Summary title="Hooks" items={value.hooks.map((h) => `${h.type}: ${h.hook}`)} />
          <Summary title="Data model" items={value.database.map((d) => `${d.kind}: ${d.name}`)} />
          <Summary title="Security" items={value.security} />
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function Summary({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <div className="mb-1 text-xs font-semibold uppercase text-[var(--color-muted)]">{title}</div>
      <ul className="space-y-1 text-xs text-[var(--color-muted)]">
        {items.map((it, i) => (
          <li key={i}>• {it}</li>
        ))}
      </ul>
    </div>
  );
}
