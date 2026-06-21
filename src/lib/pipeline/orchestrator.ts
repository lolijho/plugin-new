import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
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
  reviewFindingSchema,
  reviewResultJsonSchema,
  severityRank,
  type GeneratedFile,
  type PluginManifest,
  type ReviewFinding,
  type Severity,
  type ValidationResult,
} from "@/lib/types";
import { retrieveMemory, formatMemoriesForPrompt, storeMemoryDeduped } from "@/lib/memory";
import { z } from "zod";
import { chatJson, chatStream, type ChatMessage } from "@/lib/openrouter";
import { fileChatSystemPrompt, diagnoseSystemPrompt } from "./prompts";
import { runArchitect } from "./architect";
import { runCoderForFile, runFixerForFile } from "./coder";
import { runReviewerForFile } from "./reviewer";
import { validateFiles, type FileForValidation } from "./validate";
import {
  resolveModel,
  resolveApiKey,
  resolveTemperature,
  autofixIterations,
  fileChatModel,
} from "./resolve";

type Usage = { promptTokens: number; completionTokens: number; costUsd: number };
const zeroUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
function addUsage(into: Usage, u: Usage) {
  into.promptTokens += u.promptTokens;
  into.completionTokens += u.completionTokens;
  into.costUsd += u.costUsd;
}

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

// ── Core per-file pipeline (code → review → validate → autofix) ─────────────
async function runFilePipeline(args: {
  manifest: PluginManifest;
  spec: PluginManifest["files"][number];
  written: GeneratedFile[];
  coderModel: string;
  reviewerModel: string;
  apiKey?: string;
  user: DbUser;
  maxFix: number;
  /** When provided, skip the coder and review/fix this existing content instead. */
  seed?: GeneratedFile;
  emit?: (e: RunEvent) => void;
  /** Called after each LLM call with that call's usage (for live cost). */
  onUsage?: (u: Usage) => void;
}): Promise<{ file: GeneratedFile; findings: ReviewFinding[]; validations: ValidationResult[]; usage: Usage }> {
  const usage = zeroUsage();

  let file: GeneratedFile;
  if (args.seed) {
    file = args.seed;
  } else {
    const coded = await runCoderForFile({
      model: args.coderModel,
      apiKey: args.apiKey,
      temperature: resolveTemperature("coder", args.user),
      manifest: args.manifest,
      spec: args.spec,
      written: args.written,
    });
    addUsage(usage, coded.usage);
    args.onUsage?.(coded.usage);
    file = coded.file;
    args.emit?.({ type: "file:coded", path: file.path });
  }

  let findings: ReviewFinding[] = [];
  let validations: ValidationResult[] = [];
  for (let iter = 0; iter <= args.maxFix; iter++) {
    const review = await runReviewerForFile({
      model: args.reviewerModel,
      apiKey: args.apiKey,
      temperature: resolveTemperature("reviewer", args.user),
      manifest: args.manifest,
      file,
    });
    addUsage(usage, review.usage);
    args.onUsage?.(review.usage);
    findings = review.findings;
    validations = await validateFiles([toValidation(file)], args.manifest);
    args.emit?.({ type: "file:reviewed", path: file.path, findings: findings.length, worst: worstOf(findings, validations) });

    const blocking = [
      ...findings.filter((f) => f.severity === "critical" || f.severity === "high"),
      ...validations.filter((v) => !v.passed && (v.severity === "critical" || v.severity === "high")),
    ];
    if (blocking.length === 0 || iter === args.maxFix) break;

    const fixed = await runFixerForFile({
      model: args.coderModel,
      apiKey: args.apiKey,
      temperature: resolveTemperature("coder", args.user),
      manifest: args.manifest,
      file,
      findings,
      validations,
    });
    addUsage(usage, fixed.usage);
    args.onUsage?.(fixed.usage);
    file = fixed.file;
    args.emit?.({ type: "file:fixed", path: file.path, iteration: iter + 1 });
  }

  return { file, findings, validations, usage };
}

