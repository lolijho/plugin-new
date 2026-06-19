import "server-only";
import { chatJson, type Usage } from "@/lib/openrouter";
import { pluginManifestSchema, pluginManifestJsonSchema, type PluginManifest } from "@/lib/types";
import { architectSystemPrompt } from "./prompts";

export type ArchitectInput = {
  model: string;
  apiKey?: string;
  temperature?: number;
  brief: string;
  memoryBlock?: string;
  /** Free-text feedback when the user asked for changes to a prior manifest. */
  revisionNote?: string;
  previousManifest?: PluginManifest | null;
};

export type ArchitectOutput = {
  manifest: PluginManifest;
  usage: Usage;
  model: string;
};

export async function runArchitect(input: ArchitectInput): Promise<ArchitectOutput> {
  const userParts = [
    "# PLUGIN BRIEF",
    input.brief.trim(),
  ];

  if (input.memoryBlock) {
    userParts.push("", input.memoryBlock);
  }

  if (input.previousManifest && input.revisionNote) {
    userParts.push(
      "",
      "# PREVIOUS ARCHITECTURE (revise it according to the feedback below)",
      "```json",
      JSON.stringify(input.previousManifest, null, 2),
      "```",
      "",
      "# REQUESTED CHANGES",
      input.revisionNote.trim(),
    );
  }

  userParts.push(
    "",
    "Design the plugin now. Return ONLY the JSON manifest matching the schema.",
  );

  const { data, usage, model } = await chatJson<unknown>({
    model: input.model,
    apiKey: input.apiKey,
    temperature: input.temperature,
    messages: [
      { role: "system", content: architectSystemPrompt() },
      { role: "user", content: userParts.join("\n") },
    ],
    jsonSchema: { name: "plugin_manifest", schema: pluginManifestJsonSchema as unknown as Record<string, unknown> },
    maxTokens: 8000,
  });

  // Validate + coerce with zod so downstream code can trust the shape.
  const manifest = pluginManifestSchema.parse(data);
  manifest.slug = slugify(manifest.slug || manifest.name);
  if (!manifest.textDomain) manifest.textDomain = manifest.slug;
  return { manifest, usage, model };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "my-plugin";
}
