import type { RunEvent } from "./orchestrator";

/** Maps a pipeline event to a coarse percentage + human label for progress UI. */
export const PHASE: Partial<Record<RunEvent["type"], { percent: number; label: string }>> = {
  "file:start": { percent: 8, label: "Preparazione…" },
  "file:coded": { percent: 55, label: "Codice scritto · revisione…" },
  "file:reviewed": { percent: 80, label: "Revisione…" },
  "file:fixed": { percent: 90, label: "Correzione · riverifica…" },
  "file:done": { percent: 98, label: "Salvataggio…" },
};
