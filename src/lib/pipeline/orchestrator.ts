import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  plugins,
  generations,
  messages,
  pluginFiles,
  reviewFindings,
  type DbPlugin,
  type DbUser,
} from "@/db/schema";
import {
  pluginManifestSchema,
  severityRank,
  type GeneratedFile,
  type PluginManifest,
  type ReviewFinding,
  type Severity,
  type ValidationResult,
} from "@/lib/types";
import { retrieveMemory, formatMemoriesForPrompt, storeMemoryDeduped } from "@/lib/memory";
import { runArchitect } from "./architect";
import { runCoderForFile, runFixerForFile } from "./coder";
import { runReviewerForFile } from "./reviewer";
import { validateFiles, type FileForValidation } from "./validate";
import {
  resolveModel,
  resolveApiKey,
  resolveTemperature,
  autofixIterations,
} from "./resolve";

// ── Architecture step (interactive checkpoint) ──────────────────────────────
export async function architectPlugin(
  plugin: DbPlugin,
  user: DbUser,
  opts: { brief: string; revisionNote?: string },
): Promise<{ manifest: PluginManifest; generationId: string }> {
  await db.update(plugins).set({ status: "architecting", brief: opts.brief, updatedAt: new Date() }).where(eq(plugins.id, plugin.id));

  const [gen] = await db
    .insert(generations)
    .values({ pluginId: plugin.id, phase: "architecting", status: "running" })
    .returning();

  try {
    const memories = await retrieveMemory({
      userId: user.id,
      pluginId: plugin.id,
      query: opts.brief,
      limit: 6,
    });

    await logMessage(plugin.id, gen.id, "user", "chat", opts.brief);

    const prev = opts.revisionNote && plugin.manifest
      ? pluginManifestSchema.safeParse(plugin.manifest).data ?? null
      : null;

    const { manifest, usage, model } = await runArchitect({
      model: resolveModel("architect", { user, plugin }),
      apiKey: resolveApiKey(user),
      temperature: resolveTemperature("architect", user),
      brief: opts.brief,
      memoryBlock: formatMemoriesForPrompt(memories),
      revisionNote: opts.revisionNote,
      previousManifest: prev,
    });

    await logMessage(
      plugin.id,
      gen.id,
      "architect",
      "architect",
      `Designed "${manifest.name}" — ${manifest.files.length} files.\n\n${manifest.summary}`,
      model,
      usage.promptTokens,
      usage.completionTokens,
    );

    await db
      .update(plugins)
      .set({ status: "awaiting_approval", manifest, name: manifest.name, slug: manifest.slug, description: manifest.description, updatedAt: new Date() })
      .where(eq(plugins.id, plugin.id));

    await finishGeneration(gen.id, "done", usage);
    return { manifest, generationId: gen.id };
  } catch (err) {
    await finishGeneration(gen.id, "failed", undefined, errorMessage(err));
    await db.update(plugins).set({ status: "failed", updatedAt: new Date() }).where(eq(plugins.id, plugin.id));
    throw err;
  }
}

// ── Generation run (code → review → validate → autofix) ─────────────────────
export type RunEvent =
  | { type: "phase"; phase: string; message: string }
  | { type: "file:start"; path: string; index: number; total: number }
  | { type: "file:coded"; path: string }
  | { type: "file:reviewed"; path: string; findings: number; worst: Severity | null }
  | { type: "file:fixed"; path: string; iteration: number }
  | { type: "file:done"; path: string; worst: Severity | null }
  | { type: "log"; message: string }
  | { type: "done"; status: "ready" | "needs_fixes"; critical: number; high: number }
  | { type: "error"; message: string };

