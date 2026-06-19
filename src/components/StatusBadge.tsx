const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-slate-500/15 text-slate-300" },
  architecting: { label: "Architecting…", cls: "bg-violet-500/15 text-violet-300" },
  awaiting_approval: { label: "Awaiting approval", cls: "bg-amber-500/15 text-amber-300" },
  generating: { label: "Generating…", cls: "bg-blue-500/15 text-blue-300" },
  reviewing: { label: "Reviewing…", cls: "bg-blue-500/15 text-blue-300" },
  ready: { label: "Ready", cls: "bg-emerald-500/15 text-emerald-300" },
  needs_fixes: { label: "Needs fixes", cls: "bg-red-500/15 text-red-300" },
  failed: { label: "Failed", cls: "bg-red-500/15 text-red-300" },
};

export default function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "bg-slate-500/15 text-slate-300" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}
