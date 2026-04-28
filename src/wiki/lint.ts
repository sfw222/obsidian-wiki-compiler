import { TFile, Vault } from "obsidian";
import { LLMClient } from "../llm/client";
import { PluginSettings } from "../settings";

const LINT_PROMPT = `你是一个 Wiki 健康审查员。请分析给定内容并输出中文 Markdown 报告。

请使用以下固定标题（不要改名）：
## 矛盾信息
列出存在冲突信息的页面（使用 [[页面标题]] 引用）。

## 孤立页面
列出没有被其他页面以 [[wikilinks]] 链入的页面。

## 缺失概念
列出在多篇页面中反复出现但尚未独立成页的重要概念。

## 过时内容
列出可能过时、时间敏感或可能已变更的内容。

## 修复建议
给出可执行、优先级明确的修复建议（按高/中/低）。

若某一节没有问题，请写“未发现”。`;

export interface LintCodeStats {
  totalArticles: number;
  missingSource: number;
  missingFieldSource: number;
  needsReview: number;
  statusUpdatedToNeedsReview: number;
  orphans: number;
}

export interface LintResult {
  report: string;
  codeStats: LintCodeStats | null;
}

interface LintOptions {
  signal?: AbortSignal;
  vault?: Vault;
  outputFolder?: string;
  settings?: PluginSettings;
  onStage?: (stage: string) => void;
  onDetail?: (detail: string) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("Operation cancelled");
  err.name = "AbortError";
  throw err;
}

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
  settings: PluginSettings,
  signal?: AbortSignal,
  onDetail?: (detail: string) => void
): Promise<{ report: string; stats: LintCodeStats }> {
  const reviewIntervalDays = settings.reviewIntervalDays ?? 90;
  const wikiFolder = vault.getAbstractFileByPath(`${outputFolder}/Wiki`);

  const missingSource: string[] = [];
  const missingFieldSource: string[] = [];
  const needsReview: string[] = [];
  let statusUpdatedToNeedsReview = 0;
  const mentionedByMap = new Map<string, Set<string>>(); // title → set of titles that link to it
  const articleFiles: TFile[] = [];

  if (wikiFolder && "children" in wikiFolder) {
    const walk = (node: any) => {
      for (const child of node.children) {
        if (child instanceof TFile && child.extension === "md") {
          articleFiles.push(child);
        } else if ("children" in child) walk(child);
      }
    };
    walk(wikiFolder);
  }

  onDetail?.(`代码检查：待扫描文章 ${articleFiles.length} 篇`);

  for (let i = 0; i < articleFiles.length; i++) {
    throwIfAborted(signal);
    const file = articleFiles[i];
    const text = await vault.read(file);

    if ((i + 1) % 25 === 0 || i + 1 === articleFiles.length) {
      onDetail?.(`代码检查进度：${i + 1}/${articleFiles.length}`);
    }

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
          statusUpdatedToNeedsReview++;
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

  const lines: string[] = ["## 代码级检查（自动）\n"];
  lines.push(`### 缺失 source 字段（${missingSource.length}）`);
  lines.push(missingSource.length > 0 ? missingSource.map(t => `- [[${t}]]`).join("\n") : "未发现。");
  lines.push(`\n### facts/relations 缺失来源（${missingFieldSource.length}）`);
  lines.push(missingFieldSource.length > 0 ? missingFieldSource.map(t => `- [[${t}]]`).join("\n") : "未发现。");
  lines.push(`\n### 超期未复审（>${reviewIntervalDays} 天）（${needsReview.length}）`);
  lines.push(needsReview.length > 0 ? needsReview.map(t => `- ${t}`).join("\n") : "未发现。");
  lines.push(`\n### 孤立页面（无入链）（${orphans.length}）`);
  lines.push(orphans.length > 0 ? orphans.map(t => `- [[${t}]]`).join("\n") : "未发现。");
  lines.push("\n---\n");

  const stats: LintCodeStats = {
    totalArticles: articleFiles.length,
    missingSource: missingSource.length,
    missingFieldSource: missingFieldSource.length,
    needsReview: needsReview.length,
    statusUpdatedToNeedsReview,
    orphans: orphans.length,
  };

  onDetail?.(
    `代码检查完成：文章 ${stats.totalArticles}，缺失 source ${stats.missingSource}，缺失来源 ${stats.missingFieldSource}，超期 ${stats.needsReview}，自动更新状态 ${stats.statusUpdatedToNeedsReview}，孤立 ${stats.orphans}`
  );

  return { report: lines.join("\n"), stats };
}

export async function lintWiki(
  wikiContext: string,
  client: LLMClient,
  options: LintOptions = {}
): Promise<LintResult> {
  const { signal, vault, outputFolder, settings, onStage, onDetail } = options;
  throwIfAborted(signal);

  let codeReport = "";
  let codeStats: LintCodeStats | null = null;
  if (vault && outputFolder && settings) {
    onStage?.("阶段 2/4：代码级检查");
    const code = await runCodeLevelChecks(vault, outputFolder, settings, signal, onDetail);
    codeReport = code.report;
    codeStats = code.stats;
  }

  throwIfAborted(signal);
  onStage?.("阶段 3/4：LLM 深度审查");
  onDetail?.("开始执行 LLM 深度审查...");
  const llmRaw = await client.complete(LINT_PROMPT, `Wiki content:\n${wikiContext}`, signal);
  onDetail?.("LLM 深度审查完成");

  const llmSection = `## LLM 深度审查\n\n${llmRaw}\n`;
  return { report: `${codeReport}${llmSection}`, codeStats };
}
