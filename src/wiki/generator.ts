import { LLMClient } from "../llm/client";
import { PluginSettings, getFallbackCategory } from "../settings";

export interface WikiArticle {
  sourceFile: string;
  title: string;
  category: string;
  content: string;
  relatedTopics: string[];
}

const SYSTEM_PROMPT = `You are a knowledge base wiki writer. Given a personal note, extract the core knowledge and write a comprehensive encyclopedic wiki article.

You MUST return ONLY a valid JSON object. No explanation, no markdown fences, no extra text — just the raw JSON.

Required JSON shape:
{
  "title": "Concise encyclopedic topic title (NOT the original note filename)",
  "category": "One of the allowed categories listed below",
  "content": "## Overview\\n\\nFull encyclopedic article with multiple ## sections, rich detail, third-person voice. Use [[concept name]] for key cross-references. Minimum 200 words.",
  "relatedTopics": ["Related Topic 1", "Related Topic 2"]
}

Rules:
- title: derive a meaningful topic name from the content, NOT the filename. Plain text only — NO [[wikilinks]] in the title field
- category: MUST be exactly one of: [{CATEGORIES}]. Do NOT invent new categories. If none fits, use "{FALLBACK}".
- content: must be substantive with ## headings and real knowledge extracted from the note
- relatedTopics: include titles from the existing wiki articles below if relevant, plus any new concepts{EXISTING_HINT}
- LANGUAGE: {LANGUAGE}`;

function languageInstruction(lang: string): string {
  if (lang === "auto") return "match the language of the source note";
  if (lang === "zh") return "write in Chinese (中文)";
  if (lang === "en") return "write in English";
  if (lang === "ja") return "write in Japanese (日本語)";
  return `write in ${lang}`;
}

function parseJsonFromLLM(raw: string): any | null {
  if (!raw || typeof raw !== "string") return null;

  // Try to find a balanced top-level JSON object by scanning for '{' and matching braces,
  // while being aware of quoted strings and escape characters.
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let inString = false;
    let escape = false;
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"' && !escape) {
        inString = !inString;
      }
      if (ch === "\\" && !escape) {
        escape = true;
      } else {
        escape = false;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = raw.slice(start, i + 1);
            try {
              return JSON.parse(candidate);
            } catch {
              // fallthrough to try next possible candidate
              break;
            }
          }
        }
      }
    }
  }

  // Try ```json code block``` extraction
  const codeBlock = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (codeBlock && codeBlock[1]) {
    try {
      return JSON.parse(codeBlock[1].trim());
    } catch {}
  }

  // Try any simple {...} regex matches as a last-ditch attempt
  const matches = raw.match(/\{[\s\S]*?\}/g);
  if (matches) {
    for (const m of matches) {
      try {
        return JSON.parse(m);
      } catch {}
    }
  }

  // Try from first { to last } as a final attempt
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }

  return null;
}

export async function generateArticle(
  sourceFile: string,
  content: string,
  client: LLMClient,
  settings: PluginSettings,
  signal?: AbortSignal,
  existingTitles: string[] = []
): Promise<WikiArticle> {
  const fallback = getFallbackCategory(settings.outputLanguage === "auto" ? "en" : settings.outputLanguage);
  const categories = settings.categories.length > 0 ? settings.categories : [fallback];
  const existingHint = existingTitles.length > 0
    ? `\nExisting wiki articles: ${existingTitles.slice(0, 80).join(", ")}`
    : "";
  const systemPrompt = SYSTEM_PROMPT
    .replace("{LANGUAGE}", languageInstruction(settings.outputLanguage))
    .replace("{CATEGORIES}", categories.join(", "))
    .replace("{FALLBACK}", fallback)
    .replace("{EXISTING_HINT}", existingHint);

  let raw = await client.complete(systemPrompt, `Source note title: ${sourceFile}\n\n${content}`, signal);

  const allowedLower = new Set(categories.map((c) => c.toLowerCase()));

  try {
    let parsed = parseJsonFromLLM(raw);
    if (!parsed) {
      console.log("generateArticle: initial parse failed; starting retries");
      // Retry up to 2 times with a stricter instruction and some context from the previous output
      for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
        console.log(`generateArticle: retry #${attempt}`);
        const strictInstruction = `\n\nIMPORTANT: Respond with STRICT JSON ONLY. Return exactly one JSON object and NOTHING ELSE. Do NOT include markdown fences, explanations, or any surrounding text. The response MUST start with '{' and end with '}'.`;
        const contextSnippet = raw ? raw.slice(0, 2000) : "";
        const userMsg = `Previous model output (for context):\n${contextSnippet}\n\nPlease re-generate ONLY the valid JSON object according to the schema. ${strictInstruction}\n\nSource note title: ${sourceFile}\n\n${content}`;
        const retrySystem = systemPrompt + strictInstruction;
        const retryRaw = await client.complete(retrySystem, userMsg, signal);
        console.log(`generateArticle: retry #${attempt} model output (truncated):`, retryRaw ? retryRaw.slice(0, 2000) : retryRaw);
        parsed = parseJsonFromLLM(retryRaw);
        // if parsed found, replace raw with retryRaw for potential use in content fallback
        if (parsed) raw = retryRaw;
      }
    }

    if (!parsed) throw new Error("No JSON found after retries");
    let category = (parsed.category ?? fallback).trim();
    if (!allowedLower.has(category.toLowerCase())) {
      category = fallback;
    }
    return {
      sourceFile,
      title: parsed.title && parsed.title !== sourceFile ? parsed.title : sourceFile,
      category,
      content: parsed.content ?? raw,
      relatedTopics: Array.isArray(parsed.relatedTopics) ? parsed.relatedTopics : [],
    };
  } catch (e) {
    console.log("generateArticle: failed to parse JSON from LLM after retries; returning fallback article.", (e as Error).message);
    return { sourceFile, title: sourceFile, category: fallback, content: raw, relatedTopics: [] };
  }
}

