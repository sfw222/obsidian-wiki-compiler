import { TFile, Vault } from "obsidian";
import { LLMClient } from "../llm/client";
import { PluginSettings } from "../settings";

const LINT_PROMPT = `You are a wiki health auditor. Analyze the provided wiki content and identify issues.

Return a markdown report with these sections:
## Contradictions
List any pages with conflicting information (cite [[page title]]).

## Orphan Pages
List pages with no incoming [[wikilinks]] from other pages.

## Missing Concepts
List important concepts mentioned in multiple pages but lacking their own dedicated page.

## Stale Content
List pages that appear outdated or reference things that may have changed.

Be specific and actionable. If a section has no issues, write "None found."`;

/**
 * Pure code-level checks that do not consume LLM tokens.
 * Reads all wiki article files, checks for:
 * - Missing source field in frontmatter
 * - facts/relations entries without source
 * - lastReviewed > reviewIntervalDays → flags as needs-review
 * - Orphan nodes: articles with no incoming [[wikilinks]]
 * Returns a markdown report section string.
 */
export async function runCodeLevelChecks(
  vault: Vault,
  outputFolder: string,
  settings: PluginSettings
): Promise<string> {
  const reviewIntervalDays = settings.reviewIntervalDays ?? 90;
  const wikiFolder = vault.getAbstractFileByPath(`${outputFolder}/Wiki`);

  const missingSource: string[] = [];
  const missingFieldSource: string[] = [];
  const needsReview: string[] = [];
  const allTitles = new Set<string>();
  const mentionedByMap = new Map<string, Set<string>>(); // title → set of titles that link to it
  const articleFiles: TFile[] = [];

  if (wikiFolder && "children" in wikiFolder) {
    const walk = (node: any) => {
      for (const child of node.children) {
        if (child instanceof TFile && child.extension === "md") {
          articleFiles.push(child);
          allTitles.add(child.basename.toLowerCase());
        } else if ("children" in child) walk(child);
      }
    };
    walk(wikiFolder);
  }

  for (const file of articleFiles) {
    const text = await vault.read(file);

    // Check missing source
    if (!/^source:/m.test(text)) {
      missingSource.push(file.basename);
    }

    // Check lastReviewed
    const lrMatch = text.match(/^lastReviewed:\s*"?(\d{4}-\d{2}-\d{2})"?/m);
    if (lrMatch) {
      const daysDiff = (Date.now() - new Date(lrMatch[1]).getTime()) / 86400000;
      if (daysDiff > reviewIntervalDays) {
        needsReview.push(`${file.basename} (last reviewed ${lrMatch[1]}, ${Math.floor(daysDiff)}d ago)`);
        // Auto-update status in frontmatter
        if (/^status: (draft|verified)$/m.test(text)) {
          const updated = text.replace(/^status: (draft|verified)$/m, "status: needs-review");
          await vault.modify(file, updated);
        }
      }
    }

    // Check facts/relations without source
    const factSourceMissing = [...text.matchAll(/^  - name:/gm)].length > 0 &&
      [...text.matchAll(/^    source: ""\s*$/gm)].length > 0;
    if (factSourceMissing) missingFieldSource.push(file.basename);

    // Collect incoming links for orphan detection
    const wikiLinks = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].toLowerCase());
    for (const linked of wikiLinks) {
      if (!mentionedByMap.has(linked)) mentionedByMap.set(linked, new Set());
      mentionedByMap.get(linked)!.add(file.basename);
    }
  }

  // Orphan detection
  const orphans = articleFiles
    .filter(f => !mentionedByMap.has(f.basename.toLowerCase()) || mentionedByMap.get(f.basename.toLowerCase())!.size === 0)
    .map(f => f.basename);

  const lines: string[] = ["## Code-Level Checks (automated)\n"];
  lines.push(`### Missing Source Field (${missingSource.length})`);
  lines.push(missingSource.length > 0 ? missingSource.map(t => `- [[${t}]]`).join("\n") : "None found.");
  lines.push(`\n### Facts/Relations Without Source (${missingFieldSource.length})`);
  lines.push(missingFieldSource.length > 0 ? missingFieldSource.map(t => `- [[${t}]]`).join("\n") : "None found.");
  lines.push(`\n### Stale Articles (>${reviewIntervalDays} days since review) (${needsReview.length})`);
  lines.push(needsReview.length > 0 ? needsReview.map(t => `- ${t}`).join("\n") : "None found.");
  lines.push(`\n### Orphan Articles (no incoming links) (${orphans.length})`);
  lines.push(orphans.length > 0 ? orphans.map(t => `- [[${t}]]`).join("\n") : "None found.");
  lines.push("\n---\n");

  return lines.join("\n");
}

export async function lintWiki(
  wikiContext: string,
  client: LLMClient,
  signal?: AbortSignal,
  vault?: Vault,
  outputFolder?: string,
  settings?: PluginSettings
): Promise<string> {
  let codeReport = "";
  if (vault && outputFolder && settings) {
    codeReport = await runCodeLevelChecks(vault, outputFolder, settings);
  }
  const llmReport = await client.complete(LINT_PROMPT, `Wiki content:\n${wikiContext}`, signal);
  return codeReport + llmReport;
}
