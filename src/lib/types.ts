import { z } from "zod";

export type ModelRole = "architect" | "coder" | "reviewer";

// ── Architecture manifest (structured output of the architect model) ─────────
export const fileSpecSchema = z.object({
  path: z
    .string()
    .describe("Relative path within the plugin root, e.g. 'includes/class-loader.php'"),
  language: z
    .enum(["php", "js", "css", "json", "md", "txt", "pot", "html", "yml"])
    .describe("File language / type"),
  purpose: z.string().describe("One sentence: what this file is for"),
  responsibilities: z
    .array(z.string())
    .describe("Concrete responsibilities / functions / hooks this file implements"),
});
export type FileSpec = z.infer<typeof fileSpecSchema>;

export const hookSpecSchema = z.object({
  hook: z.string().describe("Hook/filter name, e.g. 'init' or 'the_content'"),
  type: z.enum(["action", "filter"]),
  callback: z.string().describe("Callback function/method name"),
  purpose: z.string(),
});

export const dbObjectSchema = z.object({
  kind: z.enum(["table", "option", "cpt", "taxonomy", "meta", "transient"]),
  name: z.string(),
  description: z.string(),
});

export const pluginManifestSchema = z.object({
  name: z.string().describe("Human readable plugin name"),
  slug: z
    .string()
    .describe("Lowercase, hyphenated slug used as the plugin folder + text domain"),
  version: z.string().default("1.0.0"),
  description: z.string(),
  author: z.string().default(""),
  textDomain: z.string().describe("i18n text domain, usually equal to the slug"),
  requiresWp: z.string().default("6.0"),
  requiresPhp: z.string().default("7.4"),
  license: z.string().default("GPL-2.0-or-later"),
  prefix: z
    .string()
    .describe("Unique function/class prefix to avoid collisions, e.g. 'myplugin_' / 'MyPlugin_'"),
  summary: z.string().describe("Short architecture summary explaining the design"),
  files: z.array(fileSpecSchema).min(1),
  hooks: z.array(hookSpecSchema).default([]),
  database: z.array(dbObjectSchema).default([]),
  dependencies: z.array(z.string()).default([]),
  security: z
    .array(z.string())
    .describe("Security considerations explicitly addressed (nonces, caps, escaping…)")
    .default([]),
  plan: z.array(z.string()).describe("Ordered implementation steps").default([]),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// JSON Schema sent to OpenRouter (response_format). Kept in sync manually with
// the zod schema above because we want strict mode without extra deps.
export const pluginManifestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "slug",
    "version",
    "description",
    "author",
    "textDomain",
    "requiresWp",
    "requiresPhp",
    "license",
    "prefix",
    "summary",
    "files",
    "hooks",
    "database",
    "dependencies",
    "security",
    "plan",
  ],
  properties: {
    name: { type: "string" },
    slug: { type: "string" },
    version: { type: "string" },
    description: { type: "string" },
    author: { type: "string" },
    textDomain: { type: "string" },
    requiresWp: { type: "string" },
    requiresPhp: { type: "string" },
    license: { type: "string" },
    prefix: { type: "string" },
    summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "language", "purpose", "responsibilities"],
        properties: {
          path: { type: "string" },
          language: {
            type: "string",
            enum: ["php", "js", "css", "json", "md", "txt", "pot", "html", "yml"],
          },
          purpose: { type: "string" },
          responsibilities: { type: "array", items: { type: "string" } },
        },
      },
    },
    hooks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hook", "type", "callback", "purpose"],
        properties: {
          hook: { type: "string" },
          type: { type: "string", enum: ["action", "filter"] },
          callback: { type: "string" },
          purpose: { type: "string" },
        },
      },
    },
    database: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name", "description"],
        properties: {
          kind: {
            type: "string",
            enum: ["table", "option", "cpt", "taxonomy", "meta", "transient"],
          },
          name: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    dependencies: { type: "array", items: { type: "string" } },
    security: { type: "array", items: { type: "string" } },
    plan: { type: "array", items: { type: "string" } },
  },
} as const;

// ── Generated file (structured output of the coder model) ────────────────────
export const generatedFileSchema = z.object({
  path: z.string(),
  language: z.string(),
  content: z.string(),
  notes: z.string().default(""),
});
export type GeneratedFile = z.infer<typeof generatedFileSchema>;

export const generatedFileJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "language", "content", "notes"],
  properties: {
    path: { type: "string" },
    language: { type: "string" },
    content: { type: "string" },
    notes: { type: "string" },
  },
} as const;

// ── Review findings (structured output of the reviewer model) ────────────────
export const reviewFindingSchema = z.object({
  filePath: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.enum([
    "security",
    "fatal",
    "standards",
    "i18n",
    "performance",
    "compat",
    "general",
  ]),
  line: z.number().nullable().default(null),
  message: z.string(),
  suggestion: z.string().default(""),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["filePath", "severity", "category", "line", "message", "suggestion"],
        properties: {
          filePath: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
          },
          category: {
            type: "string",
            enum: [
              "security",
              "fatal",
              "standards",
              "i18n",
              "performance",
              "compat",
              "general",
            ],
          },
          line: { type: ["number", "null"] },
          message: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
} as const;

export type Severity = ReviewFinding["severity"];

export const severityRank: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

// ── Deterministic validation results ─────────────────────────────────────────
export type ValidationResult = {
  filePath: string;
  check: string;
  severity: Severity;
  passed: boolean;
  message: string;
  line?: number | null;
};
