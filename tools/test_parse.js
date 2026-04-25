function parseJsonFromLLM(raw) {
  if (!raw || typeof raw !== "string") return null;

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
              break;
            }
          }
        }
      }
    }
  }

  const codeBlock = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (codeBlock && codeBlock[1]) {
    try {
      return JSON.parse(codeBlock[1].trim());
    } catch {}
  }

  const matches = raw.match(/\{[\s\S]*?\}/g);
  if (matches) {
    for (const m of matches) {
      try {
        return JSON.parse(m);
      } catch {}
    }
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }

  return null;
}

const samples = [
  // damaged but contains inline JSON
  `Here is the result: {"title":"Foo","category":"General","content":"## Overview\\n\\nArticle body","relatedTopics":["Bar"]} -- hope this helps!`,
  // code block JSON
  'Some explanation...\n```json\n{\n  "title": "Baz",\n  "category": "Tools",\n  "content": "## Overview\\n\\nDetailed article text",\n  "relatedTopics": ["Qux"]\n}\n```\nMore text.',
  // tricky nested braces inside strings
  'Note: explanation {notjson} then {"title":"Complex","content":"Contains { braces } inside text","relatedTopics":[]} end',
  // no json
  'No json here, just text.'
];

for (const s of samples) {
  console.log('--- Sample ---');
  console.log(s);
  const parsed = parseJsonFromLLM(s);
  console.log('Parsed:', parsed);
}