export async function generatePlugin(
  plugin: DbPlugin,
  user: DbUser,
  emit: (e: RunEvent) => void,
): Promise<void> {
  const parsed = pluginManifestSchema.safeParse(plugin.manifest);
  if (!parsed.success) {
    emit({ type: "error", message: "No approved architecture manifest found. Run the architect first." });
    return;
  }
  const manifest = parsed.data;

  await db.update(plugins).set({ status: "generating", version: plugin.version + 1, updatedAt: new Date() }).where(eq(plugins.id, plugin.id));
  const version = plugin.version + 1;

  const [gen] = await db
    .insert(generations)
    .values({ pluginId: plugin.id, phase: "generating", status: "running" })
    .returning();

  const totalUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
  const addUsage = (u: { promptTokens: number; completionTokens: number; costUsd: number }) => {
    totalUsage.promptTokens += u.promptTokens;
    totalUsage.completionTokens += u.completionTokens;
    totalUsage.costUsd += u.costUsd;
  };

  try {
    // Clear previous artifacts for this plugin (full regeneration).
    await db.delete(reviewFindings).where(eq(reviewFindings.pluginId, plugin.id));
    await db.delete(pluginFiles).where(eq(pluginFiles.pluginId, plugin.id));

    // Retrieve memory once for the whole run.
    const memories = await retrieveMemory({
      userId: user.id,
      pluginId: plugin.id,
      query: `${plugin.brief}\n${manifest.summary}`,
      limit: 8,
    });
    const memoryBlock = formatMemoriesForPrompt(memories);
    if (memories.length) emit({ type: "log", message: `Recalled ${memories.length} relevant memories.` });

    const coderModel = resolveModel("coder", { user, plugin });
    const reviewerModel = resolveModel("reviewer", { user, plugin });
    const apiKey = resolveApiKey(user);
    const maxFix = autofixIterations(user);

    const written: GeneratedFile[] = [];
    let critical = 0;
    let high = 0;

    for (let i = 0; i < manifest.files.length; i++) {
      const spec = manifest.files[i];
      emit({ type: "file:start", path: spec.path, index: i + 1, total: manifest.files.length });

      // 1) Code the file.
      const coded = await runCoderForFile({
        model: coderModel,
        apiKey,
        temperature: resolveTemperature("coder", user),
        manifest,
        spec,
        written,
      });
      addUsage(coded.usage);
      let file = coded.file;
      emit({ type: "file:coded", path: file.path });

      // 2) Review + validate, with an autofix loop for critical/high issues.
      let findings: ReviewFinding[] = [];
      let validations: ValidationResult[] = [];
      for (let iter = 0; iter <= maxFix; iter++) {
        const review = await runReviewerForFile({
          model: reviewerModel,
          apiKey,
          temperature: resolveTemperature("reviewer", user),
          manifest,
          file,
        });
        addUsage(review.usage);
        findings = review.findings;
        validations = await validateFiles([toValidation(file)], manifest);
        emit({
          type: "file:reviewed",
          path: file.path,
          findings: findings.length,
          worst: worstOf(findings, validations),
        });

        const blocking = [
          ...findings.filter((f) => f.severity === "critical" || f.severity === "high"),
          ...validations.filter((v) => !v.passed && (v.severity === "critical" || v.severity === "high")).map(validationToFinding),
        ];
        if (blocking.length === 0 || iter === maxFix) break;

        const fixed = await runFixerForFile({
          model: coderModel,
          apiKey,
          temperature: resolveTemperature("coder", user),
          manifest,
          file,
          findings,
          validations,
        });
        addUsage(fixed.usage);
        file = fixed.file;
        emit({ type: "file:fixed", path: file.path, iteration: iter + 1 });
      }

      // 3) Persist the file + findings.
      const worst = worstOf(findings, validations);
      const [savedFile] = await db
        .insert(pluginFiles)
        .values({
          pluginId: plugin.id,
          generationId: gen.id,
          path: file.path,
          language: file.language,
          content: file.content,
          purpose: spec.purpose,
          worstSeverity: worst,
          version,
        })
        .returning();

      const allFindings = [
        ...findings.map((f) => ({ ...f, source: "reviewer" as const })),
        ...validations.filter((v) => !v.passed).map((v) => ({ ...validationToFinding(v), source: "validator" as const })),
      ];
      for (const f of allFindings) {
        if (f.severity === "critical") critical++;
        if (f.severity === "high") high++;
        await db.insert(reviewFindings).values({
          pluginId: plugin.id,
          generationId: gen.id,
          fileId: savedFile.id,
          filePath: f.filePath || file.path,
          severity: f.severity,
          category: f.category,
          line: f.line ?? null,
          message: f.message,
          suggestion: f.suggestion || null,
          source: f.source,
        });
      }

      written.push(file);
      emit({ type: "file:done", path: file.path, worst });
    }

    const status = critical > 0 ? "needs_fixes" : "ready";
    await db.update(plugins).set({ status, updatedAt: new Date() }).where(eq(plugins.id, plugin.id));
    await finishGeneration(gen.id, "done", totalUsage);

    // 4) Learn: persist lessons from what went wrong (and the overall shape).
    await learnFromRun(plugin, user, gen.id, manifest, written.length, critical, high);

    emit({ type: "done", status, critical, high });
  } catch (err) {
    await finishGeneration(gen.id, "failed", totalUsage, errorMessage(err));
    await db.update(plugins).set({ status: "failed", updatedAt: new Date() }).where(eq(plugins.id, plugin.id));
    emit({ type: "error", message: errorMessage(err) });
  }
}

