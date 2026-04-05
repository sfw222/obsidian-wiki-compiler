import { TFile, Vault } from "obsidian";
import { PluginSettings } from "./settings";
import { createLLMClient } from "./llm/client";
import { generateArticle, updateExistingArticle, WikiArticle } from "./wiki/generator";
import { injectBidirectionalLinks } from "./wiki/linker";
import { categoryPath, sanitizeFolderName } from "./wiki/classifier";
import { extractAndEnrichConcepts } from "./wiki/concepts";

const RAW_FOLDER = "raw";
const WIKI_SUBFOLDER = "Wiki";

export interface ProcessResult {
  articlesGenerated: number;
  articlesUpdated: number;
  conceptsGenerated: number;
  errors: string[];
}

export async function processFiles(
  files: TFile[],
  vault: Vault,
  settings: PluginSettings,
  onProgress: (done: number, total: number, current: string) => void,
  signal: AbortSignal
): Promise<ProcessResult> {
  const client = createLLMClient(settings);
  const results: WikiArticle[] = [];
  const errors: string[] = [];
  let done = 0;

  const existingTitles = await getExistingTitles(vault, settings.outputFolder);

  const rawPrefix = `${settings.outputFolder}/${RAW_FOLDER}/`;
  const pending = files.filter((f) => !f.path.startsWith(rawPrefix));

  const semaphore = new Semaphore(settings.maxConcurrent);
  await Promise.all(
    pending.map((file) =>
      semaphore.run(async () => {
        if (signal.aborted) return;
        onProgress(done, pending.length, file.basename);
        try {
          const content = await vault.read(file);
          const article = await generateArticle(file.basename, content, client, settings, signal, existingTitles);
          results.push({ ...article, sourceFile: file.path });

          const rawFolder = `${settings.outputFolder}/${RAW_FOLDER}`;
          await ensureFolder(vault, rawFolder);
          const rawPath = `${rawFolder}/${file.name}`;
          await vault.rename(file, rawPath);
        } catch (e) {
          errors.push(`${file.basename}: ${(e as Error).message}`);
        }
        done++;
        onProgress(done, pending.length, file.basename);
      })
    )
  );

  if (signal.aborted) return { articlesGenerated: 0, articlesUpdated: 0, conceptsGenerated: 0, errors };

  const linked = injectBidirectionalLinks(results);
  await writeArticles(linked, vault, settings);

  let articlesUpdated = 0;
  try {
    articlesUpdated = await incrementallyUpdateRelated(linked, vault, settings.outputFolder, client, signal);
  } catch (e) {
    errors.push(`Incremental update: ${(e as Error).message}`);
  }

  await appendLog(vault, settings.outputFolder, "ingest", linked.map((a) => a.title));

  let conceptsGenerated = 0;
  try {
    conceptsGenerated = await extractAndEnrichConcepts(linked, vault, settings.outputFolder, client, settings.searxngBaseUrl, settings.searxngToken, settings.outputLanguage, signal);
  } catch (e) {
    console.error("[WikiCompiler] Concept extraction error:", e);
    errors.push(`Concept extraction: ${(e as Error).message}`);
  }

  return { articlesGenerated: linked.length, articlesUpdated, conceptsGenerated, errors };
}

async function writeArticles(articles: WikiArticle[], vault: Vault, settings: PluginSettings): Promise<void> {
  const wikiFolder = `${settings.outputFolder}/${WIKI_SUBFOLDER}`;
  await ensureFolder(vault, settings.outputFolder);
  await ensureFolder(vault, wikiFolder);

  // Track used filenames to avoid collisions
  const usedPaths = new Set<string>();

  for (const article of articles) {
    const catPath = categoryPath(wikiFolder, article.category);
    await ensureFolder(vault, catPath);

    const baseName = sanitizeFolderName(article.title) || "Untitled";
    let filePath = `${catPath}/${baseName}.md`;
    let suffix = 2;
    while (usedPaths.has(filePath)) {
      filePath = `${catPath}/${baseName}_${suffix++}.md`;
    }
    usedPaths.add(filePath);

    const frontmatter = `---\nsource: "[[${article.sourceFile}]]"\ncategory: ${article.category}\ngenerated: ${new Date().toISOString().slice(0, 10)}\n---\n\n`;
    const body = article.content.startsWith("#") ? article.content : `# ${article.title}\n\n${article.content}`;

    const existing = vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await vault.modify(existing, frontmatter + body);
    } else {
      await vault.create(filePath, frontmatter + body);
    }
  }

  await writeIndex(articles, vault, settings.outputFolder, wikiFolder);
}

