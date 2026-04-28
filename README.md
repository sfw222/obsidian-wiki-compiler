# Obsidian Wiki Compiler

> Inspired by [Andrej Karpathy's LLM Knowledge Bases](https://x.com/karpathy/status/2039805659525644595) concept.

Transform your Obsidian notes into a structured, interconnected Wiki using LLMs. Select a note or folder, and the plugin compiles encyclopedic articles with bidirectional `[[wikilinks]]`, auto-categorized into subdirectories. It also extracts key concepts via web search and enriches your knowledge base automatically.

[中文文档](README.zh-CN.md)

---

## Features

- **One-click compilation** — right-click any note or folder → "Compile to Wiki"
- **Recursive folder processing** — processes all `.md` files in subdirectories
- **Smart categorization** — LLM assigns articles to your custom category list; falls back to the last entry if no match
- **Customizable categories** — define your own category list in Settings; auto-updates when you switch output language
- **Structured knowledge extraction** — a second LLM pass independently extracts `facts[]`, `relations[]`, `faq[]`, `definition`, and `summary` from each generated article; failure never blocks the main article; articles with successful extraction are marked `status: verified`
- **Auto-derived tags** — `tags` are automatically populated from article metadata as `type/<Type>`, `cat/<Category>`, `status/<Status>`, enabling Obsidian's native Tag panel to filter by article type, category, and review status without manual tagging
- **Bidirectional wikilinks** — new articles link to existing ones via both `relatedTopics` and `relations[].target`; existing articles are incrementally updated with relevant new knowledge
- **Concept extraction** — automatically extracts high-frequency concepts across articles, enriches them via SearXNG web search, generates dedicated concept pages with standard structured frontmatter, and injects bidirectional links after all pages are created; already-existing concept pages are skipped via code-side filtering (no extra LLM tokens)
- **Concept page refresh** — re-search all existing concept pages using context derived from which wiki articles mention each concept, enabling automatic disambiguation; useful for improving pages that were generated without sufficient domain context
- **Patch attachments** — retroactively finds attachment references (`![[...]]`) in archived raw notes and appends them to the corresponding wiki articles; does not require LLM
- **Wiki query** — structured pre-retrieval first matches your question against `facts`, `faq`, and `relations` fields before passing context to the LLM; answers use academic-style numbered citations `[1][2]`; click citation numbers to jump to references; copy answer to clipboard; results saved as query notes
- **Wiki lint** — two-stage health check with progress modal and cancel support: (1) code-level static analysis with no LLM cost — detects missing `source` fields, facts/relations without source, articles overdue for review (auto-flagged as `needs-review`), and orphan pages; (2) LLM analysis for contradictions, missing concepts, stale content, and actionable fix suggestions. After completion, `_lint-report.md` is opened automatically. The latest lint always updates `_lint-report.md`, while full per-run details are preserved in `_runs/` and referenced from `_log.md`.
- **Source archival** — processed notes are moved to `raw/` folder to avoid reprocessing
- **Cumulative index** — `_index.md` merges all articles across sessions, organized by category
- **Activity log** — `_log.md` tracks all operations (ingest, query, lint, concept extraction); detailed per-run logs with step-by-step timing are saved to `_runs/`
- **Progress UI** — real-time progress modal with cancel support
- **Multi-provider LLM support** — OpenAI, Anthropic (Claude), Ollama (local), or any custom third-party API; zero third-party SDK dependencies (native `requestUrl` only)

---

## Installation

### Manual (recommended until plugin is in community store)

1. Download the [latest release](https://github.com/colin4k/obsidian-wiki-compiler/releases) (`main.js`, `manifest.json`, `styles.css`)
2. Copy the three files to your vault:
   ```
   <your-vault>/.obsidian/plugins/wiki-compiler/
   ```
3. In Obsidian: **Settings → Community Plugins → Enable** "Wiki Compiler"

### Build from source

```bash
git clone https://github.com/colin4k/obsidian-wiki-compiler.git
cd obsidian-wiki-compiler
npm install
npm run build
# Copy main.js + manifest.json + styles.css to your vault's plugin folder
```

---

## Configuration

Open **Settings → Wiki Compiler**:

| Setting | Description | Default |
|---------|-------------|---------|
| LLM Provider | OpenAI / Anthropic / Ollama / Custom | OpenAI |
| API Key | Your API key (not needed for Ollama) | — |
| Model | Model name | gpt-4o |
| Output Folder | Where Wiki articles are saved | `Wiki` |
| Output Language | auto / zh / en / ja | auto |
| Categories | One per line; last entry is the fallback | (language defaults) |
| Max Concurrent | Parallel requests (1–10) | 3 |
| SearXNG Base URL | URL of your SearXNG instance for concept enrichment | — |
| SearXNG Token | Optional Bearer token for authenticated SearXNG | — |
| Enable Structured Extraction | Run a second LLM pass to extract facts, relations, FAQ, definition, and summary | enabled |
| Review Interval Days | Articles not reviewed within this many days are flagged `needs-review` by lint | 90 |
### Default categories (English)

Below are the plugin's default English categories (synchronized from the user's note index). The last entry is the fallback category used when the LLM cannot match any category.

Single-line copyable list:

```
Astronomy, Earth Sciences, Physics, Chemistry, History, Philosophy, Engineering, Military, Education, Mathematics, Literature, Biology, Sociology, Economics, Art, Computer Science, Artificial Intelligence, Game Development, Game Design, Linguistics, Others
```

Multi-line:

- Astronomy
- Earth Sciences
- Physics
- Chemistry
- History
- Philosophy
- Engineering
- Military
- Education
- Mathematics
- Literature
- Biology
- Sociology
- Economics
- Art
- Computer Science
- Artificial Intelligence
- Game Development
- Game Design
- Linguistics
- Others


### Custom (third-party) provider

Set **LLM Provider** to "Custom", then configure:
- **Custom Endpoint URL** — full endpoint URL, e.g. `https://api.deepseek.com/v1/chat/completions`
- **API Compatibility** — OpenAI-compatible or Anthropic-compatible
- **API Key** and **Model**

---

## Usage

### Process a single note

Right-click any `.md` file in the file explorer → **Compile to Wiki**

Or use the command palette: `Wiki Compiler: Process current file`

### Process a folder

Right-click any folder → **Compile folder to Wiki**

Or use the command palette: `Wiki Compiler: Process folder (enter path)`

All `.md` files in subdirectories are included recursively.

### Query your Wiki

Command palette: `Wiki Compiler: Query Wiki`

A modal opens where you can ask questions. The LLM answers based on your wiki content with academic-style numbered citations — `[1]`, `[2]` in the body, with a **References** section at the end listing the cited wiki pages. Click any citation number to jump to its reference. Click **Copy** to copy the raw answer to clipboard, or **Save to Wiki** to persist the Q&A as a note in `Wiki/Queries/`.

### Lint (health check)

Command palette: `Wiki Compiler: Lint Wiki (health check)`

Shows a staged progress modal during linting and supports cancellation.

Generates (or updates) `_lint-report.md` covering:
- Contradictions between pages
- Orphan pages with no incoming links
- Missing concepts that deserve their own page
- Stale or outdated content

Notes:
- The latest lint result overwrites `_lint-report.md`.
- Full execution history is kept in `_runs/` and linked from `_log.md`.
- The report file is opened automatically after lint completes.

### Refresh concept pages

Command palette: `Wiki Compiler: Refresh Concept Pages (re-search with wiki context)`

Re-searches all existing concept pages. For each concept, the plugin finds which wiki articles mention it and uses their titles as a domain context hint when querying SearXNG — automatically disambiguating concepts that share names across unrelated fields. Does not require LLM.

### Patch attachments from raw

Command palette: `Wiki Compiler: Patch attachments from raw (no LLM)`

Retroactively adds attachment references found in archived raw notes to their corresponding wiki articles. Run this if attachments were missed during initial processing. Does not require LLM.

### Extract concepts

Command palette: `Wiki Compiler: Extract Concepts (retry SearXNG)`

Manually triggers concept extraction. Requires SearXNG to be configured. The plugin identifies high-frequency concepts across articles, searches the web for authoritative information, and generates dedicated concept pages with `[[wikilinks]]` injected back into related articles.

### Output structure

```
Wiki/
├── Wiki/                      ← generated articles by category
│   ├── Machine Learning/
│   │   ├── Transformer.md
│   │   └── Neural Networks.md
│   └── Finance/
│       └── IPO Process.md
├── Concepts/                  ← auto-generated concept pages
│   ├── Attention Mechanism.md
│   └── Gradient Descent.md
├── raw/                       ← original source notes (archived)
├── Queries/                   ← saved query results
├── _runs/                     ← per-run detailed logs (timestamped)
├── _index.md                  ← cumulative article index
├── _log.md                    ← activity log
└── _lint-report.md            ← latest lint report (updated each run)
```

Each article includes:
- Frontmatter: `id`, `title`, `type`, `category`, `status`, `source`, `source_mtime`, `created`, `updated`, `lastReviewed`, `definition`, `summary`, `tags` (auto-derived), `facts[]`, `relations[]`, `faq[]`
- Encyclopedic content with `[[wikilinks]]`
- `## See Also` section with bidirectional links (merged from `relatedTopics` and `relations[].target`)
- `## Attachments` section (when the source note contained embedded files)

---

## How it works

1. **Generate (Phase 1)** — Each source note is sent to the LLM, which produces a structured wiki article with title, category, content, and related topics
2. **Extract (Phase 2)** — A second independent LLM call extracts `facts[]`, `relations[]`, `faq[]`, `definition`, and `summary` for each article; failure here never blocks Phase 1 results; successful extraction sets `status: verified`
3. **Link** — Bidirectional `[[wikilinks]]` are injected across all new articles from both `relatedTopics` and `relations[].target`; a `## See Also` section is added
4. **Update** — Existing wiki articles mentioned in related topics are incrementally updated via LLM to incorporate new knowledge
5. **Archive** — Source notes are moved to `raw/` to prevent reprocessing
6. **Index** — `_index.md` is updated with new entries, organized by category
7. **Enrich** — If SearXNG is configured, high-frequency concepts are extracted, searched on the web, and turned into dedicated concept pages with structured frontmatter; already-existing concepts are skipped automatically
8. **Log** — A timestamped run log is saved to `_runs/` with per-step details for every compilation run

---

## License

MIT
