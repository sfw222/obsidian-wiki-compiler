import { TFile, Vault, requestUrl, Notice } from "obsidian";
import { LLMClient } from "../llm/client";
import { WikiArticle } from "./generator";

const EXTRACT_PROMPT = `You are a knowledge analyst. Given a list of wiki articles, extract the most important high-frequency concepts that appear across multiple articles.

Return ONLY a JSON array of objects. No explanation, no markdown fences.
Each object must have exactly two fields:
- "concept": the concept name (string)
- "context": a 2-5 word domain hint that identifies where this concept belongs in the SOURCE articles, used to disambiguate it from identically-named concepts in unrelated domains

Example: [{"concept":"Attention Mechanism","context":"transformer deep learning"},{"concept":"Gradient Descent","context":"neural network optimization"}]

Rules:
- Return 5-15 concepts maximum
- Prefer specific technical/domain concepts over generic words
- Only include concepts mentioned in 2+ articles
- Do not include concepts that already have their own wiki page (listed below)
- Each concept must be ATOMIC — a single, indivisible idea. Never combine two concepts with "/" or "and" (e.g. use "KYC" and "AML" separately, not "KYC/AML")
- If a compound term like "X/Y" or "X and Y" comes to mind, split it into separate entries
- The "context" hint MUST reflect the domain of the source articles, not a generic description of the concept`;

// ---------------------------------------------------------------------------
// Relevance filtering
// ---------------------------------------------------------------------------

/**
 * Filter raw SearXNG results by asking the LLM whether each snippet is
 * relevant to `concept` in the context of `articleContext`.
 *
 * Returns only the results the LLM judges as relevant.
 * If ALL results are rejected, returns the top-1 as a last-resort fallback
 * so the concept page is never completely empty.
 */
