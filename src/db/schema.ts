import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  vector,
  index,
  pgEnum,
  doublePrecision,
} from "drizzle-orm/pg-core";

// ── Enums ───────────────────────────────────────────────────────────────────
export const userRole = pgEnum("user_role", ["admin", "user"]);

export const pluginStatus = pgEnum("plugin_status", [
  "draft",
  "architecting",
  "awaiting_approval",
  "generating",
  "reviewing",
  "ready",
  "needs_fixes",
  "failed",
]);

export const messageRole = pgEnum("message_role", [
  "user",
  "architect",
  "coder",
  "reviewer",
  "system",
]);

export const memoryKind = pgEnum("memory_kind", [
  "lesson", // a generalized takeaway
  "error", // a concrete mistake that was made + fix
  "pattern", // a reusable code/architecture pattern
  "preference", // a user preference
  "snippet", // a reusable code snippet
]);

export const severity = pgEnum("severity", [
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
  "canceled",
]);

// ── Users ───────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("user"),
  // Per-user model config overrides + provider keys (optional).
  settings: jsonb("settings").$type<UserSettings>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserSettings = {
  models?: {
    architect?: string;
    coder?: string;
    reviewer?: string;
  };
  // Optional per-user OpenRouter key; falls back to the server env key.
  openrouterApiKey?: string;
  temperature?: { architect?: number; coder?: number; reviewer?: number };
  autofixIterations?: number;
};

// ── Plugins ─────────────────────────────────────────────────────────────────
export const plugins = pgTable(
  "plugins",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    status: pluginStatus("status").notNull().default("draft"),
    // The user's original request / brief.
    brief: text("brief").notNull().default(""),
    // The approved architecture manifest (PluginManifest JSON).
    manifest: jsonb("manifest").$type<unknown>(),
    // Per-plugin model override (else falls back to user, then env defaults).
    modelOverride: jsonb("model_override").$type<{
      architect?: string;
      coder?: string;
      reviewer?: string;
    }>(),
    version: integer("version").notNull().default(1),
    // When true the background worker skips this plugin's queued jobs.
    queuePaused: boolean("queue_paused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("plugins_user_idx").on(t.userId)],
);

// ── Generations (pipeline runs) ─────────────────────────────────────────────
export const generations = pgTable(
  "generations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    phase: text("phase").notNull().default("architecting"),
    status: text("status").notNull().default("running"), // running | done | failed
    error: text("error"),
    // Aggregated cost / token accounting.
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("generations_plugin_idx").on(t.pluginId)],
);

// ── Conversation messages (per-plugin transcript = working memory) ──────────
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    generationId: text("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    // Set for per-file chat messages (links a conversation to a single file).
    fileId: text("file_id").references(() => pluginFiles.id, { onDelete: "set null" }),
    role: messageRole("role").notNull(),
    phase: text("phase"), // architect | coder | reviewer | chat | filechat
    content: text("content").notNull(),
    model: text("model"),
    promptTokens: integer("prompt_tokens").default(0),
    completionTokens: integer("completion_tokens").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_plugin_idx").on(t.pluginId)],
);

// ── Generated plugin files ──────────────────────────────────────────────────
export const pluginFiles = pgTable(
  "plugin_files",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    generationId: text("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    path: text("path").notNull(), // relative path within the plugin zip root
    language: text("language").notNull().default("php"),
    content: text("content").notNull().default(""),
    purpose: text("purpose").notNull().default(""),
    // Worst severity found by review/validation, for quick UI badges.
    worstSeverity: severity("worst_severity"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("plugin_files_plugin_idx").on(t.pluginId)],
);

// ── Review findings (from the reviewer model) ───────────────────────────────
export const reviewFindings = pgTable(
  "review_findings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    generationId: text("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    fileId: text("file_id").references(() => pluginFiles.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull().default(""),
    severity: severity("severity").notNull().default("medium"),
    category: text("category").notNull().default("general"), // security | fatal | standards | i18n | performance | compat
    line: integer("line"),
    message: text("message").notNull(),
    suggestion: text("suggestion"),
    resolved: boolean("resolved").notNull().default(false),
    source: text("source").notNull().default("reviewer"), // reviewer | validator
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("review_findings_plugin_idx").on(t.pluginId)],
);

// ── Long-term memory (semantic) ─────────────────────────────────────────────
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Null = cross-plugin knowledge available to all of this user's plugins.
    pluginId: text("plugin_id").references(() => plugins.id, { onDelete: "set null" }),
    kind: memoryKind("kind").notNull().default("lesson"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    // Weight grows when a memory proves useful / recurs.
    importance: integer("importance").notNull().default(1),
    // Optional semantic vector. Nullable so the app works without embeddings.
    embedding: vector("embedding", { dimensions: 1536 }),
    // tsvector-like search handled at query time via to_tsvector(content).
    sourceGenerationId: text("source_generation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_user_idx").on(t.userId),
    index("memory_kind_idx").on(t.kind),
    // IVFFlat/HNSW index for cosine similarity search.
    index("memory_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ── Background job queue (server-side, survives client disconnects) ─────────
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    action: text("action").notNull().default("generate-file"), // generate-file | analyze-file | fix-file
    status: jobStatus("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    label: text("label"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_status_idx").on(t.status, t.createdAt),
    index("jobs_plugin_idx").on(t.pluginId),
  ],
);

export type DbJob = typeof jobs.$inferSelect;

export type DbUser = typeof users.$inferSelect;
export type DbPlugin = typeof plugins.$inferSelect;
export type DbGeneration = typeof generations.$inferSelect;
export type DbMessage = typeof messages.$inferSelect;
export type DbPluginFile = typeof pluginFiles.$inferSelect;
export type DbReviewFinding = typeof reviewFindings.$inferSelect;
export type DbMemoryEntry = typeof memoryEntries.$inferSelect;
