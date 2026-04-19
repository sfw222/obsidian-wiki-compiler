import { App, Notice, Plugin, TFile, TFolder, Menu } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings, WikiCompilerSettingTab } from "./settings";
import { processFiles, appendLog, patchAttachmentsFromRaw, writeRunLog, ProcessResult } from "./processor";
import { ProgressModal } from "./ui/ProgressModal";
import { ResultModal } from "./ui/ResultModal";
import { QueryModal } from "./ui/QueryModal";
import { createLLMClient } from "./llm/client";
import { queryWiki } from "./wiki/query";
import { lintWiki } from "./wiki/lint";
import { extractAndEnrichConcepts, loadWikiArticlesFromVault, refreshConceptPages } from "./wiki/concepts";

export default class WikiCompilerPlugin extends Plugin {
  settings: PluginSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new WikiCompilerSettingTab(this.app, this));

    // Command: query wiki
    this.addCommand({
      id: "query-wiki",
      name: "Query Wiki",
      callback: () => {
        new QueryModal(
          this.app,
          (question) => this.runQuery(question),
          (question, answer) => this.saveQueryResult(question, answer)
        ).open();
      },
    });

    // Command: lint wiki
    this.addCommand({
      id: "lint-wiki",
      name: "Lint Wiki (health check)",
      callback: () => this.runLint(),
    });

    // Command: extract concepts (manual retry)
    this.addCommand({
      id: "extract-concepts",
      name: "Extract Concepts (retry SearXNG)",
      callback: () => this.runExtractConcepts(),
    });

    // Command: refresh existing concept pages with wiki context
    this.addCommand({
      id: "refresh-concepts",
      name: "Refresh Concept Pages (re-search with wiki context)",
      callback: () => this.runRefreshConcepts(),
    });

    // Command: patch attachments from raw
    this.addCommand({
      id: "patch-attachments",
      name: "Patch attachments from raw (no LLM)",
      callback: () => this.runPatchAttachments(),
    });

    // Command: process active file
    this.addCommand({
      id: "process-current-file",
      name: "Process current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.runOnFiles([file]);
        return true;
      },
    });

    // Command: process folder by path input
    this.addCommand({
      id: "process-folder",
      name: "Process folder (enter path)",
      callback: () => {
        const path = prompt("Enter folder path to compile:");
        if (!path) return;
        const folder = this.app.vault.getAbstractFileByPath(path);
        if (!(folder instanceof TFolder)) {
          new Notice(`Folder not found: ${path}`);
          return;
        }
        this.runOnFiles(collectFiles(folder));
      },
    });

    // Context menu on file explorer items
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (file instanceof TFile) {
          menu.addItem((item) =>
            item.setTitle("Compile to Wiki").setIcon("book-open").onClick(() => this.runOnFiles([file]))
          );
        } else if (file instanceof TFolder) {
          menu.addItem((item) =>
            item.setTitle("Compile folder to Wiki").setIcon("book-open").onClick(() => this.runOnFiles(collectFiles(file)))
          );
        }
      })
    );
  }

  async runQuery(question: string): Promise<string> {
    if (!this.settings.apiKey && this.settings.llmProvider !== "ollama") {
      throw new Error("Please set your API key in settings.");
    }
    const wikiContext = await this.loadWikiContext();
    const client = createLLMClient(this.settings);
    return queryWiki(question, wikiContext, client);
  }

  async saveQueryResult(question: string, answer: string): Promise<void> {
    const folder = `${this.settings.outputFolder}/Queries`;
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const date = new Date().toISOString().slice(0, 10);
    const safeName = question.slice(0, 40).replace(/[\\/:*?"<>|]/g, "").trim();
    const path = `${folder}/${date}-${safeName}.md`;
    const content = `# ${question}\n\n${answer}`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(path, content);
    }
    new Notice(`Query saved to ${path}`);
    await appendLog(this.app.vault, this.settings.outputFolder, "query", [question]);
  }

  async runLint(): Promise<void> {
    if (!this.settings.apiKey && this.settings.llmProvider !== "ollama") {
      new Notice("Wiki Compiler: Please set your API key in settings.");
      return;
    }
    new Notice("Wiki Compiler: Running lint...");
    try {
      const wikiContext = await this.loadWikiContext();
      const client = createLLMClient(this.settings);
      const report = await lintWiki(wikiContext, client);
      const reportPath = `${this.settings.outputFolder}/_lint-report.md`;
      const existing = this.app.vault.getAbstractFileByPath(reportPath);
      const content = `---\ngenerated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# Wiki Lint Report\n\n${report}`;
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(reportPath, content);
      }
      new Notice("Wiki Compiler: Lint complete. See _lint-report.md");
      await appendLog(this.app.vault, this.settings.outputFolder, "lint", ["_lint-report"]);
    } catch (e) {
      new Notice(`Wiki Compiler lint error: ${(e as Error).message}`);
    }
  }

  async runRefreshConcepts(): Promise<void> {
    if (!this.settings.searxngBaseUrl) {
      new Notice("Wiki Compiler: Please set SearXNG Base URL in settings.");
      return;
    }
    new Notice("Wiki Compiler: Refreshing concept pages...");
    const runStart = new Date();
    const runLog: string[] = [];
    const log = (msg: string) => {
      const ts = new Date().toISOString().slice(11, 19);
      runLog.push(`- \`${ts}\` ${msg}`);
      console.log(`[WikiCompiler] ${msg}`);
    };
    try {
      const controller = new AbortController();
      const client = createLLMClient(this.settings);
      const count = await refreshConceptPages(
        this.app.vault,
        this.settings.outputFolder,
        client,
        this.settings.searxngBaseUrl,
        this.settings.searxngToken,
        controller.signal,
        log
      );
      log(`Refresh finished. Concepts refreshed: ${count}`);
      await writeRunLog(this.app.vault, this.settings.outputFolder, runStart, runLog);
      await appendLog(this.app.vault, this.settings.outputFolder, "refresh-concepts", []);
      new Notice(`Wiki Compiler: Refreshed ${count} concept page(s).`);
    } catch (e) {
      new Notice(`Wiki Compiler refresh error: ${(e as Error).message}`);
    }
  }

  async runExtractConcepts(): Promise<void> {
    if (!this.settings.searxngBaseUrl) {
      new Notice("Wiki Compiler: Please set SearXNG Base URL in settings.");
      return;
    }
    if (!this.settings.apiKey && this.settings.llmProvider !== "ollama") {
      new Notice("Wiki Compiler: Please set your API key in settings.");
      return;
    }
    new Notice("Wiki Compiler: Extracting concepts...");
    try {
      const articles = await loadWikiArticlesFromVault(this.app.vault, this.settings.outputFolder);
      if (articles.length === 0) {
        new Notice("Wiki Compiler: No wiki articles found.");
        return;
      }
      const client = createLLMClient(this.settings);
      const controller = new AbortController();
      await extractAndEnrichConcepts(articles, this.app.vault, this.settings.outputFolder, client, this.settings.searxngBaseUrl, this.settings.searxngToken, this.settings.outputLanguage, controller.signal);
      await appendLog(this.app.vault, this.settings.outputFolder, "extract-concepts", []);
      new Notice("Wiki Compiler: Concept extraction complete.");
    } catch (e) {
      new Notice(`Wiki Compiler concept error: ${(e as Error).message}`);
    }
  }

  private async loadWikiContext(): Promise<string> {
    const indexPath = `${this.settings.outputFolder}/_index.md`;
    const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
    if (!(indexFile instanceof TFile)) return "No wiki index found.";
    const index = await this.app.vault.read(indexFile);
    // Extract linked titles from index and load up to 20 pages
    const titles = [...index.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]).slice(0, 20);
    const pages: string[] = [`## Index\n${index}`];
    for (const title of titles) {
      const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
      if (!folder || !("children" in folder)) continue;
      const file = this.findFileByTitle(title);
      if (file) {
        const text = await this.app.vault.read(file);
        pages.push(`## ${title}\n${text}`);
      }
    }
    return pages.join("\n\n---\n\n");
  }

  private findFileByTitle(title: string): TFile | null {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.outputFolder);
    if (!folder || !("children" in folder)) return null;
    let found: TFile | null = null;
    const walk = (f: any) => {
      for (const child of f.children) {
        if (child instanceof TFile && child.basename.toLowerCase() === title.toLowerCase()) {
          found = child;
          return;
        } else if ("children" in child) walk(child);
      }
    };
    walk(folder);
    return found;
  }

  async runPatchAttachments() {
    try {
      const count = await patchAttachmentsFromRaw(this.app.vault, this.settings.outputFolder);
      new Notice(`Wiki Compiler: Patched ${count} article(s) with attachment refs.`);
    } catch (e) {
      new Notice(`Wiki Compiler patch error: ${(e as Error).message}`);
    }
  }

  async runOnFiles(files: TFile[]) {
    if (files.length === 0) {
      new Notice("No markdown files found.");
      return;
    }
    if (!this.settings.apiKey && this.settings.llmProvider !== "ollama") {
      new Notice("Wiki Compiler: Please set your API key in settings.");
      return;
    }

    const modal = new ProgressModal(this.app);
    modal.open();

    try {
      const result = await processFiles(
        files,
        this.app.vault,
        this.settings,
        (done, total, current) => modal.update(done, total, current),
        modal.signal
      );
      modal.close();
      const lines = [
        `✓ ${result.articlesGenerated} article(s) generated`,
        result.articlesUpdated > 0 ? `✓ ${result.articlesUpdated} article(s) updated` : null,
        result.conceptsGenerated > 0 ? `✓ ${result.conceptsGenerated} concept(s) created` : null,
        result.errors.length > 0 ? `⚠ ${result.errors.length} error(s): ${result.errors.join("; ")}` : null,
      ].filter(Boolean).join("\n");
      new ResultModal(this.app, "Wiki Compiler", lines).open();
    } catch (e) {
      modal.close();
      if ((e as Error).name !== "AbortError") {
        new Notice(`Wiki Compiler error: ${(e as Error).message}`);
        console.error(e);
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function collectFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === "md") files.push(child);
      else if (child instanceof TFolder) walk(child);
    }
  };
  walk(folder);
  return files;
}