// ── Learning ────────────────────────────────────────────────────────────────
async function learnFromRun(
  plugin: DbPlugin,
  user: DbUser,
  generationId: string,
  manifest: PluginManifest,
  fileCount: number,
  critical: number,
  high: number,
) {
  // Record concrete mistakes (critical/high) so future plugins avoid them.
  const rows = await db
    .select()
    .from(reviewFindings)
    .where(and(eq(reviewFindings.generationId, generationId)));
  const serious = rows.filter((r) => r.severity === "critical" || r.severity === "high").slice(0, 12);
  for (const r of serious) {
    await storeMemoryDeduped({
      userId: user.id,
      pluginId: null, // cross-plugin: applies to all future work
      kind: "error",
      title: `${r.category}: ${r.message}`.slice(0, 200),
      content: `In "${manifest.name}" (${r.filePath}) the issue was: ${r.message}. Fix: ${r.suggestion ?? "apply the WP standard for this category"}. Avoid repeating this.`,
      tags: [r.category, r.severity, manifest.slug],
      importance: r.severity === "critical" ? 3 : 2,
      sourceGenerationId: generationId,
    });
  }

  // Record the architecture as a reusable pattern.
  await storeMemoryDeduped({
    userId: user.id,
    pluginId: plugin.id,
    kind: "pattern",
    title: `Architecture for "${manifest.name}"`,
    content: `${manifest.summary} Files: ${manifest.files.map((f) => f.path).join(", ")}. ${manifest.database.length ? "Data: " + manifest.database.map((d) => `${d.kind}:${d.name}`).join(", ") + "." : ""} Generated ${fileCount} files with ${critical} critical / ${high} high issues remaining.`,
    tags: ["architecture", manifest.slug],
    importance: 1,
    sourceGenerationId: generationId,
  });
}

// ── DB helpers ──────────────────────────────────────────────────────────────
async function logMessage(
  pluginId: string,
  generationId: string,
  role: "user" | "architect" | "coder" | "reviewer" | "system",
  phase: string,
  content: string,
  model?: string,
  promptTokens = 0,
  completionTokens = 0,
) {
  await db.insert(messages).values({
    pluginId,
    generationId,
    role,
    phase,
    content,
    model: model ?? null,
    promptTokens,
    completionTokens,
  });
}

async function finishGeneration(
  id: string,
  status: "done" | "failed",
  usage?: { promptTokens: number; completionTokens: number; costUsd: number },
  error?: string,
) {
  await db
    .update(generations)
    .set({
      status,
      error: error ?? null,
      finishedAt: new Date(),
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      costUsd: usage?.costUsd ?? 0,
    })
    .where(eq(generations.id, id));
}

// ── Small utils ─────────────────────────────────────────────────────────────
function toValidation(file: GeneratedFile): FileForValidation {
  return { path: file.path, content: file.content, language: file.language };
}

function validationToFinding(v: ValidationResult): ReviewFinding {
  return {
    filePath: v.filePath,
    severity: v.severity,
    category: v.check.includes("sql") || v.check.includes("escape") || v.check.includes("input") || v.check.includes("dangerous") ? "security" : v.check.includes("lint") || v.check.includes("main") || v.check.includes("header") ? "fatal" : "standards",
    line: v.line ?? null,
    message: v.message,
    suggestion: "",
  };
}

function worstOf(findings: ReviewFinding[], validations: ValidationResult[]): Severity | null {
  let worst: Severity | null = null;
  const consider = (s: Severity) => {
    if (worst === null || severityRank[s] > severityRank[worst]) worst = s;
  };
  for (const f of findings) consider(f.severity);
  for (const v of validations) if (!v.passed) consider(v.severity);
  return worst;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
