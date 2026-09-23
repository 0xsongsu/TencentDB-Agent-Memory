/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `Generate a compact long-term user memory from sourced L2 scenes. Write in the language of the scenes, not the language of these instructions. Leave out anything without evidence; do not fill the template.

Write persona.md with write or edit, and operate only on this one file; its full current content is provided, so no read is needed.
write takes {path:"persona.md",content:<full Markdown>}; edit takes {path:"persona.md",edits:[{oldText,newText}]}.
The automatically distilled body stays within 2000 characters; never invent facts to fill the template. Without enough evidence, writing only the title is fine.
Suggested structure, with headings written in the output language: # User long-term facts; ## Confirmed facts; ## Explicit preferences and rules; ## Conflicts to confirm. Omit sections as needed.
Do not generate scene navigation; the system appends it. Write only the final document, not your analysis.`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**Output language**: write all natural-language content of \`persona.md\`, headings included, in the language of the changed scene content; keep the Markdown syntax, the bold labels of the footer line and the filename \`persona.md\` exactly as shown.

Combine the existing \`persona.md\` with the new or changed L2 scene blocks to generate or update a highly distilled document of team working principles.

This L3 is not a project summary, progress log, scene index or fact roll-up; it is an Operating Doctrine the team can reuse in every kind of work setting. It should help the Agent, when facing new tasks in the future, know how to judge, how to execute and how to avoid mistakes.

## ⛔ File operation constraints

1. **You must write the final content to \`persona.md\` with a file tool**.
   - First generation / major rewrite: use **write** with \`path\`=\`persona.md\`, \`content\`=the full content.
   - Incremental update: use **edit** with \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old snippet, \`newText\`: new snippet}].
2. **Operate only on the single file \`persona.md\`**; never read or write any other file.
3. **No read tool needed**: the full current content of \`persona.md\` is provided in the user message.
4. The written content must contain only the final Markdown document, with no analysis or explanation.

## 🚫 Strictly forbidden

- **More than 1200 characters**: the final \`persona.md\` must be highly compressed; aim for precision, not volume.
- **Project-specific fragments**: do not write content that only makes sense inside one project's context, such as "project v2 needs optimization" or "keep pushing a certain module forward".
- **Running logs**: do not record what happened, who did what or how a task is progressing, unless it has already been abstracted into a general method.
- **Piles of low-level facts**: project names, version numbers, task names, PRs, issues and document names usually stay out of L3, unless they represent a reusable pattern.
- **Incomplete meaning**: every principle must be understandable outside its original project and must include the object of the action, the conditions it applies under or the decision logic.
- **Personal profiling**: do not generate members' personalities, personal preferences, private states or emotional judgments.
- **Over-speculation**: do not guess at information that has no scene evidence.

---

## Core goal

Distill from the L2 scenes what is reusable in every kind of work setting:

1. **SOP**: the process to follow for similar tasks in the future.
2. **Principle**: working principles the team follows long term.
3. **Decision Logic**: the criteria for judging trade-offs.
4. **Boundary**: what must not be done and what must not be automated.
5. **Anti-pattern**: practices that cause errors, pollute memory or lower quality.
6. **Agent Rule**: rules the Agent should follow when executing tasks, updating memory and producing results.

Project facts, task states and asset names serve only as evidence and should not go directly into L3. Write them only when they can be abstracted into cross-scene rules.

---

## Filter criteria

Check each item before writing it into L3:

1. **Generality**: does it apply to multiple projects, multiple tasks or multiple kinds of work settings?
2. **Completeness**: outside the original project, can a reader still understand what it requires?
3. **Actionability**: can the Agent change its future behavior based on it?
4. **Stability**: is it likely to stay valid long term, rather than being a one-off task state?
5. **Concision**: can it be said in fewer words? Can it be merged into an existing principle?

If any answer is no, prefer not to write it.

---

## Incremental update strategy

For the changed scenes, decide on your own:

- **Reinforce**: the new scene only supports an existing principle; compress it into the existing sentence or change nothing.
- **Add**: a new general SOP, prohibition, decision logic or Agent rule appears.
- **Correct**: an old principle is overturned by new evidence, or its boundary becomes clearer.
- **Restructure**: when the document becomes scattered, long or project-specific, compress and rewrite it as a whole.
- **Leave unchanged**: when the new content is only project state, ordinary tasks or low-level facts, do not update L3.

Do not append every change as a new entry. L3 should keep being compressed, staying few and precise.

---

## Output template

Follow the format below and write the final content with the **write** or **edit** tool. Sections may be removed, but keep the Markdown format; the whole document stays within 1200 characters.

# Team Operating Doctrine

> **Operating Thesis**: [One sentence summarizing the team's most central, most general working method or Agent execution principle.]

## Core Principles
[Only high-level principles that hold steadily across work scenes. Each must be semantically complete.]

- [Principle]&#58; [applicable conditions / decision logic / why it matters]

## Reusable SOPs
[Only processes that can be run again and again. Do not write specific project steps.]

- [SOP name]&#58; When [trigger], first [step 1], then [step 2], and finally [output / acceptance criteria].

## Decision Logic
[Record trade-off criteria and priorities.]

- When [situation], prefer [A] over [B], because [reason].

## Boundaries & Anti-patterns
[Record prohibitions, boundaries and failure patterns.]

- Do not [wrong practice]; do [recommended practice] instead, because [reason].

## Agent Rules
[Record the behavior rules the Agent follows by default at work.]

- The Agent should [behavior rule] to avoid [risk].

---

> **Last updated**: [current time] · **Source scenes**: [scene count] · **Total memories**: [total memory count]

---

## Success criteria

- ✅ Write \`persona.md\` with write or edit
- ✅ Final content within 1200 characters
- ✅ Keep only the principles, SOPs, prohibitions, decision logic and Agent rules reusable in every kind of work setting
- ✅ Every item stays semantically complete outside any specific project
- ✅ Precision over volume: leave out whatever can be left out, and merge whatever can be merged
- ✅ No project progress, task logs, version fragments or scene indexes
- ✅ Do not add scene navigation (the system automatically appends Scene Navigation and the scene index)
- ✅ Operate only on \`persona.md\``;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 First generation" : "🔄 Incremental update";

  const triggerSection = triggerInfo
    ? `\n### Trigger\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 Current Team Operating Doctrine (preloaded)\n\n` +
        `*Below is the full Team Operating Doctrine from the current persona.md (${existingPersona.length} characters). The update must be compressed to within 1200 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 Current persona (preloaded)\n\n` +
        `*Below is the full current persona.md (${existingPersona.length} characters). Keep the updated version within 2000 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 Iteration guide\n\n` +
        `For the changed scenes, decide how to handle each: reinforce (supports an existing principle) / add (a new general SOP, prohibition, decision logic or agent rule) / correct (an old principle was updated) / restructure (the content grew long, scattered or project-specific) / leave unchanged (only project state or low-level facts).\n`
      : `\n## 🔄 Iteration guide\n\n` +
        `For the changed scenes, decide how to handle each: reinforce (supports an existing fact) / add (a new fact with evidence) / correct (a contradiction) / restructure (reorganize) / leave unchanged (nothing useful is new).\n`
    : "";

  const userPrompt = `**Output language**: write \`${targetFile}\` in the dominant language of the changed scenes below.

**⏰ Updated at**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Stats
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes**: ${changedSceneCount} (since the last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
