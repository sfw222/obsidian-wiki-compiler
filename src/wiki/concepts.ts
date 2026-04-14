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
  const articlesText = articles.map((a) => {
    const snippet = a.content.slice(0, 500).replace(/\n+/g, " ").trim();
    return `# ${a.title}\n${snippet}`;
  }).join("\n\n---\n\n");

  const langHint = outputLanguage === "zh" ? "Return all concept strings in Chinese (中文)." :
    outputLanguage === "ja" ? "Return all concept strings in Japanese (日本語)." :
    outputLanguage === "en" ? "Return all concept strings in English." :
    "Return each concept in the same language it appears in the source articles.";

  const raw = await client.complete(EXTRACT_PROMPT + `\n- LANGUAGE: ${langHint}`, articlesText, signal);
  console.log("[WikiCompiler] Concept LLM raw:", raw.slice(0, 300));
  let conceptEntries: Array<{ concept: string; context: string }> = [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Concept extraction: LLM returned no JSON array. Raw: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  // Support both new {concept, context} format and legacy plain-string format
  if (parsed.length > 0 && typeof parsed[0] === "string") {
    conceptEntries = (parsed as string[]).map((c) => ({ concept: c, context: "" }));
  } else {
    conceptEntries = parsed as Array<{ concept: string; context: string }>;
  }
  const existingSet = new Set(existingConcepts.map((c) => c.toLowerCase()));
  conceptEntries = conceptEntries.filter((e) => !existingSet.has(e.concept.toLowerCase()));
  const concepts = conceptEntries.map((e) => e.concept);
  log(`Extracted ${concepts.length} concept(s): ${concepts.join(", ")}`);

  const conceptFolder = `${outputFolder}/Concepts`;
  await ensureFolder(vault, conceptFolder);

  let created = 0;
  const skipped: string[] = [];
  for (const entry of conceptEntries) {
    if (signal?.aborted) return created;
    const { concept, context } = entry;

    let searchResult: { body: string; sources: string } | null = null;
    try {
      searchResult = await searchSearXNG(concept, context, searxngBaseUrl, searxngToken);
    } catch (e) {
      console.warn(`[WikiCompiler] SearXNG "${concept}" failed:`, (e as Error).message);
    }
    console.log(`[WikiCompiler] SearXNG "${concept}":`, searchResult ? `${searchResult.body.length} chars` : "null");
    log(`SearXNG "${concept}": ${searchResult ? `${searchResult.body.length} chars` : "failed/empty"}`);
    // Respect rate limits on public instances
    await new Promise((r) => setTimeout(r, 1500));

    if (!searchResult) {
      skipped.push(concept);
      continue;
    }

    const sourcesSection = searchResult.sources ? `\n\n## 来源\n\n${searchResult.sources}` : "";
    const newContent = `## Overview\n\n${searchResult.body}${sourcesSection}`;

    // Check if a page with this name already exists anywhere in the vault
    const existingFile = vaultFileMap.get(concept.toLowerCase());
    if (existingFile) {
      const existingContent = await vault.read(existingFile);
      // Append new search results as a new section if not already present
      if (!existingContent.includes(searchResult.body.slice(0, 80))) {
        await vault.modify(existingFile, existingContent + `\n\n---\n\n${searchResult.body}${sourcesSection}`);
      }
    } else {
      const safeConceptName = concept.replace(/[\\/:*?"<>|]/g, "-").trim();
      const filePath = `${conceptFolder}/${safeConceptName}.md`;
      const frontmatter = `---\ntype: concept\ngenerated: ${new Date().toISOString().slice(0, 10)}\n---\n\n`;
      const body = frontmatter + `# ${concept}\n\n${newContent}`;
      await vault.create(filePath, body);
      log(`Created concept page: "${concept}"`);
    }
    created++;
  }

  if (skipped.length > 0) {
    new Notice(`Wiki Compiler: SearXNG unavailable, skipped ${skipped.length} concept(s): ${skipped.join(", ")}`);
  }

  for (const concept of concepts) {
    await injectConceptLinks(concept, articles, vault, outputFolder);
  }
  await crossLinkConcepts(vault, outputFolder);

  return created;
}

async function searchSearXNG(concept: string, context: string, baseUrl: string, token: string): Promise<{ body: string; sources: string } | null> {
  const query = context ? `${concept} ${context}` : concept;
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await requestUrl({ url, headers });
  if (res.status !== 200) throw new Error(`SearXNG error: ${res.status}`);
  const results = (res.json.results ?? []).slice(0, 5);
  if (results.length === 0) return null;
  const body = results.map((r: any) => `**${r.title}**\n${r.content ?? r.snippet ?? ""}`).join("\n\n");
  const sources = results
    .filter((r: any) => r.url)
    .map((r: any) => `- [${r.title ?? r.url}](${r.url})`)
    .join("\n");
  return { body, sources };
}

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

  const regex = new RegExp(`(?<!\\[\\[)(?<![\\u4e00-\\u9fa5\\w])${escapeRegex(concept)}(?![\\u4e00-\\u9fa5\\w])(?!\\]\\])`, "gi");

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
      const regex = new RegExp(`(?<!\\[\\[)(?<![\\u4e00-\\u9fa5\\w])${escapeRegex(other)}(?![\\u4e00-\\u9fa5\\w])(?!\\]\\])`, "gi");
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

export async function refreshConceptPages(
  vault: Vault,
  outputFolder: string,
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
  for (const file of conceptFiles) {
    if (signal?.aborted) return refreshed;
    const conceptName = file.basename;

    // Derive context from wiki articles that mention this concept
    const mentioning = articles.filter((a) => {
      const wikiLink = new RegExp(`\\[\\[${escapeRegex(conceptName)}\\]\\]`, "i");
      const plainText = new RegExp(`(?<![\\u4e00-\\u9fa5\\w])${escapeRegex(conceptName)}(?![\\u4e00-\\u9fa5\\w])`, "i");
      return wikiLink.test(a.content) || plainText.test(a.content);
    });
    const context = mentioning.slice(0, 3).map((a) => a.title).join(" ");
    log(`Refreshing "${conceptName}" (context: "${context || "none"}")`);

    let searchResult: { body: string; sources: string } | null = null;
    try {
      searchResult = await searchSearXNG(conceptName, context, searxngBaseUrl, searxngToken);
    } catch (e) {
      log(`SearXNG "${conceptName}" failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));

    if (!searchResult) {
      log(`Skipping "${conceptName}": no search results`);
      continue;
    }

    // Rebuild frontmatter: keep type/generated, add/update refreshed date
    const existing = await vault.read(file);
    const fmMatch = existing.match(/^(---\n[\s\S]*?\n---)/);
    let newFrontmatter: string;
    if (fmMatch) {
      const cleaned = fmMatch[1]
        .replace(/\nrefreshed:.*/, "")
        .replace(/\n---$/, `\nrefreshed: ${new Date().toISOString().slice(0, 10)}\n---`);
      newFrontmatter = cleaned;
    } else {
      newFrontmatter = `---\ntype: concept\nrefreshed: ${new Date().toISOString().slice(0, 10)}\n---`;
    }

    const sourcesSection = searchResult.sources ? `\n\n## 来源\n\n${searchResult.sources}` : "";
    const newContent = `${newFrontmatter}\n\n# ${conceptName}\n\n## Overview\n\n${searchResult.body}${sourcesSection}`;
    await vault.modify(file, newContent);
    log(`Refreshed concept page: "${conceptName}"`);
    refreshed++;
  }

  await crossLinkConcepts(vault, outputFolder);
  return refreshed;
}

export async function loadWikiArticlesFromVault(vault: Vault, outputFolder: string): Promise<WikiArticle[]> {
  const folder = vault.getAbstractFileByPath(outputFolder);
  if (!folder || !("children" in folder)) return [];
  const articles: WikiArticle[] = [];
  const walk = (f: any) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === "md" &&
          child.basename !== "_index" && child.basename !== "_log" &&
          child.basename !== "_lint-report" && !child.path.includes("/Concepts/") &&
          !child.path.includes("/raw/") && !child.path.includes("/Queries/")) {
        articles.push({ sourceFile: child.path, title: child.basename, category: "", content: "", relatedTopics: [] });
      } else if ("children" in child) walk(child);
    }
  };
  walk(folder);
  // Load content for each article
  for (const a of articles) {
    const file = vault.getAbstractFileByPath(a.sourceFile);
    if (file instanceof TFile) a.content = await vault.read(file);
  }
  return articles;
}