/** Persist a freshly built file + its findings, replacing any prior version of that path. */
async function persistFile(
  pluginId: string,
  generationId: string,
  version: number,
  spec: PluginManifest["files"][number],
  file: GeneratedFile,
  findings: ReviewFinding[],
  validations: ValidationResult[],
): Promise<{ worst: Severity | null; critical: number; high: number }> {
  const worst = worstOf(findings, validations);

  await db.delete(reviewFindings).where(and(eq(reviewFindings.pluginId, pluginId), eq(reviewFindings.filePath, file.path)));
  await db.delete(pluginFiles).where(and(eq(pluginFiles.pluginId, pluginId), eq(pluginFiles.path, file.path)));

  const [saved] = await db
    .insert(pluginFiles)
    .values({
      pluginId,
      generationId,
      path: file.path,
      language: file.language,
      content: file.content,
      purpose: spec.purpose,
      worstSeverity: worst,
      version,
    })
    .returning();

  const all = [
    ...findings.map((f) => ({ ...f, source: "reviewer" as const })),
    ...validations.filter((v) => !v.passed).map((v) => ({ ...validationToFinding(v), source: "validator" as const })),
  ];
  let critical = 0;
  let high = 0;
  for (const f of all) {
    if (f.severity === "critical") critical++;
    if (f.severity === "high") high++;
    await db.insert(reviewFindings).values({
      pluginId,
      generationId,
      fileId: saved.id,
      filePath: f.filePath || file.path,
      severity: f.severity,
      category: f.category,
      line: f.line ?? null,
      message: f.message,
      suggestion: f.suggestion || null,
      source: f.source,
    });
  }
  return { worst, critical, high };
}

// ── Full run: build every file (streamed) ───────────────────────────────────
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
  const version = plugin.version + 1;

  await db.update(plugins).set({ status: "generating", version, updatedAt: new Date() }).where(eq(plugins.id, plugin.id));

  const [gen] = await db
    .insert(generations)
    .values({ pluginId: plugin.id, phase: "generating", status: "running" })
    .returning();

  const totalUsage = zeroUsage();
  const onUsage = liveCostUpdater(gen.id);

  try {
    // Full regeneration: clear previous artifacts.
    await db.delete(reviewFindings).where(eq(reviewFindings.pluginId, plugin.id));
    await db.delete(pluginFiles).where(eq(pluginFiles.pluginId, plugin.id));

    const memories = await retrieveMemory({ userId: user.id, pluginId: plugin.id, query: `${plugin.brief}\n${manifest.summary}`, limit: 8 });
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

      const { file, findings, validations, usage } = await runFilePipeline({
        manifest, spec, written, coderModel, reviewerModel, apiKey, user, maxFix, emit, onUsage,
      });
      addUsage(totalUsage, usage);

      const res = await persistFile(plugin.id, gen.id, version, spec, file, findings, validations);
      critical += res.critical;
      high += res.high;
      written.push(file);
      emit({ type: "file:done", path: file.path, worst: res.worst });
    }

    const status = critical > 0 ? "needs_fixes" : "ready";
    await db.update(plugins).set({ status, updatedAt: new Date() }).where(eq(plugins.id, plugin.id));
    await finishGeneration(gen.id, "done", totalUsage);
    await learnFromGeneration(plugin, user, gen.id, manifest);

    emit({ type: "done", status, critical, high });
  } catch (err) {
    await finishGeneration(gen.id, "failed", totalUsage, errorMessage(err));
    await db.update(plugins).set({ status: "failed", updatedAt: new Date() }).where(eq(plugins.id, plugin.id));
    emit({ type: "error", message: errorMessage(err) });
  }
}