async function writeIndex(articles: WikiArticle[], vault: Vault, outputFolder: string, wikiFolder: string): Promise<void> {
  const indexPath = `${outputFolder}/_index.md`;
  const existingFile = vault.getAbstractFileByPath(indexPath);
  const existingEntries = new Map<string, Set<string>>(); // category → set of "[[title]]"

  if (existingFile instanceof TFile) {
    const text = await vault.read(existingFile);
    let currentCat = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("## ")) currentCat = line.slice(3).trim();
      else if (line.startsWith("- [[") && currentCat) {
        if (!existingEntries.has(currentCat)) existingEntries.set(currentCat, new Set());
        existingEntries.get(currentCat)!.add(line.slice(2).trim());
      }
    }
  }

  // Merge new articles
  for (const a of articles) {
    if (!existingEntries.has(a.category)) existingEntries.set(a.category, new Set());
    existingEntries.get(a.category)!.add(`[[${a.title}]]`);
  }

  // Render hierarchical index
  let index = "# Wiki Index\n\n";
  for (const [cat, items] of [...existingEntries.entries()].sort()) {
    index += `## ${cat}\n${[...items].sort().map((t) => `- ${t}`).join("\n")}\n\n`;
  }

  if (existingFile instanceof TFile) {
    await vault.modify(existingFile, index);
  } else {
    await vault.create(indexPath, index);
  }
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  if (!vault.getAbstractFileByPath(path)) {
    await vault.createFolder(path);
  }
}

async function getExistingTitles(vault: Vault, outputFolder: string): Promise<string[]> {
  const indexPath = `${outputFolder}/_index.md`;
  const indexFile = vault.getAbstractFileByPath(indexPath);
  if (!(indexFile instanceof TFile)) return [];
  const text = await vault.read(indexFile);
  const titles: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- \[\[(.+?)\]\]/);
    if (m) titles.push(m[1]);
  }
  return titles;
}

async function incrementallyUpdateRelated(
  newArticles: WikiArticle[],
  vault: Vault,
  outputFolder: string,
  client: ReturnType<typeof createLLMClient>,
  signal: AbortSignal
): Promise<number> {
  const folder = vault.getAbstractFileByPath(outputFolder);
  if (!folder || !("children" in folder)) return 0;

  const fileMap = new Map<string, TFile>();
  const walk = (f: any) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === "md" && child.basename !== "_index") {
        fileMap.set(child.basename.toLowerCase(), child);
      } else if ("children" in child) walk(child);
    }
  };
  walk(folder);

  let updated = 0;
  for (const newArt of newArticles) {
    for (const related of newArt.relatedTopics) {
      if (signal.aborted) return updated;
      const existingFile = fileMap.get(related.toLowerCase());
      if (!existingFile) continue;
      const existingContent = await vault.read(existingFile);
      const newContent = await updateExistingArticle(existingContent, existingFile.basename, newArt.title, newArt.content, client, signal);
      if (newContent !== existingContent) {
        await vault.modify(existingFile, newContent);
        updated++;
      }
    }
  }
  return updated;
}


export async function appendLog(vault: Vault, outputFolder: string, operation: string, items: string[]): Promise<void> {
  const logPath = `${outputFolder}/_log.md`;
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entry = `- ${timestamp} **${operation}**: ${items.map((t) => `[[${t}]]`).join(", ")}\n`;
  const existing = vault.getAbstractFileByPath(logPath);
  if (existing instanceof TFile) {
    const text = await vault.read(existing);
    await vault.modify(existing, text + entry);
  } else {
    await vault.create(logPath, `# Wiki Activity Log\n\n${entry}`);
  }
}

class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.running++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          this.running--;
          if (this.queue.length > 0) this.queue.shift()!();
        }
      };
      if (this.running < this.max) execute();
      else this.queue.push(execute);
    });
  }
}
