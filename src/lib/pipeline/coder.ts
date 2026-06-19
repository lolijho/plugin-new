import "server-only";
import { chatJson, type Usage } from "@/lib/openrouter";
import {
  generatedFileSchema,
  generatedFileJsonSchema,
  type FileSpec,
  type GeneratedFile,
  type PluginManifest,
  type ReviewFinding,
  type ValidationResult,
} from "@/lib/types";
import { coderSystemPrompt, fixerSystemPrompt } from "./prompts";

function manifestContext(manifest: PluginManifest): string {
  return [
    `Plugin: ${manifest.name} (slug: ${manifest.slug})`,
    `Text domain: ${manifest.textDomain} | Prefix: ${manifest.prefix}`,
    `Version: ${manifest.version} | Requires WP ${manifest.requiresWp}, PHP ${manifest.requiresPhp}`,
    `License: ${manifest.license}`,
    "",
    "Architecture summary:",
    manifest.summary,
    "",
    "All files in this plugin:",
    ...manifest.files.map((f) => `  - ${f.path} — ${f.purpose}`),
    "",
    manifest.database.length
      ? `Data model: ${manifest.database.map((d) => `${d.kind}:${d.name}`).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function siblingContext(written: GeneratedFile[]): string {
  if (written.length === 0) return "(no files written yet)";
  // Keep the prompt bounded: full content for small files, signatures for large.
  return written
    .map((f) => {
      const body =
        f.content.length > 4000
          ? f.content.slice(0, 1500) + "\n/* …truncated… */\n" + f.content.slice(-800)
          : f.content;
      return `### ${f.path}\n\`\`\`${f.language}\n${body}\n\`\`\``;
    })
    .join("\n\n");
}

export async function runCoderForFile(input: {
  model: string;
  apiKey?: string;
  temperature?: number;
  manifest: PluginManifest;
  spec: FileSpec;
  written: GeneratedFile[];
}): Promise<{ file: GeneratedFile; usage: Usage; model: string }> {
  const user = [
    "# MANIFEST CONTEXT",
    manifestContext(input.manifest),
    "",
    "# ALREADY-WRITTEN FILES (for consistency — reuse their classes/functions/paths)",
    siblingContext(input.written),
    "",
    "# FILE TO WRITE NOW",
    `Path: ${input.spec.path}`,
    `Language: ${input.spec.language}`,
    `Purpose: ${input.spec.purpose}`,
    "Responsibilities:",
    ...input.spec.responsibilities.map((r) => `  - ${r}`),
    "",
    "Write the complete, final contents of this one file. Return ONLY the JSON object.",
  ].join("\n");

  const { data, usage, model } = await chatJson<unknown>({
    model: input.model,
    apiKey: input.apiKey,
    temperature: input.temperature,
    messages: [
      { role: "system", content: coderSystemPrompt() },
      { role: "user", content: user },
    ],
    jsonSchema: { name: "generated_file", schema: generatedFileJsonSchema as unknown as Record<string, unknown> },
    maxTokens: 16000,
  });

  const parsed = generatedFileSchema.parse(data);
  // Trust the manifest path over whatever the model echoed back.
  parsed.path = input.spec.path;
  parsed.language = input.spec.language;
  return { file: stripFences(parsed), usage, model };
}

export async function runFixerForFile(input: {
  model: string;
  apiKey?: string;
  temperature?: number;
  manifest: PluginManifest;
  file: GeneratedFile;
  findings: ReviewFinding[];
  validations: ValidationResult[];
}): Promise<{ file: GeneratedFile; usage: Usage; model: string }> {
  const issues = [
    ...input.findings.map((f) => `- [${f.severity}/${f.category}] ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ""}`),
    ...input.validations
      .filter((v) => !v.passed)
      .map((v) => `- [${v.severity}/${v.check}] ${v.message}`),
  ].join("\n");

  const user = [
    "# MANIFEST CONTEXT",
    manifestContext(input.manifest),
    "",
    "# CURRENT FILE",
    `Path: ${input.file.path}`,
    "```" + input.file.language,
    input.file.content,
    "```",
    "",
    "# ISSUES TO FIX",
    issues,
    "",
    "Return the corrected file as JSON (path, language, content, notes).",
  ].join("\n");

  const { data, usage, model } = await chatJson<unknown>({
    model: input.model,
    apiKey: input.apiKey,
    temperature: input.temperature,
    messages: [
      { role: "system", content: fixerSystemPrompt() },
      { role: "user", content: user },
    ],
    jsonSchema: { name: "generated_file", schema: generatedFileJsonSchema as unknown as Record<string, unknown> },
    maxTokens: 16000,
  });

  const parsed = generatedFileSchema.parse(data);
  parsed.path = input.file.path;
  parsed.language = input.file.language;
  return { file: stripFences(parsed), usage, model };
}

/** Some models wrap file content in markdown fences despite instructions. */
function stripFences(file: GeneratedFile): GeneratedFile {
  const m = file.content.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (m) file.content = m[1];
  return file;
}