// ── Single-file build (incremental, resumable) ──────────────────────────────
export async function generateFile(
  plugin: DbPlugin,
  user: DbUser,
  path: string,
  emit?: (e: RunEvent) => void,
): Promise<{ file: GeneratedFile; worst: Severity | null; critical: number; high: number; status: string; createdCount: number; total: number }> {
  const parsed = pluginManifestSchema.safeParse(plugin.manifest);
  if (!parsed.success) throw new Error("No approved architecture manifest found.");
  const manifest = parsed.data;

  const spec = manifest.files.find((f) => f.path === path);
  if (!spec) throw new Error(`File "${path}" is not part of the architecture.`);

  // Context = the other files already written, for cross-file consistency.
  const existing = await db
    .select({ path: pluginFiles.path, content: pluginFiles.content, language: pluginFiles.language })
    .from(pluginFiles)
    .where(eq(pluginFiles.pluginId, plugin.id));
  const written: GeneratedFile[] = existing
    .filter((f) => f.path !== path)
    .map((f) => ({ path: f.path, content: f.content, language: f.language, notes: "" }));

  const [gen] = await db
    .insert(generations)
    .values({ pluginId: plugin.id, phase: "generating", status: "running" })
    .returning();

  if (plugin.status === "awaiting_approval" || plugin.status === "draft") {
    await db.update(plugins).set({ status: "generating", updatedAt: new Date() }).where(eq(plugins.id, plugin.id));
  }

  try {
    emit?.({ type: "file:start", path, index: 1, total: 1 });
    const memories = await retrieveMemory({ userId: user.id, pluginId: plugin.id, query: `${manifest.summary}\n${spec.purpose}\n${spec.path}`, limit: 6 });

    const { file, findings, validations, usage } = await runFilePipeline({
      manifest,
      spec,
      written,
      coderModel: resolveModel("coder", { user, plugin }),
      reviewerModel: resolveModel("reviewer", { user, plugin }),
      apiKey: resolveApiKey(user),
      user,
      maxFix: autofixIterations(user),
      emit,
      onUsage: liveCostUpdater(gen.id),
    });
    void memories; // retrieval also warms importance / future semantic use

    const res = await persistFile(plugin.id, gen.id, plugin.version, spec, file, findings, validations);
    await finishGeneration(gen.id, "done", usage);
    await learnFromGeneration(plugin, user, gen.id, manifest);
    emit?.({ type: "file:done", path, worst: res.worst });

    // Regenerating an existing file is a modification → bump the version.
    if (existing.some((f) => f.path === path)) await bumpVersion(plugin.id);

    const completion = await recomputeStatus(plugin.id, manifest);
    return { file, worst: res.worst, critical: res.critical, high: res.high, ...completion };
  } catch (err) {
    await finishGeneration(gen.id, "failed", undefined, errorMessage(err));
    throw err;
  }
}

type FileActionResult = {
  worst: Severity | null;
  critical: number;
  high: number;
  status: string;
  createdCount: number;
  total: number;
};

async function loadForAction(plugin: DbPlugin, path: string) {
  const parsed = pluginManifestSchema.safeParse(plugin.manifest);
  if (!parsed.success) throw new Error("No approved architecture manifest found.");
  const manifest = parsed.data;
  const spec = manifest.files.find((f) => f.path === path);
  if (!spec) throw new Error(`File "${path}" is not part of the architecture.`);
  const [row] = await db
    .select()
    .from(pluginFiles)
    .where(and(eq(pluginFiles.pluginId, plugin.id), eq(pluginFiles.path, path)))
    .limit(1);
  if (!row) throw new Error(`File "${path}" has not been created yet — create it first.`);
  const seed: GeneratedFile = { path: row.path, content: row.content, language: row.language, notes: "" };
  return { manifest, spec, seed };
}

/** Re-review + re-validate an existing file WITHOUT changing its code. */
export async function analyzeFile(plugin: DbPlugin, user: DbUser, path: string, emit?: (e: RunEvent) => void): Promise<FileActionResult> {
  const { manifest, spec, seed } = await loadForAction(plugin, path);
  const [gen] = await db.insert(generations).values({ pluginId: plugin.id, phase: "reviewing", status: "running" }).returning();
  try {
    emit?.({ type: "file:start", path, index: 1, total: 1 });
    const { file, findings, validations, usage } = await runFilePipeline({
      manifest, spec, written: [],
      coderModel: resolveModel("coder", { user, plugin }),
      reviewerModel: resolveModel("reviewer", { user, plugin }),
      apiKey: resolveApiKey(user), user, maxFix: 0, seed, emit, onUsage: liveCostUpdater(gen.id),
    });
    const res = await persistFile(plugin.id, gen.id, plugin.version, spec, file, findings, validations);
    await finishGeneration(gen.id, "done", usage);
    emit?.({ type: "file:done", path, worst: res.worst });
    const completion = await recomputeStatus(plugin.id, manifest);
    return { worst: res.worst, critical: res.critical, high: res.high, ...completion };
  } catch (err) {
    await finishGeneration(gen.id, "failed", undefined, errorMessage(err));
    throw err;
  }
}

