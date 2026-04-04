import { TFile, Vault } from "obsidian";
import { PluginSettings } from "./settings";
import { createLLMClient } from "./llm/client";
import { generateArticle, WikiArticle } from "./wiki/generator";
import { injectBidirectionalLinks } from "./wiki/linker";
import { categoryPath, sanitizeFolderName } from "./wiki/classifier";

const PROCESSED_SUFFIX = ".wikied";

export async function processFiles(
  files: TFile[],
  vault: Vault,
  settings: PluginSettings,
  onProgress: (done: number, total: number, current: string) => void,
  signal: AbortSignal
): Promise<void> {
  const client = createLLMClient(settings);
  const results: WikiArticle[] = [];
  let done = 0;

  // Collect existing categories and titles from Wiki output folder
  const existingCategories = getExistingCategories(vault, settings.outputFolder);
  const existingTitles = await getExistingTitles(vault, settings.outputFolder);

  // Skip already-processed files
  const pending = files.filter((f) => !f.basename.endsWith(PROCESSED_SUFFIX));

  const semaphore = new Semaphore(settings.maxConcurrent);
  await Promise.all(
    pending.map((file) =>
      semaphore.run(async () => {
        if (signal.aborted) return;
        onProgress(done, pending.length, file.basename);
        const content = await vault.read(file);
        const article = await generateArticle(file.basename, content, client, settings, signal, existingCategories, existingTitles);
        results.push({ ...article, sourceFile: file.path });

        // Rename source file to mark as processed
        const newPath = file.path.replace(/\.md$/, `${PROCESSED_SUFFIX}.md`);
        await vault.rename(file, newPath);

        done++;
        onProgress(done, pending.length, file.basename);
      })
    )
  );

  if (signal.aborted) return;

  const linked = injectBidirectionalLinks(results);
  await writeArticles(linked, vault, settings);
  // Update existing related articles with backlinks to new articles
  await updateExistingBacklinks(linked, vault, settings.outputFolder);
}

async function writeArticles(articles: WikiArticle[], vault: Vault, settings: PluginSettings): Promise<void> {
  // Ensure output root exists
  await ensureFolder(vault, settings.outputFolder);

  // Track used filenames to avoid collisions
  const usedPaths = new Set<string>();

  for (const article of articles) {
    const catPath = categoryPath(settings.outputFolder, article.category);
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

  await writeIndex(articles, vault, settings.outputFolder);
}

async function writeIndex(articles: WikiArticle[], vault: Vault, outputFolder: string): Promise<void> {
  // Load existing index entries
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

async function updateExistingBacklinks(newArticles: WikiArticle[], vault: Vault, outputFolder: string): Promise<void> {
  // Build map: existing file title → file path
  const folder = vault.getAbstractFileByPath(outputFolder);
  if (!folder || !("children" in folder)) return;
  const fileMap = new Map<string, TFile>();
  const walk = (f: any) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === "md" && child.basename !== "_index") {
        fileMap.set(child.basename.toLowerCase(), child);
      } else if ("children" in child) walk(child);
    }
  };
  walk(folder);

  for (const newArt of newArticles) {
    for (const related of newArt.relatedTopics) {
      const existingFile = fileMap.get(related.toLowerCase());
      if (!existingFile) continue;
      let text = await vault.read(existingFile);
      const backlink = `- [[${newArt.title}]]`;
      if (text.includes(backlink)) continue;
      if (text.includes("## See Also")) {
        text = text.replace("## See Also", `## See Also\n${backlink}`);
      } else {
        text += `\n\n## See Also\n${backlink}`;
      }
      await vault.modify(existingFile, text);
    }
  }
}

function getExistingCategories(vault: Vault, outputFolder: string): string[] {  const folder = vault.getAbstractFileByPath(outputFolder);
  if (!folder || !("children" in folder)) return [];
  return (folder as any).children
    .filter((c: any) => "children" in c)
    .map((c: any) => c.name)
    .filter((name: string) => name !== "_index");
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
