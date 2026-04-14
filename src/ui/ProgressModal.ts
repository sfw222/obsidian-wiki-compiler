import { App, Modal } from "obsidian";

export class ProgressModal extends Modal {
  private statusEl: HTMLElement;
  private abortController: AbortController;
  public signal: AbortSignal;

  constructor(app: App) {
    super(app);
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Wiki Compiler" });
    this.statusEl = contentEl.createEl("p", { text: "Starting..." });
    const btn = contentEl.createEl("button", { text: "Cancel" });
    btn.onclick = () => {
      this.abortController.abort();
      this.close();
    };
  }

  update(done: number, total: number, current: string) {
    if (done >= total && total > 0) {
      this.statusEl.setText(`${current}...`);
    } else {
      this.statusEl.setText(`Processing ${done + 1}/${total}: "${current}"...`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