/** Re-review an existing file and let the coder rewrite it to clear the issues. */
export async function fixFile(plugin: DbPlugin, user: DbUser, path: string, emit?: (e: RunEvent) => void): Promise<FileActionResult> {
  const { manifest, spec, seed } = await loadForAction(plugin, path);
  // Other existing files give the fixer cross-file context.
  const others = await db
    .select({ path: pluginFiles.path, content: pluginFiles.content, language: pluginFiles.language })
    .from(pluginFiles)
    .where(eq(pluginFiles.pluginId, plugin.id));
  const written: GeneratedFile[] = others
    .filter((f) => f.path !== path)
    .map((f) => ({ path: f.path, content: f.content, language: f.language, notes: "" }));

  const [gen] = await db.insert(generations).values({ pluginId: plugin.id, phase: "generating", status: "running" }).returning();
  try {
    emit?.({ type: "file:start", path, index: 1, total: 1 });
    const { file, findings, validations, usage } = await runFilePipeline({
      manifest, spec, written,
      coderModel: resolveModel("coder", { user, plugin }),
      reviewerModel: resolveModel("reviewer", { user, plugin }),
      apiKey: resolveApiKey(user), user,
      maxFix: Math.max(1, autofixIterations(user)),
      seed, emit, onUsage: liveCostUpdater(gen.id),
    });
    const res = await persistFile(plugin.id, gen.id, plugin.version, spec, file, findings, validations);
    await finishGeneration(gen.id, "done", usage);
    await learnFromGeneration(plugin, user, gen.id, manifest);
    emit?.({ type: "file:done", path, worst: res.worst });
    await bumpVersion(plugin.id);
    const completion = await recomputeStatus(plugin.id, manifest);
    return { worst: res.worst, critical: res.critical, high: res.high, ...completion };
  } catch (err) {
    await finishGeneration(gen.id, "failed", undefined, errorMessage(err));
    throw err;
  }
}

/** Save a manually-edited file: persist content + re-run the free deterministic
 *  validators (php -l, security heuristics) and refresh the file's findings. */
export async function updateFileContent(
  plugin: DbPlugin,
  user: DbUser,
  fileId: string,
  content: string,
): Promise<{ worst: Severity | null; status: string | null }> {
  void user;
  const [row] = await db
    .select()
    .from(pluginFiles)
    .where(and(eq(pluginFiles.id, fileId), eq(pluginFiles.pluginId, plugin.id)))
    .limit(1);
  if (!row) throw new Error("File not found");

  const manifest = pluginManifestSchema.safeParse(plugin.manifest).data ?? null;
  const validations = await validateFiles([{ path: row.path, content, language: row.language }], manifest);

  // Replace only the validator-sourced findings for this file; keep reviewer ones
  // until the user re-runs "Analizza".
  await db.delete(reviewFindings).where(and(eq(reviewFindings.fileId, fileId), eq(reviewFindings.source, "validator")));
  for (const v of validations.filter((x) => !x.passed)) {
    const f = validationToFinding(v);
    await db.insert(reviewFindings).values({
      pluginId: plugin.id,
      fileId,
      filePath: row.path,
      severity: f.severity,
      category: f.category,
      line: f.line ?? null,
      message: f.message,
      source: "validator",
    });
  }

  const current = await db.select({ severity: reviewFindings.severity }).from(reviewFindings).where(eq(reviewFindings.fileId, fileId));
  const worst = maxSeverity(current.map((c) => c.severity));

  await db.update(pluginFiles).set({ content, worstSeverity: worst, updatedAt: new Date() }).where(eq(pluginFiles.id, fileId));

  await bumpVersion(plugin.id);
  const completion = manifest ? await recomputeStatus(plugin.id, manifest) : null;
  return { worst, status: completion?.status ?? null };
}

