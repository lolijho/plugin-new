import "server-only";
import JSZip from "jszip";

export type ZipFile = { path: string; content: string };

/**
 * Build a downloadable plugin zip. Files are nested under a top-level folder
 * named after the slug, which is how WordPress expects a plugin archive
 * (unzipping yields wp-content/plugins/<slug>/...).
 */
export async function buildPluginZip(slug: string, files: ZipFile[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const root = zip.folder(slug)!;
  for (const f of files) {
    // Normalize any accidental leading slash or duplicated slug prefix.
    const clean = f.path.replace(/^\/+/, "").replace(new RegExp(`^${slug}/`), "");
    root.file(clean, f.content);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
