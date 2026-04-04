import { App, Notice, Plugin, TFile, TFolder, Menu } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings, WikiCompilerSettingTab } from "./settings";
import { processFiles } from "./processor";
import { ProgressModal } from "./ui/ProgressModal";

export default class WikiCompilerPlugin extends Plugin {
  settings: PluginSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new WikiCompilerSettingTab(this.app, this));

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
      await processFiles(
        files,
        this.app.vault,
        this.settings,
        (done, total, current) => modal.update(done, total, current),
        modal.signal
      );
      modal.close();
      new Notice(`Wiki Compiler: Done! ${files.length} note(s) compiled to "${this.settings.outputFolder}".`);
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