/** Edit a single file through a streamed chat with Claude Opus, then save + re-validate it. */
export async function chatEditFile(
  plugin: DbPlugin,
  user: DbUser,
  fileId: string,
  message: string,
  onDelta?: (text: string) => void,
): Promise<{ content: string; explanation: string; worst: Severity | null; status: string | null }> {
  const [row] = await db
    .select()
    .from(pluginFiles)
    .where(and(eq(pluginFiles.id, fileId), eq(pluginFiles.pluginId, plugin.id)))
    .limit(1);
  if (!row) throw new Error("File not found");
  const manifest = pluginManifestSchema.safeParse(plugin.manifest).data ?? null;

  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.fileId, fileId), eq(messages.phase, "filechat")))
    .orderBy(asc(messages.createdAt));

  const chatMessages: ChatMessage[] = [{ role: "system", content: fileChatSystemPrompt() }];
  if (manifest) {
    chatMessages.push({
      role: "system",
      content: `Plugin: ${manifest.name} (slug ${manifest.slug}, prefix ${manifest.prefix}, text domain ${manifest.textDomain}). File: ${row.path} — ${row.purpose}.`,
    });
  }
  for (const h of history.slice(-10)) {
    chatMessages.push({ role: h.role === "user" ? "user" : "assistant", content: h.content });
  }
  chatMessages.push({
    role: "user",
    content: [
      `# CURRENT FILE (${row.path})`,
      "```" + row.language,
      row.content,
      "```",
      "",
      "# INSTRUCTION",
      message,
      "",
      'Return JSON { "content": <full updated file>, "explanation": <what changed> }.',
    ].join("\n"),
  });

  const [gen] = await db.insert(generations).values({ pluginId: plugin.id, phase: "filechat", status: "running" }).returning();
  try {
    const { content: fullText, usage, model } = await chatStream(
      {
        model: fileChatModel(),
        apiKey: resolveApiKey(user),
        temperature: 0.3,
        messages: chatMessages,
        maxTokens: 16000,
      },
      onDelta ?? (() => {}),
    );
    await finishGeneration(gen.id, "done", usage);

    // Extract the last fenced code block as the new file content. If there is no
    // code block the model just answered a question → leave the file unchanged.
    const blocks = [...fullText.matchAll(/```[a-zA-Z0-9]*\s*\n([\s\S]*?)```/g)];
    const hasCode = blocks.length > 0;
    const newContent = hasCode ? blocks[blocks.length - 1][1].replace(/\n$/, "") : row.content;
    const explanation =
      (hasCode ? fullText.slice(0, blocks[0].index ?? 0) : fullText).trim().slice(0, 2000) || "(file aggiornato)";

    const saved = hasCode
      ? await updateFileContent(plugin, user, fileId, newContent)
      : { worst: (row.worstSeverity as Severity | null) ?? null, status: null };

    await db.insert(messages).values({ pluginId: plugin.id, fileId, role: "user", phase: "filechat", content: message });
    await db.insert(messages).values({
      pluginId: plugin.id,
      fileId,
      role: "coder",
      phase: "filechat",
      content: explanation,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });

    return { content: newContent, explanation, worst: saved.worst, status: saved.status };
  } catch (err) {
    await finishGeneration(gen.id, "failed", undefined, errorMessage(err));
    throw err;
  }
}

/** Analyze the WHOLE plugin (all files together, + an optional WordPress error
 *  message) with Claude Opus to find the root cause of a critical/fatal error. */