const UPDATE_PROMPT = `You are a wiki maintainer. A new article has been ingested. Update the existing wiki page to incorporate relevant new knowledge from the new article.

Return ONLY the updated full markdown content of the existing page. Preserve all existing sections and [[wikilinks]]. Add or expand sections where the new article provides relevant information. Do not remove existing content.`;

const UPDATE_PATCH_PROMPT = `You are a wiki maintainer. A new article has been ingested. Produce a strict JSON "patch" object describing only minimal changes to apply to the existing page.

Return ONLY a valid JSON object, no explanation. JSON shape:
{
  "additions": [{"heading": "## Section heading", "content": "...markdown content..."}],
  "edits": [{"match": "some unique snippet from existing page", "replacement": "replacement text"}]
}

Rules:
- Only include additions for new sections to append or expansions that can be safely appended.
- For edits, include short exact snippets from the existing page in 'match' and the 'replacement' that should replace that snippet.
- Do NOT return the full updated page. Return only the JSON patch object.`;

interface PatchAddition {
  heading: string;
  content: string;
}

interface PatchEdit {
  match: string;
  replacement: string;
}

interface Patch {
  additions?: PatchAddition[];
  edits?: PatchEdit[];
}

function applyPatchToContent(existingContent: string, patch: Patch): string {
  let result = existingContent;

  if (patch.edits && Array.isArray(patch.edits)) {
    for (const e of patch.edits) {
      if (!e || typeof e.match !== "string") continue;
      const idx = result.indexOf(e.match);
      if (idx !== -1) {
        // replace only the first occurrence to minimize risk
        result = result.slice(0, idx) + e.replacement + result.slice(idx + e.match.length);
      } else {
        // not found: leave as-is
      }
    }
  }

  if (patch.additions && Array.isArray(patch.additions) && patch.additions.length > 0) {
    // append additions as new sections, separated by two newlines
    const sections = patch.additions.map(a => `${a.heading}\n\n${a.content.trim()}`);
    result = result.trimEnd() + "\n\n" + sections.join("\n\n") + "\n";
  }

  return result;
}

export async function updateExistingArticle(
  existingContent: string,
  existingTitle: string,
  newArticleTitle: string,
  newArticleContent: string,
  client: LLMClient,
  signal?: AbortSignal
): Promise<string> {
  const baseUserMsg = `Existing page title: ${existingTitle}\n\nExisting content:\n${existingContent}\n\n---\n\nNew article title: ${newArticleTitle}\n\nNew article content:\n${newArticleContent}`;

  // First try to get a minimal JSON patch from the model
  const rawPatchResp = await client.complete(UPDATE_PATCH_PROMPT, baseUserMsg, signal);
  try {
    const match = rawPatchResp.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in patch response");
    const parsed = JSON.parse(match[0]) as Patch;

    // Basic validation: must be object and contain at least one of additions/edits
    const hasAdditions = Array.isArray(parsed.additions) && parsed.additions.length > 0;
    const hasEdits = Array.isArray(parsed.edits) && parsed.edits.length > 0;
    if (!hasAdditions && !hasEdits) throw new Error("Empty patch");

    // Apply patch and return
    return applyPatchToContent(existingContent, parsed);
  } catch (err) {
    // Fallback: warn and request the full updated page (old behavior)
    console.warn("LLM did not return a valid patch JSON, falling back to full-page update. Error:", (err as Error).message);
    const updated = await client.complete(UPDATE_PROMPT, baseUserMsg, signal);
    return updated.trim() || existingContent;
  }
}
