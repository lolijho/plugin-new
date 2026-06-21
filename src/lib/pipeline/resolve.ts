import "server-only";
import type { DbPlugin, DbUser } from "@/db/schema";
import type { ModelRole } from "@/lib/types";

export function defaultModels(): Record<ModelRole, string> {
  return {
    architect: process.env.DEFAULT_ARCHITECT_MODEL || "anthropic/claude-opus-4.1",
    coder: process.env.DEFAULT_CODER_MODEL || "anthropic/claude-sonnet-4.5",
    reviewer: process.env.DEFAULT_REVIEWER_MODEL || "anthropic/claude-opus-4.1",
  };
}

/** Precedence: plugin override → user setting → env default. */
export function resolveModel(
  role: ModelRole,
  ctx: { user: DbUser; plugin?: Pick<DbPlugin, "modelOverride"> | null },
): string {
  const pluginOverride = ctx.plugin?.modelOverride?.[role];
  if (pluginOverride) return pluginOverride;
  const userModel = ctx.user.settings?.models?.[role];
  if (userModel) return userModel;
  return defaultModels()[role];
}

export function resolveApiKey(user: DbUser): string | undefined {
  return user.settings?.openrouterApiKey || undefined;
}

export function resolveTemperature(role: ModelRole, user: DbUser): number {
  const t = user.settings?.temperature?.[role];
  if (typeof t === "number") return t;
  // Architect reasons (lower), coder is precise (low), reviewer is strict (low).
  return role === "architect" ? 0.5 : 0.2;
}

export function autofixIterations(user: DbUser): number {
  const n = user.settings?.autofixIterations;
  return typeof n === "number" && n >= 0 && n <= 5 ? n : 2;
}

/** Model used by the per-file editing chat. Defaults to Claude Opus. */
export function fileChatModel(): string {
  return process.env.FILECHAT_MODEL || "anthropic/claude-opus-4.1";
}