async function filterResultsByRelevance(
  concept: string,
  articleContext: string,
  results: Array<{ title: string; content: string; url: string }>,
  client: LLMClient,
  signal?: AbortSignal
): Promise<Array<{ title: string; content: string; url: string }>> {
  if (results.length === 0) return [];

  // Build a compact numbered list for the LLM to judge
  const numbered = results
    .map((r, i) => `[${i}] ${r.title}\n${r.content.slice(0, 200)}`)
    .join("\n\n");

  const systemPrompt =
    `You are a relevance filter. You will be given a concept name, its domain context from a knowledge base, and a numbered list of web search snippets. ` +
    `Reply ONLY with a JSON array of the indices (integers) that are relevant to the concept AS USED IN THE GIVEN DOMAIN CONTEXT. ` +
    `Exclude results about unrelated domains, promotional content, or off-topic pages. ` +
    `Example reply: [0,2,3]`;

  const userMsg =
    `Concept: "${concept}"\nDomain context: "${articleContext}"\n\nSearch results:\n${numbered}`;

  let relevant: number[] = [];
  try {
    const raw = await client.complete(systemPrompt, userMsg, signal);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (match) relevant = JSON.parse(match[0]) as number[];
  } catch (e) {
    console.warn(`[WikiCompiler] Relevance filter failed for "${concept}":`, (e as Error).message);
    // On failure, pass everything through
    return results;
  }

  const filtered = results.filter((_, i) => relevant.includes(i));

  // Last-resort fallback: never return empty
  if (filtered.length === 0) {
    console.warn(`[WikiCompiler] All results filtered for "${concept}", using top-1 fallback`);
    return results.slice(0, 1);
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// SearXNG search
// ---------------------------------------------------------------------------

async function searchSearXNG(
  concept: string,
  context: string,
  baseUrl: string,
  token: string
): Promise<Array<{ title: string; content: string; url: string }>> {
  const query = context ? `${concept} ${context}` : concept;
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await requestUrl({ url, headers });
  if (res.status !== 200) throw new Error(`SearXNG error: ${res.status}`);

  return (res.json.results ?? [])
    .filter((r: any) => r.content && r.content.length > 50) // drop results with no body
    .slice(0, 8) // fetch more candidates so the filter has room to work
    .map((r: any) => ({
      title: r.title ?? "",
      content: r.content ?? r.snippet ?? "",
      url: r.url ?? "",
    }));
}

/** Build the markdown body + sources section from filtered results. */
function buildSearchBody(results: Array<{ title: string; content: string; url: string }>): {
  body: string;
  sources: string;
} {
  const body = results
    .map((r) => `**${r.title}**\n${r.content}`)
    .join("\n\n");
  const sources = results
    .filter((r) => r.url)
    .map((r) => `- [${r.title ?? r.url}](${r.url})`)
    .join("\n");
  return { body, sources };
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Derive a short domain context string for `conceptName` from vault articles.
 * Prefers the saved `search_context` frontmatter field written at creation time.
 * Falls back to article titles that mention the concept.
 */
async function deriveContext(
  conceptName: string,
  articles: WikiArticle[],
  file: TFile,
  vault: Vault
): Promise<string> {
  // 1. Try saved search_context in frontmatter
  const existing = await vault.read(file);
  const savedMatch = existing.match(/search_context:\s*"?([^"\n]+)"?/);
  if (savedMatch) return savedMatch[1].trim();

  // 2. Fall back to article titles that mention this concept
  const mentioning = articles.filter((a) => {
    const wikiLink = new RegExp(`\\[\\[${escapeRegex(conceptName)}\\]\\]`, "i");
    const plainText = new RegExp(
      `(?<![\\u4e00-\\u9fa5\\w])${escapeRegex(conceptName)}(?![\\u4e00-\\u9fa5\\w])`,
      "i"
    );
    return wikiLink.test(a.content) || plainText.test(a.content);
  });
  return mentioning
    .slice(0, 3)
    .map((a) => a.title)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Main export: extractAndEnrichConcepts
// ---------------------------------------------------------------------------

export async function extractAndEnrichConcepts(
  articles: WikiArticle[],
  vault: Vault,
  outputFolder: string,
  client: LLMClient,
  searxngBaseUrl: string,
  searxngToken: string,
  outputLanguage: string,
  signal?: AbortSignal,
  logger?: (msg: string) => void
): Promise<number> {
  if (!searxngBaseUrl) return 0;
  const log = logger ?? (() => {});

  const vaultFileMap = buildVaultFileMap(vault);
  const existingConcepts = getExistingConceptTitles(vault, outputFolder);
  const articlesText = articles
    .map((a) => {
      const snippet = a.content.slice(0, 500).replace(/\n+/g, " ").trim();
      return `# ${a.title}\n${snippet}`;
    })
    .join("\n\n---\n\n");

  const langHint =
    outputLanguage === "zh"
      ? "Return all concept strings in Chinese (中文)."
      : outputLanguage === "ja"
      ? "Return all concept strings in Japanese (日本語)."
      : outputLanguage === "en"
      ? "Return all concept strings in English."
      : "Return each concept in the same language it appears in the source articles.";

  const raw = await client.complete(
    EXTRACT_PROMPT + `\n- LANGUAGE: ${langHint}`,
    articlesText,
    signal
  );
  console.log("[WikiCompiler] Concept LLM raw:", raw.slice(0, 300));

  let conceptEntries: Array<{ concept: string; context: string }> = [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match)
    throw new Error(
      `Concept extraction: LLM returned no JSON array. Raw: ${raw.slice(0, 200)}`
    );
  const parsed = JSON.parse(match[0]);
  if (parsed.length > 0 && typeof parsed[0] === "string") {
    conceptEntries = (parsed as string[]).map((c) => ({ concept: c, context: "" }));
  } else {
    conceptEntries = parsed as Array<{ concept: string; context: string }>;
  }

  const existingSet = new Set(existingConcepts.map((c) => c.toLowerCase()));
  conceptEntries = conceptEntries.filter(
    (e) => !existingSet.has(e.concept.toLowerCase())
  );
  const concepts = conceptEntries.map((e) => e.concept);
  log(`Extracted ${concepts.length} concept(s): ${concepts.join(", ")}`);

  const conceptFolder = `${outputFolder}/Concepts`;
  await ensureFolder(vault, conceptFolder);

  let created = 0;
  const skipped: string[] = [];
  const CONCURRENCY = 3;

  const processConcept = async (entry: { concept: string; context: string }) => {
    if (signal?.aborted) return;
    const { concept, context } = entry;

    let rawResults: Array<{ title: string; content: string; url: string }> = [];
    try {
      rawResults = await searchSearXNG(concept, context, searxngBaseUrl, searxngToken);
    } catch (e) {
      console.warn(`[WikiCompiler] SearXNG "${concept}" failed:`, (e as Error).message);
    }

    if (rawResults.length === 0) {
      log(`SearXNG "${concept}": no results`);
      skipped.push(concept);
      return;
    }

    const filtered = await filterResultsByRelevance(concept, context, rawResults, client, signal);
    log(`SearXNG "${concept}": ${rawResults.length} raw → ${filtered.length} relevant`);

    const { body, sources } = buildSearchBody(filtered);
    const sourcesSection = sources ? `\n\n## 来源\n\n${sources}` : "";
    const newContent = `## Overview\n\n${body}${sourcesSection}`;

    const existingFile = vaultFileMap.get(concept.toLowerCase());
    if (existingFile) {
      const existingContent = await vault.read(existingFile);
      if (!existingContent.includes(body.slice(0, 80))) {
        await vault.modify(existingFile, existingContent + `\n\n---\n\n${body}${sourcesSection}`);
      }
    } else {
      const safeConceptName = concept.replace(/[\\/:*?"<>|]/g, "-").trim();
      const filePath = `${conceptFolder}/${safeConceptName}.md`;
      const frontmatter =
        `---\ntype: concept\ngenerated: ${new Date().toISOString().slice(0, 10)}` +
        (context ? `\nsearch_context: "${context}"` : "") +
        `\n---\n\n`;
      await vault.create(filePath, frontmatter + `# ${concept}\n\n${newContent}`);
      log(`Created concept page: "${concept}"`);
    }
    created++;
  };

  for (let i = 0; i < conceptEntries.length; i += CONCURRENCY) {
    if (signal?.aborted) break;
    await Promise.all(conceptEntries.slice(i, i + CONCURRENCY).map(processConcept));
    if (i + CONCURRENCY < conceptEntries.length) await new Promise((r) => setTimeout(r, 800));
  }

  if (skipped.length > 0) {
    new Notice(
      `Wiki Compiler: SearXNG unavailable, skipped ${skipped.length} concept(s): ${skipped.join(", ")}`
    );
  }

  for (const concept of concepts) {
    await injectConceptLinks(concept, articles, vault, outputFolder);
  }
  await crossLinkConcepts(vault, outputFolder);

  return created;
}

// ---------------------------------------------------------------------------
// refreshConceptPages
// ---------------------------------------------------------------------------

export async function refreshConceptPages(
  vault: Vault,
  outputFolder: string,
  client: LLMClient,
  searxngBaseUrl: string,
  searxngToken: string,
  signal?: AbortSignal,
  logger?: (msg: string) => void
): Promise<number> {
  if (!searxngBaseUrl) return 0;
  const log = logger ?? (() => {});

  const articles = await loadWikiArticlesFromVault(vault, outputFolder);

  const conceptFolder = vault.getAbstractFileByPath(`${outputFolder}/Concepts`);
  if (!conceptFolder || !("children" in conceptFolder)) return 0;

  const conceptFiles = (conceptFolder as any).children.filter(
    (c: any) => c instanceof TFile && c.extension === "md"
  ) as TFile[];

  let refreshed = 0;
  const CONCURRENCY = 3;

  const refreshConcept = async (file: TFile) => {
    if (signal?.aborted) return;
    const conceptName = file.basename;

    const context = await deriveContext(conceptName, articles, file, vault);
    log(`Refreshing "${conceptName}" (context: "${context || "none"}")`);

    let rawResults: Array<{ title: string; content: string; url: string }> = [];
    try {
      rawResults = await searchSearXNG(conceptName, context, searxngBaseUrl, searxngToken);
    } catch (e) {
      log(`SearXNG "${conceptName}" failed: ${(e as Error).message}`);
    }

    if (rawResults.length === 0) {
      log(`Skipping "${conceptName}": no search results`);
      return;
    }

    const filtered = await filterResultsByRelevance(conceptName, context, rawResults, client, signal);
    log(`"${conceptName}": ${rawResults.length} raw → ${filtered.length} relevant`);

    const { body, sources } = buildSearchBody(filtered);
    const sourcesSection = sources ? `\n\n## 来源\n\n${sources}` : "";

    const existing = await vault.read(file);
    const fmMatch = existing.match(/^(---\n[\s\S]*?\n---)/);
    let newFrontmatter: string;
    if (fmMatch) {
      newFrontmatter = fmMatch[1]
        .replace(/\nrefreshed:.*/, "")
        .replace(/\n---$/, `\nrefreshed: ${new Date().toISOString().slice(0, 10)}\n---`);
    } else {
      newFrontmatter =
        `---\ntype: concept\nrefreshed: ${new Date().toISOString().slice(0, 10)}` +
        (context ? `\nsearch_context: "${context}"` : "") +
        `\n---`;
    }

    const newContent = `${newFrontmatter}\n\n# ${conceptName}\n\n## Overview\n\n${body}${sourcesSection}`;
    await vault.modify(file, newContent);
    log(`Refreshed concept page: "${conceptName}"`);
    refreshed++;
  };

  for (let i = 0; i < conceptFiles.length; i += CONCURRENCY) {
    if (signal?.aborted) break;
    await Promise.all(conceptFiles.slice(i, i + CONCURRENCY).map(refreshConcept));
    if (i + CONCURRENCY < conceptFiles.length) await new Promise((r) => setTimeout(r, 800));
  }

  await crossLinkConcepts(vault, outputFolder);
  return refreshed;
}

// ---------------------------------------------------------------------------
// Unchanged helpers
// ---------------------------------------------------------------------------

async function injectConceptLinks(
  concept: string,
  articles: WikiArticle[],
  vault: Vault,
  outputFolder: string
): Promise<void> {
  const folder = vault.getAbstractFileByPath(outputFolder);
  if (!folder || !("children" in folder)) return;

  const fileMap = new Map<string, TFile>();
  const walk = (f: any) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === "md") {
        fileMap.set(child.basename.toLowerCase(), child);
      } else if ("children" in child) walk(child);
    }
  };
  walk(folder);

  const regex = new RegExp(
    `(?<!\\[\\[)(?<![\\u4e00-\\u9fa5\\w])${escapeRegex(concept)}(?![\\u4e00-\\u9fa5\\w])(?!\\]\\])`,
    "gi"
  );

  for (const article of articles) {
    const file = fileMap.get(article.title.toLowerCase());
    if (!file) continue;
    const text = await vault.read(file);
    if (!regex.test(text)) continue;
    regex.lastIndex = 0;
    const updated = text.replace(regex, `[[${concept}]]`);
    if (updated !== text) await vault.modify(file, updated);
  }
}

async function crossLinkConcepts(vault: Vault, outputFolder: string): Promise<void> {
  const conceptFolder = vault.getAbstractFileByPath(`${outputFolder}/Concepts`);
  if (!conceptFolder || !("children" in conceptFolder)) return;

  const conceptFiles = (conceptFolder as any).children.filter(
    (c: any) => c instanceof TFile && c.extension === "md"
  ) as TFile[];

  const conceptNames = conceptFiles.map((f) => f.basename);

  for (const file of conceptFiles) {
    let text = await vault.read(file);
    let modified = false;

    for (const other of conceptNames) {
      if (other.toLowerCase() === file.basename.toLowerCase()) continue;
      const regex = new RegExp(
        `(?<!\\[\\[)(?<![\\u4e00-\\u9fa5\\w])${escapeRegex(other)}(?![\\u4e00-\\u9fa5\\w])(?!\\]\\])`,
        "gi"
      );
      const replaced = text.replace(regex, `[[${other}]]`);
      if (replaced !== text) {
        text = replaced;
        modified = true;
      }
    }

    if (modified) await vault.modify(file, text);
  }
}

function buildVaultFileMap(vault: Vault): Map<string, TFile> {
  const map = new Map<string, TFile>();
  for (const file of vault.getMarkdownFiles()) {
    const key = file.basename.toLowerCase();
    if (!map.has(key)) map.set(key, file);
  }
  return map;
}

function getExistingConceptTitles(vault: Vault, outputFolder: string): string[] {
  const folder = vault.getAbstractFileByPath(`${outputFolder}/Concepts`);
  if (!folder || !("children" in folder)) return [];
  return (folder as any).children
    .filter((c: any) => c instanceof TFile)
    .map((c: any) => c.basename);
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  if (!vault.getAbstractFileByPath(path)) await vault.createFolder(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the first sentence in `content` that mentions `conceptName`.
 * Strips markdown syntax and returns up to 120 chars, or "" if not found.
 */
function extractMentionSnippet(content: string, conceptName: string): string {
  const regex = new RegExp(escapeRegex(conceptName), "i");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length > 30 &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("---") &&
      !trimmed.startsWith("source:") &&
      !trimmed.startsWith("category:") &&
      !trimmed.startsWith("generated:") &&
      regex.test(trimmed)
    ) {
      return trimmed
        .replace(/\*\*|__|`|\[\[|\]\]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .slice(0, 120);
    }
  }
  return "";
}

export async function loadWikiArticlesFromVault(
  vault: Vault,
  outputFolder: string
): Promise<WikiArticle[]> {
  const folder = vault.getAbstractFileByPath(outputFolder);
  if (!folder || !("children" in folder)) return [];
  const articles: WikiArticle[] = [];
  const walk = (f: any) => {
    for (const child of f.children) {
      if (
        child instanceof TFile &&
        child.extension === "md" &&
        child.basename !== "_index" &&
        child.basename !== "_log" &&
        child.basename !== "_lint-report" &&
        !child.path.includes("/Concepts/") &&
        !child.path.includes("/raw/") &&
        !child.path.includes("/Queries/")
      ) {
        articles.push({
          sourceFile: child.path,
          title: child.basename,
          category: "",
          content: "",
          relatedTopics: [],
        });
      } else if ("children" in child) walk(child);
    }
  };
  walk(folder);
  for (const a of articles) {
    const file = vault.getAbstractFileByPath(a.sourceFile);
    if (file instanceof TFile) a.content = await vault.read(file);
  }
  return articles;
}