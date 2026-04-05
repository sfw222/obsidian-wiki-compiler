import { TFile, Vault, requestUrl } from "obsidian";
import { LLMClient } from "../llm/client";
import { WikiArticle, updateExistingArticle } from "./generator";

const EXTRACT_PROMPT = `You are a knowledge analyst. Given a list of wiki articles, extract the most important high-frequency concepts that appear across multiple articles.

Return ONLY a JSON array of concept strings. No explanation, no markdown fences.
Example: ["Transformer", "Attention Mechanism", "Gradient Descent"]

Rules:
- Return 5-15 concepts maximum
- Prefer specific technical/domain concepts over generic words
- Only include concepts mentioned in 2+ articles
- Do not include concepts that already have their own wiki page (listed below)
- Each concept must be ATOMIC — a single, indivisible idea. Never combine two concepts with "/" or "and" (e.g. use "KYC" and "AML" separately, not "KYC/AML")
- If a compound term like "X/Y" or "X and Y" comes to mind, split it into separate entries`;

const CONCEPT_PAGE_PROMPT = `You are a wiki writer. Write a comprehensive encyclopedic article about the given concept, based on the provided search results.

Return ONLY the markdown content (no frontmatter). Start with ## Overview. Use [[wikilink]] for related concepts. Minimum 150 words.`;

export async function extractAndEnrichConcepts(
  articles: WikiArticle[],
  vault: Vault,
  outputFolder: string,
  client: LLMClient,
  searxngBaseUrl: string,
  searxngToken: string,
  outputLanguage: string,
  signal?: AbortSignal
): Promise<number> {
  if (!searxngBaseUrl) return 0;

  const vaultFileMap = buildVaultFileMap(vault);
  const existingConcepts = getExistingConceptTitles(vault, outputFolder);
  const articlesText = articles.map((a) => `# ${a.title}\n${a.content}`).join("\n\n---\n\n");
  const existingHint = existingConcepts.length > 0
    ? `\nExisting concept pages (skip these): ${existingConcepts.join(", ")}`
    : "";

  const raw = await client.complete(EXTRACT_PROMPT + existingHint, articlesText, signal);
  console.log("[WikiCompiler] Concept LLM raw:", raw.slice(0, 300));
  let concepts: string[] = [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Concept extraction: LLM returned no JSON array. Raw: ${raw.slice(0, 200)}`);
  concepts = JSON.parse(match[0]);
  console.log("[WikiCompiler] Extracted concepts:", concepts);

  const conceptFolder = `${outputFolder}/Concepts`;
  await ensureFolder(vault, conceptFolder);

  let created = 0;
  for (const concept of concepts) {
    if (signal?.aborted) return created;

    const searchResults = await searchSearXNG(concept, searxngBaseUrl, searxngToken);
    console.log(`[WikiCompiler] SearXNG "${concept}":`, searchResults ? `${searchResults.length} chars` : "null");
    if (!searchResults) continue;

    const langHint = outputLanguage === "zh" ? "write in Chinese (中文)" : outputLanguage === "ja" ? "write in Japanese (日本語)" : outputLanguage === "auto" ? "match the language of the concept term" : "write in English";
    const newContent = await client.complete(
      CONCEPT_PAGE_PROMPT + `\n\nLANGUAGE: ${langHint}`,
      `Concept: ${concept}\n\nSearch results:\n${searchResults}`,
      signal
    );

    // Check if a page with this name already exists anywhere in the vault
    const existingFile = vaultFileMap.get(concept.toLowerCase());
    if (existingFile) {
      const existingContent = await vault.read(existingFile);
      const updated = await updateExistingArticle(existingContent, existingFile.basename, concept, newContent, client, signal);
      if (updated !== existingContent) {
        await vault.modify(existingFile, updated);
      }
    } else {
      const safeConceptName = concept.replace(/[\\/:*?"<>|]/g, "-").trim();
      const filePath = `${conceptFolder}/${safeConceptName}.md`;
      const frontmatter = `---\ntype: concept\ngenerated: ${new Date().toISOString().slice(0, 10)}\n---\n\n`;
      const body = frontmatter + `# ${concept}\n\n${newContent}`;
      await vault.create(filePath, body);
    }
    created++;

  }

  for (const concept of concepts) {
    await injectConceptLinks(concept, articles, vault, outputFolder);
  }
  await crossLinkConcepts(vault, outputFolder);

  return created;
}

async function searchSearXNG(query: string, baseUrl: string, token: string): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await requestUrl({ url, headers });
  if (res.status !== 200) throw new Error(`SearXNG error: ${res.status}`);
  const results = (res.json.results ?? []).slice(0, 5);
  return results.map((r: any) => `**${r.title}**\n${r.content ?? r.snippet ?? ""}`).join("\n\n") || null;
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

  const regex = new RegExp(`(?<!\\[\\[)\\b${escapeRegex(concept)}\\b(?!\\]\\])`, "gi");

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
      const regex = new RegExp(`(?<!\\[\\[)\\b${escapeRegex(other)}\\b(?!\\]\\])`, "gi");
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
