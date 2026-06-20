import "server-only";
import { execFile } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginManifest, ValidationResult } from "@/lib/types";

const execFileAsync = promisify(execFile);

let phpAvailable: boolean | null = null;

async function hasPhp(): Promise<boolean> {
  if (phpAvailable !== null) return phpAvailable;
  try {
    await execFileAsync("php", ["--version"], { timeout: 5000 });
    phpAvailable = true;
  } catch {
    phpAvailable = false;
  }
  return phpAvailable;
}

export type FileForValidation = {
  path: string;
  content: string;
  language: string;
};

/**
 * Deterministic, non-LLM checks that catch the most common causes of a broken
 * or insecure plugin. These run on every generation regardless of the reviewer
 * model, and "critical" results gate the plugin from being marked ready.
 */
export async function validateFiles(
  files: FileForValidation[],
  manifest: PluginManifest | null,
  opts?: { wholePlugin?: boolean },
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const phpFiles = files.filter((f) => f.path.endsWith(".php"));

  // ── PHP syntax (php -l) — the #1 defense against the white screen of death ──
  if (phpFiles.length > 0) {
    if (await hasPhp()) {
      const dir = await mkdtemp(join(tmpdir(), "wpforge-lint-"));
      try {
        for (const f of phpFiles) {
          const tmp = join(dir, "lint.php");
          await writeFile(tmp, f.content, "utf8");
          try {
            await execFileAsync("php", ["-l", tmp], { timeout: 10000 });
            results.push(ok(f.path, "php-lint", "PHP syntax OK"));
          } catch (err: unknown) {
            const out = extractPhpError(err);
            results.push({
              filePath: f.path,
              check: "php-lint",
              severity: "critical",
              passed: false,
              message: `PHP parse error: ${out}`,
            });
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      results.push({
        filePath: "",
        check: "php-lint",
        severity: "info",
        passed: true,
        message: "PHP CLI not available in this environment — syntax lint skipped.",
      });
    }
  }

  // ── Per-file heuristic checks ───────────────────────────────────────────────
  for (const f of phpFiles) {
    const isIndexSilence = /(^|\/)index\.php$/.test(f.path) && f.content.length < 200;
    const isUninstall = /(^|\/)uninstall\.php$/.test(f.path);
    const isMain = Boolean(manifest && f.path === `${manifest.slug}.php`);

    // Direct-access guard. Plugin files use ABSPATH; uninstall.php uses
    // WP_UNINSTALL_PLUGIN; the index.php silence file needs neither.
    const hasGuard =
      /defined\(\s*['"]ABSPATH['"]\s*\)/.test(f.content) ||
      /defined\(\s*['"]WP_UNINSTALL_PLUGIN['"]\s*\)/.test(f.content);
    if (!isIndexSilence && !hasGuard) {
      results.push(fail(f.path, "abspath-guard", "high", isUninstall
        ? "Missing guard: add `if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) { exit; }` at the top of uninstall.php."
        : "Missing direct-access guard: add `if ( ! defined( 'ABSPATH' ) ) { exit; }` near the top."));
    }

    // Closing tag at EOF
    if (/\?>\s*$/.test(f.content)) {
      results.push(fail(f.path, "closing-tag", "low", "Remove the trailing `?>` closing tag (can emit stray whitespace / 'headers already sent')."));
    }

    // Dangerous functions
    for (const [re, msg] of DANGEROUS) {
      if (re.test(f.content)) {
        results.push(fail(f.path, "dangerous-call", "high", msg));
      }
    }

    // Possible SQL injection: $wpdb->query/get_results with interpolated vars and no prepare()
    if (/\$wpdb->(query|get_(results|row|var|col))\s*\(\s*["'][^"']*\$/.test(f.content) && !/->prepare\s*\(/.test(f.content)) {
      results.push(fail(f.path, "sql-prepare", "critical", "Possible SQL injection: $wpdb query interpolates a variable without $wpdb->prepare()."));
    }

    // Direct superglobal use without unslash/sanitize on the same line context
    if (/\$_(POST|GET|REQUEST|COOKIE)\b/.test(f.content) && !/wp_unslash|sanitize_|absint|wp_verify_nonce|check_admin_referer|check_ajax_referer/.test(f.content)) {
      results.push(fail(f.path, "input-sanitize", "high", "Superglobal accessed without wp_unslash()/sanitization or a nonce check nearby."));
    }

    // echo of a raw variable (very rough XSS heuristic)
    if (/echo\s+\$[a-zA-Z_][\w]*\s*;/.test(f.content) && !/esc_/.test(f.content)) {
      results.push(fail(f.path, "escape-output", "medium", "Echoing a variable without an esc_*() escaping function (possible XSS)."));
    }

    // Main-file-only checks (run on the single file when it IS the main file).
    if (isMain) {
      if (!/Plugin Name:\s*\S/.test(f.content)) {
        results.push(fail(f.path, "plugin-header", "critical", "Main file is missing a valid `Plugin Name:` header block — WordPress will not recognize the plugin."));
      }
      if (manifest!.textDomain && !f.content.includes(manifest!.textDomain)) {
        results.push(fail(f.path, "text-domain", "medium", `Declared text domain "${manifest!.textDomain}" not referenced in the main file.`));
      }
    }
  }

  // ── Whole-plugin checks (only when validating the COMPLETE file set) ─────────
  // Skipped during single-file builds, otherwise every non-main file would be
  // falsely flagged as "main plugin file missing".
  if (manifest && opts?.wholePlugin) {
    const mainFile = files.find((f) => f.path === `${manifest.slug}.php`);
    if (!mainFile) {
      results.push(fail(`${manifest.slug}.php`, "main-file", "critical", `Main plugin file "${manifest.slug}.php" is missing.`));
    }
  }

  return results;
}

const DANGEROUS: [RegExp, string][] = [
  [/\beval\s*\(/, "Use of eval() is forbidden in WordPress plugins."],
  [/\bextract\s*\(/, "Use of extract() is unsafe and discouraged."],
  [/\bcreate_function\s*\(/, "create_function() is removed in modern PHP — use a closure."],
  [/\berror_reporting\s*\(\s*0\s*\)/, "Do not silence all errors with error_reporting(0)."],
  [/\bbase64_decode\s*\(.*(eval|assert|system|exec)/s, "Obfuscated/dynamic execution pattern detected."],
];

function ok(filePath: string, check: string, message: string): ValidationResult {
  return { filePath, check, severity: "info", passed: true, message };
}
function fail(filePath: string, check: string, severity: ValidationResult["severity"], message: string): ValidationResult {
  return { filePath, check, severity, passed: false, message };
}

function extractPhpError(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const raw = (e.stderr || e.stdout || e.message || "").toString();
  const line = raw.split("\n").find((l) => /error/i.test(l));
  return (line || raw).trim().slice(0, 300);
}
