#!/usr/bin/env node
/**
 * tools/backfill_structured.mjs
 *
 * Backfills structured knowledge fields (id, type, definition, summary,
 * facts, relations, faq, tags) into existing wiki articles compiled
 * before the enterprise KB upgrade.
 *
 * Reads LLM provider settings from the Obsidian plugin data file.
 * Writes updated frontmatter in-place (body content is preserved).
 *
 * Usage:
 *   node tools/backfill_structured.mjs              # process all old articles
 *   node tools/backfill_structured.mjs --limit 5    # process first 5 only (test)
 *   node tools/backfill_structured.mjs --dry-run    # preview without writing
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const SETTINGS_PATH = "F:/mynote/.obsidian/plugins/wiki-compiler/data.json";
const WIKI_PATH     = "F:/mynote/Wiki/Wiki";

const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT   = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ── Load plugin settings ──────────────────────────────────────────────────────

let settings;
try {
  settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
} catch (e) {
  console.error("Cannot read plugin settings from", SETTINGS_PATH);
  console.error(e.message);
  process.exit(1);
}

// ── Structured extraction prompt ──────────────────────────────────────────────

function makeSystemPrompt(lang) {
  const langInstr =
    lang === "zh"  ? "write in Chinese (中文)" :
    lang === "en"  ? "write in English" :
    lang === "ja"  ? "write in Japanese (日本語)" :
    "match the language of the article";

  return `You are a knowledge analyst. Given a wiki article, extract structured knowledge in strict JSON format.

You MUST return ONLY a valid JSON object. No explanation, no markdown fences.

Required JSON shape:
{
  "type": "Concept",
  "definition": "One sentence definition of the main topic.",
  "summary": "2-3 sentence summary of the article's core knowledge.",
  "facts": [
    {"name": "fact name", "value": "fact value", "source": ""}
  ],
  "relations": [
    {"predicate": "depends_on", "target": "[[Target Title]]", "source": ""}
  ],
  "faq": [
    {"question": "Common question?", "answer": "Clear answer.", "source": "", "status": "ai-inferred"}
  ]
}

Rules:
- type: MUST be exactly one of: Concept, Process, Policy, Metric, Task, Other
- definition: one concise sentence only
- summary: 2-3 sentences max
- facts: 2-5 most important structured facts. name should be a short label
- relations: 2-5 explicit relations. predicate must be one of: is_a, part_of, depends_on, uses, owned_by, related_to, enables, supports, has_metric, alternative_to. target MUST use [[Title]] wikilink format
- faq: 1-3 most likely user questions. status always "ai-inferred"
- LANGUAGE: ${langInstr}`;
}

// ── LLM API call ──────────────────────────────────────────────────────────────

async function callLLM(systemPrompt, userContent) {
  const { llmProvider, apiKey, model, ollamaBaseUrl, customBaseUrl, customCompatibility } = settings;

  if (llmProvider === "openai" ||
     (llmProvider === "custom" && customCompatibility !== "anthropic")) {
    const url = llmProvider === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : customBaseUrl;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent },
        ],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI error ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = await resp.json();
    return json.choices?.[0]?.message?.content ?? "";
  }

  if (llmProvider === "anthropic" ||
     (llmProvider === "custom" && customCompatibility === "anthropic")) {
    const url = llmProvider === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : customBaseUrl;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-opus-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic error ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = await resp.json();
    return json.content?.find(b => b.type === "text")?.text ?? "";
  }

  if (llmProvider === "ollama") {
    const base = (ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
    const resp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || "llama3",
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`Ollama error ${resp.status}`);
    const json = await resp.json();
    return json.message?.content ?? "";
  }

  throw new Error(`Unsupported provider: ${llmProvider}`);
}

// ── Robust JSON extraction (mirrors generator.ts parseJsonFromLLM) ─────────────

function parseJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let inStr = false, esc = false, depth = 0;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"' && !esc) inStr = !inStr;
      esc = (ch === '\\' && !esc);
      if (!inStr) {
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  const cb = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (cb) try { return JSON.parse(cb[1].trim()); } catch {}
  const first = raw.indexOf("{"), last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  return null;
}

// ── Frontmatter parser (extracts flat key/value, preserves raw block) ─────────

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fm: {}, fmEnd: 0, body: content };
  const fmEnd = match[0].length;
  const body  = content.slice(fmEnd);
  const fm    = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w_-]+):\s*(.*)/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, fmEnd, body };
}

// ── Build complete frontmatter block ──────────────────────────────────────────

function buildFrontmatter(fm, structured, title) {
  const today      = new Date().toISOString().slice(0, 10);
  const id         = title.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "");
  const type       = structured?.type ?? "Other";
  const status     = structured ? "verified" : "draft";
  const category   = fm.category || "Others";
  const source     = fm.source   ? `"[[${fm.source.replace(/^\[\[|\]\]$/g, "")}]]"` : '""';
  const sourceMtime = fm.source_mtime || "0";
  const created    = fm.created || fm.generated || today;
  const sourceRaw  = fm.source || "";

  const factSrc  = sourceRaw ? `"[[${sourceRaw.replace(/^\[\[|\]\]$/g, "")}]]"` : '""';

  const factsYaml = structured?.facts?.length > 0
    ? "facts:\n" + structured.facts.map(f =>
        `  - name: ${JSON.stringify(f.name)}\n` +
        `    value: ${JSON.stringify(f.value)}\n` +
        `    source: ${f.source ? JSON.stringify(f.source) : factSrc}`
      ).join("\n")
    : "facts: []";

  const relationsYaml = structured?.relations?.length > 0
    ? "relations:\n" + structured.relations.map(r =>
        `  - predicate: ${JSON.stringify(r.predicate)}\n` +
        `    target: ${JSON.stringify(r.target)}\n` +
        `    source: ${r.source ? JSON.stringify(r.source) : factSrc}`
      ).join("\n")
    : "relations: []";

  const faqYaml = structured?.faq?.length > 0
    ? "faq:\n" + structured.faq.map(q =>
        `  - question: ${JSON.stringify(q.question)}\n` +
        `    answer: ${JSON.stringify(q.answer)}\n` +
        `    source: ${q.source ? JSON.stringify(q.source) : factSrc}\n` +
        `    status: "ai-inferred"`
      ).join("\n")
    : "faq: []";

  const tags = [
    JSON.stringify(`type/${type}`),
    JSON.stringify(`cat/${category}`),
    JSON.stringify(`status/${status}`),
  ].join(", ");

  return [
    "---",
    `id: ${JSON.stringify(id)}`,
    `title: ${JSON.stringify(title)}`,
    `type: ${type}`,
    `category: ${category}`,
    `status: ${status}`,
    `source: ${source}`,
    `source_mtime: ${sourceMtime}`,
    `created: ${created}`,
    `updated: ${today}`,
    `lastReviewed: ${today}`,
    `reviewer: ""`,
    `definition: ${JSON.stringify(structured?.definition ?? "")}`,
    `summary: ${JSON.stringify(structured?.summary ?? "")}`,
    `search_context: ""`,
    `tags: [${tags}]`,
    factsYaml,
    relationsYaml,
    faqYaml,
    "---",
    "",
  ].join("\n");
}

// ── File walker ───────────────────────────────────────────────────────────────

const SKIP_FILES = new Set(["_index.md", "_log.md", "_lint-report.md"]);

function walkMd(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkMd(full));
    } else if (extname(entry) === ".md" && !SKIP_FILES.has(entry)) {
      results.push(full);
    }
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Wiki Backfill Structured Knowledge ===");
  console.log(`Provider : ${settings.llmProvider} / ${settings.model || "(default)"}`);
  console.log(`Wiki path: ${WIKI_PATH}`);
  if (DRY_RUN) console.log("Mode     : DRY RUN (no files written)");

  let files;
  try {
    files = walkMd(WIKI_PATH);
  } catch (e) {
    console.error("Cannot read wiki path:", e.message);
    process.exit(1);
  }
  console.log(`\nTotal articles found : ${files.length}`);

  // Articles needing backfill = those without a 'facts:' line in frontmatter
  const toProcess = files.filter(f => {
    const content = readFileSync(f, "utf8");
    return !content.match(/^facts:/m);
  });

  console.log(`Need backfill        : ${toProcess.length}`);

  const limited = toProcess.slice(0, LIMIT);
  if (limited.length < toProcess.length) {
    console.log(`Processing (--limit) : ${limited.length}`);
  }
  console.log("");

  const systemPrompt = makeSystemPrompt(settings.outputLanguage || "auto");
  let done = 0, failed = 0, skipped = 0;

  for (const filePath of limited) {
    const rawContent = readFileSync(filePath, "utf8");
    const { fm, body } = parseFrontmatter(rawContent);
    const title = fm.title || filePath.split(/[/\\]/).pop().replace(/\.md$/, "");

    process.stdout.write(`[${done + failed + skipped + 1}/${limited.length}] ${title.slice(0, 50).padEnd(52)}`);

    let structured = null;
    try {
      const userMsg = `Article title: ${title}\n\nArticle content:\n${body.slice(0, 6000)}`;
      let raw = await callLLM(systemPrompt, userMsg);
      structured = parseJson(raw);

      if (!structured) {
        // one retry with stricter instruction
        raw = await callLLM(systemPrompt,
          userMsg + "\n\nReturn ONLY valid JSON starting with '{' and ending with '}'.");
        structured = parseJson(raw);
      }
    } catch (e) {
      console.log(`FAILED  (${e.message.slice(0, 80)})`);
      failed++;
      continue;
    }

    if (!structured) {
      console.log("SKIPPED (LLM returned no valid JSON after retry)");
      skipped++;
      continue;
    }

    const newFrontmatter = buildFrontmatter(fm, structured, title);
    const newContent     = newFrontmatter + body;

    if (!DRY_RUN) {
      writeFileSync(filePath, newContent, "utf8");
    }

    const factsCount = structured.facts?.length ?? 0;
    console.log(`OK      (${factsCount} facts, type=${structured.type})`);
    done++;

    // Gentle rate-limit pause
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Updated : ${done}`);
  console.log(`Skipped : ${skipped}  (LLM parse failed)`);
  console.log(`Failed  : ${failed}   (API/network error)`);
  if (DRY_RUN) console.log("(Dry run — no files were actually written)");
}

main().catch(e => { console.error(e); process.exit(1); });