export async function diagnosePlugin(
  plugin: DbPlugin,
  user: DbUser,
  errorText?: string,
): Promise<{ summary: string; findingsCount: number; status: string | null }> {
  const manifest = pluginManifestSchema.safeParse(plugin.manifest).data ?? null;
  const fileRows = await db
    .select()
    .from(pluginFiles)
    .where(eq(pluginFiles.pluginId, plugin.id))
    .orderBy(asc(pluginFiles.path));
  if (fileRows.length === 0) throw new Error("Nessun file generato da analizzare.");

  // Deterministic whole-plugin check (e.g. main file missing) — free.
  const validations = await validateFiles(
    fileRows.map((f) => ({ path: f.path, content: f.content, language: f.language })),
    manifest,
    { wholePlugin: true },
  );

  const filesBlock = fileRows
    .map((f) => {
      const body = f.content.length > 9000 ? f.content.slice(0, 9000) + "\n/* …troncato… */" : f.content;
      const numbered = body.split("\n").map((l, i) => `${i + 1}  ${l}`).join("\n");
      return `### ${f.path}\n\`\`\`${f.language}\n${numbered}\n\`\`\``;
    })
    .join("\n\n");

  const userPrompt = [
    manifest
      ? `Plugin: ${manifest.name} (slug ${manifest.slug}, prefix ${manifest.prefix}, requires PHP ${manifest.requiresPhp}, WP ${manifest.requiresWp}).`
      : "",
    errorText ? `# ERROR REPORTED BY THE USER (from WordPress)\n${errorText.slice(0, 2500)}` : "",
    "# ALL PLUGIN FILES (with line numbers)",
    filesBlock,
    "",
    "Diagnose the root cause of the critical/fatal error. Return JSON { summary, findings }.",
  ]
    .filter(Boolean)
    .join("\n");

  const [gen] = await db.insert(generations).values({ pluginId: plugin.id, phase: "diagnose", status: "running" }).returning();
  try {
    const { data, usage } = await chatJson<unknown>({
      model: resolveModel("reviewer", { user, plugin }),
      apiKey: resolveApiKey(user),
      temperature: 0.2,
      messages: [
        { role: "system", content: diagnoseSystemPrompt() },
        { role: "user", content: userPrompt },
      ],
      jsonSchema: { name: "diagnosis", schema: reviewResultJsonSchema as unknown as Record<string, unknown> },
      maxTokens: 6000,
    });
    await finishGeneration(gen.id, "done", usage);

    const parsed = z
      .object({ summary: z.string().default(""), findings: z.array(reviewFindingSchema).default([]) })
      .parse(data);

    // Replace previous analyzer findings, then insert the new diagnosis.
    await db.delete(reviewFindings).where(and(eq(reviewFindings.pluginId, plugin.id), eq(reviewFindings.source, "analyzer")));
    for (const f of parsed.findings) {
      const fileRow = fileRows.find((r) => r.path === f.filePath);
      await db.insert(reviewFindings).values({
        pluginId: plugin.id,
        fileId: fileRow?.id ?? null,
        filePath: f.filePath || "",
        severity: f.severity,
        category: f.category,
        line: f.line ?? null,
        message: f.message,
        suggestion: f.suggestion || null,
        source: "analyzer",
      });
    }
    // Whole-plugin deterministic catch (main file missing).
    for (const v of validations.filter((x) => !x.passed && x.check === "main-file")) {
      await db.insert(reviewFindings).values({
        pluginId: plugin.id,
        filePath: v.filePath,
        severity: v.severity,
        category: "fatal",
        message: v.message,
        source: "analyzer",
      });
    }

    // Refresh each file's worst severity + the plugin status.
    for (const fr of fileRows) {
      const sevs = await db.select({ severity: reviewFindings.severity }).from(reviewFindings).where(eq(reviewFindings.fileId, fr.id));
      await db.update(pluginFiles).set({ worstSeverity: maxSeverity(sevs.map((s) => s.severity)) }).where(eq(pluginFiles.id, fr.id));
    }
    const completion = manifest ? await recomputeStatus(plugin.id, manifest) : null;

    return { summary: parsed.summary, findingsCount: parsed.findings.length, status: completion?.status ?? null };
  } catch (err) {
    await finishGeneration(gen.id, "failed", undefined, errorMessage(err));
    throw err;
  }
}

function incrementPatch(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (m) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  const m2 = v.match(/^(\d+)\.(\d+)$/);
  if (m2) return `${m2[1]}.${m2[2]}.1`;
  const n = v.match(/(\d+)\s*$/);
  if (n) return v.replace(/(\d+)\s*$/, String(Number(n[1]) + 1));
  return `${v || "1.0.0"}.1`;
}

/**
 * Bump the plugin version on every modification: increments the integer build
 * counter + the semantic patch version, and re-stamps it into the main plugin
 * file header (Version:) and readme.txt (Stable tag:) so the WordPress-visible
 * version updates too.
 */
