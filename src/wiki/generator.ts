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
    ? `\nExisting wiki articles: ${existingTitles.join(", ")}`
    : "";
  const systemPrompt = SYSTEM_PROMPT
    .replace("{LANGUAGE}", languageInstruction(settings.outputLanguage))
    .replace("{CATEGORIES}", categories.join(", "))
    .replace("{FALLBACK}", fallback)
    .replace("{EXISTING_HINT}", existingHint);

  const raw = await client.complete(systemPrompt, `Source note title: ${sourceFile}\n\n${content}`, signal);

  const allowedLower = new Set(categories.map((c) => c.toLowerCase()));

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    const parsed = JSON.parse(match[0]);
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
  } catch {
    return { sourceFile, title: sourceFile, category: fallback, content: raw, relatedTopics: [] };
  }
}

const UPDATE_PROMPT = `You are a wiki maintainer. A new article has been ingested. Update the existing wiki page to incorporate relevant new knowledge from the new article.

Return ONLY the updated full markdown content of the existing page. Preserve all existing sections and [[wikilinks]]. Add or expand sections where the new article provides relevant information. Do not remove existing content.`;

export async function updateExistingArticle(
  existingContent: string,
  existingTitle: string,
  newArticleTitle: string,
  newArticleContent: string,
  client: LLMClient,
  signal?: AbortSignal
): Promise<string> {
  const userMsg = `Existing page title: ${existingTitle}\n\nExisting content:\n${existingContent}\n\n---\n\nNew article title: ${newArticleTitle}\n\nNew article content:\n${newArticleContent}`;
  const updated = await client.complete(UPDATE_PROMPT, userMsg, signal);
  // Return updated content, or fall back to original if response looks empty
  return updated.trim() || existingContent;
}
