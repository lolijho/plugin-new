import "server-only";
import { chatJson, type Usage } from "@/lib/openrouter";
import {
  reviewResultJsonSchema,
  reviewFindingSchema,
  type GeneratedFile,
  type PluginManifest,
  type ReviewFinding,
} from "@/lib/types";
import { reviewerSystemPrompt } from "./prompts";
import { z } from "zod";

const reviewResponseSchema = z.object({
  summary: z.string().default(""),
  findings: z.array(reviewFindingSchema).default([]),
});

export async function runReviewerForFile(input: {
  model: string;
  apiKey?: string;
  temperature?: number;
  manifest: PluginManifest;
  file: GeneratedFile;
}): Promise<{ summary: string; findings: ReviewFinding[]; usage: Usage; model: string }> {
  const user = [
    `# PLUGIN: ${input.manifest.name} (slug ${input.manifest.slug}, text domain ${input.manifest.textDomain}, prefix ${input.manifest.prefix})`,
    `Requires PHP ${input.manifest.requiresPhp}, WP ${input.manifest.requiresWp}.`,
    "Expected files: " + input.manifest.files.map((f) => f.path).join(", "),
    "",
    `# FILE UNDER REVIEW: ${input.file.path}`,
    "```" + input.file.language,
    addLineNumbers(input.file.content),
    "```",
    "",
    "Review this file. Return JSON with summary + findings (empty array if clean).",
  ].join("\n");

  const { data, usage, model } = await chatJson<unknown>({
    model: input.model,
    apiKey: input.apiKey,
    temperature: input.temperature,
    messages: [
      { role: "system", content: reviewerSystemPrompt() },
      { role: "user", content: user },
    ],
    jsonSchema: { name: "review_result", schema: reviewResultJsonSchema as unknown as Record<string, unknown> },
    maxTokens: 6000,
  });

  const parsed = reviewResponseSchema.parse(data);
  // Force the correct file path on every finding.
  const findings = parsed.findings.map((f) => ({ ...f, filePath: input.file.path }));
  return { summary: parsed.summary, findings, usage, model };
}

function addLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4, " ")}  ${l}`)
    .join("\n");
}