async function bumpVersion(pluginId: string): Promise<string | null> {
  const [p] = await db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
  if (!p) return null;
  const manifest = pluginManifestSchema.safeParse(p.manifest).data ?? null;
  const nextSemver = incrementPatch(manifest?.version || "1.0.0");

  if (manifest) {
    manifest.version = nextSemver;
    await db.update(plugins).set({ manifest, version: p.version + 1, updatedAt: new Date() }).where(eq(plugins.id, pluginId));
  } else {
    await db.update(plugins).set({ version: p.version + 1, updatedAt: new Date() }).where(eq(plugins.id, pluginId));
  }

  // Re-stamp the version into the main file header + readme stable tag.
  const [mainFile] = await db
    .select()
    .from(pluginFiles)
    .where(and(eq(pluginFiles.pluginId, pluginId), eq(pluginFiles.path, `${p.slug}.php`)))
    .limit(1);
  if (mainFile) {
    const updated = mainFile.content.replace(/^(\s*\*?\s*Version:\s*).*$/im, `$1${nextSemver}`);
    if (updated !== mainFile.content) await db.update(pluginFiles).set({ content: updated }).where(eq(pluginFiles.id, mainFile.id));
  }
  const [readme] = await db
    .select()
    .from(pluginFiles)
    .where(and(eq(pluginFiles.pluginId, pluginId), eq(pluginFiles.path, "readme.txt")))
    .limit(1);
  if (readme) {
    const updated = readme.content.replace(/^(Stable tag:\s*).*$/im, `$1${nextSemver}`);
    if (updated !== readme.content) await db.update(pluginFiles).set({ content: updated }).where(eq(pluginFiles.id, readme.id));
  }
  return nextSemver;
}

/** Recompute plugin status from how many manifest files now exist + their severity. */
async function recomputeStatus(
  pluginId: string,
  manifest: PluginManifest,
): Promise<{ status: string; createdCount: number; total: number }> {
  const created = await db.select({ path: pluginFiles.path }).from(pluginFiles).where(eq(pluginFiles.pluginId, pluginId));
  const createdSet = new Set(created.map((c) => c.path));
  const total = manifest.files.length;
  const allDone = manifest.files.every((f) => createdSet.has(f.path));

  let status: "ready" | "needs_fixes" | "generating";
  if (allDone) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(reviewFindings)
      .where(and(eq(reviewFindings.pluginId, pluginId), eq(reviewFindings.severity, "critical")));
    status = n > 0 ? "needs_fixes" : "ready";
  } else {
    status = "generating";
  }
  await db.update(plugins).set({ status, updatedAt: new Date() }).where(eq(plugins.id, pluginId));
  return { status, createdCount: createdSet.size, total };
}

// ── Learning ────────────────────────────────────────────────────────────────
async function learnFromGeneration(plugin: DbPlugin, user: DbUser, generationId: string, manifest: PluginManifest) {
  const rows = await db.select().from(reviewFindings).where(eq(reviewFindings.generationId, generationId));
  const serious = rows.filter((r) => r.severity === "critical" || r.severity === "high").slice(0, 12);
  for (const r of serious) {
    await storeMemoryDeduped({
      userId: user.id,
      pluginId: null,
      kind: "error",
      title: `${r.category}: ${r.message}`.slice(0, 200),
      content: `In "${manifest.name}" (${r.filePath}) the issue was: ${r.message}. Fix: ${r.suggestion ?? "apply the WP standard for this category"}. Avoid repeating this.`,
      tags: [r.category, r.severity, manifest.slug],
      importance: r.severity === "critical" ? 3 : 2,
      sourceGenerationId: generationId,
    });
  }
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
  await db.insert(messages).values({ pluginId, generationId, role, phase, content, model: model ?? null, promptTokens, completionTokens });
}

async function finishGeneration(id: string, status: "done" | "failed", usage?: Usage, error?: string) {
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

/**
 * Returns an onUsage callback that live-updates a generation's running cost
 * after each LLM call, so the per-plugin spend counter ticks up in real time.
 */
function liveCostUpdater(generationId: string): (u: Usage) => void {
  let cost = 0;
  return (u: Usage) => {
    cost += u.costUsd;
    db.update(generations).set({ costUsd: cost }).where(eq(generations.id, generationId)).catch(() => {});
  };
}

// ── Small utils ─────────────────────────────────────────────────────────────
function toValidation(file: GeneratedFile): FileForValidation {
  return { path: file.path, content: file.content, language: file.language };
}

function validationToFinding(v: ValidationResult): ReviewFinding {
  return {
    filePath: v.filePath,
    severity: v.severity,
    category:
      v.check.includes("sql") || v.check.includes("escape") || v.check.includes("input") || v.check.includes("dangerous")
        ? "security"
        : v.check.includes("lint") || v.check.includes("main") || v.check.includes("header")
          ? "fatal"
          : "standards",
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

function maxSeverity(severities: Severity[]): Severity | null {
  let worst: Severity | null = null;
  for (const s of severities) if (worst === null || severityRank[s] > severityRank[worst]) worst = s;
  return worst;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
