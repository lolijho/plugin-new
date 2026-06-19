export default function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  if (!severity) return null;
  return <span className={`badge sev-${severity}`}>{severity}</span>;
}
