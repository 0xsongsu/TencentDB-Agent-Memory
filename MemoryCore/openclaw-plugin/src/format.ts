/**
 * Format recall results into prompt context.
 *
 * Output structure (mirrors original memory-tencentdb plugin):
 * - prependContext: dynamic L1 memories (changes per turn, injected before user message)
 * - appendSystemContext: stable content (Persona + Scene Nav + tools guide, appended to system prompt)
 */

import type { RecallResult } from "./hooks/recall.js";

interface L1Item {
  id: string;
  content: string;
  type: string;
  score?: number;
}

interface SceneEntry {
  path: string;
  created_at?: string;
  updated_at?: string;
}

// ── Memory Tools Guide ──
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## Memory tools guide

When the memory snippets injected above are not enough to answer the user's question, you may call these tools for more information:

- **tdai_memory_search**: searches structured memories (L1); use it to recall user preferences, past events, rules and the like.
- **tdai_conversation_search**: searches the raw conversation (L0); use it to find the original text of specific messages, timelines and contextual details.
- **tdai_read_file**: reads the details of a memory file (use the full relative path from the Scene Navigation below, e.g. scene_blocks/xxx.md; persona.md can also be read).

### ⚠️ Call limit
In each conversation turn, tdai_memory_search and tdai_conversation_search may be called **at most 3 times combined**.
- If the first search returns nothing, you may retry with other keywords or the other tool, but keep the total within 3 calls.
- If 3 searches still return nothing, the information is not in memory; answer the user directly from what you already have.
</memory-tools-guide>`;

/**
 * Format L1 memories as prependContext.
 */
function formatL1Memories(items: L1Item[]): string | undefined {
  if (items.length === 0) return undefined;

  const lines: string[] = [
    "<relevant-memories>",
    "",
  ];

  for (const item of items) {
    const typeTag = item.type ? `[${item.type}]` : "";
    lines.push(`- ${typeTag} ${item.content}`);
  }

  lines.push("");
  lines.push("</relevant-memories>");

  return lines.join("\n");
}

/**
 * Format stable system context: Persona + Scene Navigation + Tools Guide.
 */
function formatSystemContext(
  persona: string | null,
  scenes: SceneEntry[],
): string | undefined {
  const parts: string[] = [];

  // Persona (L3)
  if (persona) {
    parts.push("<user-persona>");
    parts.push(persona);
    parts.push("</user-persona>");
  }

  // Scene Navigation (L2 index) — only if not already in persona
  if (scenes.length > 0 && (!persona || !persona.includes("Scene Navigation"))) {
    parts.push("");
    parts.push("## 🗺️ Scene Navigation");
    parts.push("*Below is the current scene memory index; use tdai_read_file to read the details.*");
    parts.push("");
    for (const scene of scenes) {
      parts.push(`- \`${scene.path}\``);
    }
  }

  // Tools guide (always append)
  parts.push("");
  parts.push(MEMORY_TOOLS_GUIDE);

  const result = parts.join("\n").trim();
  return result || undefined;
}

/**
 * Main format function: produce RecallResult for prompt injection.
 */
export function formatRecallResult(
  l1Items: L1Item[],
  persona: string | null,
  scenes: SceneEntry[],
): RecallResult {
  return {
    prependContext: formatL1Memories(l1Items),
    appendSystemContext: formatSystemContext(persona, scenes),
  };
}
