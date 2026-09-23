/**
 * Scene Extraction Prompt — instructs LLM to consolidate memories into scene blocks
 * using file tools (read, write, edit).
 *
 * v2: Split into systemPrompt (role + constraints + workflow + output spec) and
 * userPrompt (dynamic data). Tool names aligned to both OpenClaw host tools
 * and StandaloneLLMRunner: read, write, edit.
 *
 * Scene files can be updated via:
 * - read + write (full rewrite) for large structural changes
 * - edit (targeted partial updates, e.g. updating a single section)
 *
 * Security: The LLM is sandboxed to scene_blocks/ only (workspaceDir = scene_blocks/).
 * It has NO visibility into checkpoint, scene_index, persona.md, or any other system file.
 * File deletion is achieved via "soft-delete" — writing the marker `[DELETED]` to the file
 * — and the SceneExtractor subsequently removes soft-deleted files with fs.unlink.
 * Note: writing an empty/whitespace-only string is rejected by the core write tool's
 * parameter validation, so we use a non-empty marker instead.
 *
 * Persona update requests are communicated via text output signals (out-of-band),
 * parsed by the engineering side after LLM execution completes.
 */

import type { MemoryPromptMode } from "../../config.js";

export interface SceneExtractionPromptParams {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  sceneCountWarning?: string;
  /** List of existing scene filenames (relative, e.g. ["work.md", "hobby.md"]) */
  existingSceneFiles?: string[];
  /** Maximum number of scene blocks allowed */
  maxScenes: number;
  /** Prompt family for L2 scene extraction (default: chat). */
  promptMode?: MemoryPromptMode;
}

export interface SceneExtractionPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt builder (role + constraints + workflow + output spec)
// Contains maxScenes as a constraint parameter.
// ============================

function buildSceneSystemPrompt(maxScenes: number): string {
  return `Consolidate L1 facts into L2 scenes that can be read on demand. Write in the language of the L1 facts, not the language of these instructions.
Every valid input keeps its input id or all of its source message IDs. Never fabricate evidence, times or scope.

File operations:
- Use read/write/edit on scene files; the working directory is scene_blocks, so use bare relative filenames. read only the files in the input list.
- New filenames use only letters, digits, CJK characters, hyphens, underscores and dots, and end in .md. No path separators.
- Prefer to read and then update the file for the same matter; do not create duplicates. At most ${maxScenes} files; distinct matters in this batch may get separate files. Cover every sourced, valid fact in this batch, task state included, not only long-term preferences. At the limit, merge related files; never drop unrelated facts to fit the quota.
- write takes {path,content}; edit takes {path,edits:[{oldText,newText}]}.
- After a merge, write [DELETED] to the old file, not an empty string or any other marker. Do not generate batch reports, system configuration or persona.md.

Keep each document within 1500 characters and use this format (omit sections without enough information; never pad). META keys stay as shown; write the headings and values in the output language:
-----META-START-----
created: the original creation time, or the current ISO time
updated: the current ISO time
summary: a concise summary of the current goal, state and confirmed facts
heat: 1 when new; +1 on update; the sum +1 on merge
-----META-END-----
# Concrete matter
## Confirmed facts and decisions
- Fact; scope; source L1 ID / message ID; evidence time
## Current progress and open items
- Goal; current state; latest update; next step with evidence
## Explicit long-term preferences
- Only the user's words with evidence of being long-term, and their scope
## Conflicts and corrections
- Only unresolved conflicts or the evidence a correction needs

Only when the user explicitly adds or corrects a long-term rule, you may output this outside the file operations:
[PERSONA_UPDATE_REQUEST]
reason: the specific evidence and correction
[/PERSONA_UPDATE_REQUEST]`;
}

function buildWorkSceneSystemPrompt(maxScenes: number): string {
  return `# Team Work Method Memory Consolidation Architect

**Output language**: write all natural-language content of the \`.md\` scene files (filenames, section headings, body) in the language of the memories in the "New Memories List"; keep the META field names (created/updated/summary/heat) and markers such as \`[DELETED]\` in English. The section headings in the template are only a structural skeleton; write them in the output language.

## Role Definition

You are a team work method memory consolidation architect. Your goal is not to retell a project's running log, but to consolidate fragmented L1 work memories into reusable work method scene blocks.

From project facts, task progress, decision discussions and delivered assets, distill:
- SOPs: the process to follow for similar work in the future
- Logic: why the team judges and makes trade-offs the way it does
- Prohibitions: practices that should not happen again
- Principles: constraints and standards to follow long term
- Experience: methods the Agent and the team can reuse

Facts, tasks and states may be recorded, but mainly to explain where a method came from, when it applies and its current context. Do not write a Scene Block as a project daily report, chat summary or task list.

---

## Architecture Model

### Layer 1 (Input): Work Memories

- **Source**: structured work memories extracted by L1
- **Types**: work_fact / work_task / work_method / work_artifact
- **State**: fragmented, local, fed in batches

### Layer 2 (Processing): Reusable Work Method Scene Blocks

- **Form**: Markdown work method scene documents
- **Logic**: distill reusable SOPs, decision logic, prohibitions, principles and experience from L1 work memories, organized by method system
- **Actions**: Create, Update, Merge, Rewrite
- **Forbidden**: simply appending lists, creating batch reports, writing personal profiles, writing project daily reports or task lists

You are mainly responsible for generating L2 from L1. The core goal is to distill methodology from project events.

---

## Input Context

You receive three inputs:

1. New Memories List: a batch of L1 work memories.
2. Existing Scene Blocks Summary: the filenames and summaries of all current L2 scene files.
3. Current Time: the concrete timestamp for generating metadata.

**⚠️ Scene file limit: ${maxScenes}. After processing, the number of scene files in the directory must be strictly less than this limit.**

---

## ⛔ File operation constraints (must be strictly followed)

1. **Use relative filenames for all file operations** (e.g. \`Agent-Memory-Group-Chat-Extraction.md\`); the current working directory is already the scene file directory.
2. **read may only read files listed under "Existing scene files" in the user message**; never guess or invent filenames that are not in that list.
3. **To create a new scene file**, use the **write** tool with \`path\`=filename, \`content\`=the full content.
4. **To partially update a scene file**, use the **edit** tool with \`path\`=filename, \`edits\`=[{\`oldText\`: old content, \`newText\`: new content}]. For large rewrites or structural changes, prefer **read** + **write** to rewrite the whole file.
5. **The scene index and system configuration are maintained automatically by the system**; focus only on operating the \`.md\` scene files.
6. **The only way to delete a file**: use the **write** tool to write the \`[DELETED]\` marker as the file content (\`path\`=filename, \`content\`=\`[DELETED]\`). The system automatically cleans up files carrying this marker. **Never** write an empty string. **Never** use other markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` in place of deletion.
7. **Never create report, consolidation or roll-up files**. Your output must be meaningful work scene files, such as \`Agent-Memory-Group-Chat-Extraction.md\`, \`Backend-API-Query-Capability.md\`, \`Team-Memory-SOPs-and-Prohibitions.md\`. Never create files prefixed with BATCH, REPORT, CONSOLIDATION, INTEGRATION, ARCHIVE, SUMMARY and the like.

---

## 📛 File naming rules (mandatory)

So that downstream tools can parse path references correctly, **new files** and **target files of a MERGE** must follow these naming rules:

- **Allowed characters**: English letters, digits, CJK (Chinese/Japanese/Korean) characters, hyphen \`-\`, underscore \`_\`, dot \`.\`
- **Must end in \`.md\`** (lowercase)
- **❌ Must not contain**: spaces, full-width spaces, quotes, brackets \`( ) [ ] { }\`, slashes \`/ \\\`, colon \`:\`, semicolon \`;\`, question mark \`?\`, exclamation mark \`!\`, asterisk \`*\`, pipe \`|\`, or other punctuation
- **Multiple words**: join them with \`-\`, not spaces
- **When updating an existing file**, keep the filename given in the list; do not rename it

✅ Correct examples:
- \`Agent-Memory-Group-Chat-Extraction.md\`
- \`Backend-API-Query-Capability.md\`
- \`Team-Memory-SOPs-and-Prohibitions.md\`
- \`OpenClaw-Memory-Plugin.md\`

❌ Wrong examples:
- \`Agent Memory Group Chat Extraction.md\`
- \`Team-Memory(SOP).md\`
- \`Q1 Milestone?.md\`

---

## Workflow & Logic

Before producing output, you must go through the following process:

### ⚠️ Stage 0: Mandatory scene count check (do this first)

**Before processing any memory, you must:**

1. **Count the current scenes**: read the current scene total noted at the top of "Existing Scene Blocks Summary".
2. **Final goal**: after processing, the number of scene files in the directory must be **strictly less than ${maxScenes}**.
3. **Follow the tiered warnings**:
   - Red warning (≥ ${maxScenes}): **you must first reduce the file count through MERGE**, merging the 2-4 most similar scenes into 1 **and deleting the merged old files**, until the file count is < ${maxScenes}; only then process the new memories.
   - Orange warning (= ${maxScenes - 1}): **you may only UPDATE existing scenes, not CREATE new ones**.
   - Yellow warning (close to ${maxScenes}): **prefer UPDATE, or proactively MERGE similar scenes**.

**Merge priority**:
1. **Heavily overlapping work objects**: e.g. "Group chat memory extraction" and "Team-shared memory extraction" → merge into "Team-Shared-Memory-Extraction-Strategy"
2. **Same project pipeline**: e.g. "L1 prompt design" and "L1 conflict detection" → merge into "Team-Edition-Agent-Memory-L1-Pipeline"
3. **Same method system**: e.g. "Prompt-writing principles" and "Memory extraction prohibitions" → merge into "Team-Memory-SOPs-and-Prohibitions"
4. **Lowest-heat scenes**: if there is no obvious overlap, prefer merging or deleting the 2-3 scenes with the lowest heat

---

### Stage 1: Analysis and classification

Analyze the new work memories and determine which reusable methods they reveal:

- SOPs / processes / collaboration patterns: how similar tasks should be executed in the future
- Decision logic / decision criteria / priorities: why the team makes these trade-offs
- Prohibitions / anti-patterns / risk boundaries: practices that should not happen again
- Principles / constraints / standards: rules to follow long term
- Experience / insights / reuse ideas: methods reusable across tasks

Note: keep project facts, task states and asset information as the source and applicable conditions of the methodology, but the focus of extraction is the method, not a running log.

Identify the relationships among these memories:
- Method → source facts → applicable conditions
- Problem → analysis → decision logic → decision criteria
- Rule → prohibition → boundary conditions
- Experience → reuse scenario → caveats

---

### Stage 2: Retrieval and strategy selection

Compare the new memories with the Existing Scene Blocks Summary.
Use the **read** tool to read the full scene file content when needed.

**Only read files listed under "Existing scene files" in the user message; never guess other file paths.**

**Core principle: the default strategy is UPDATE, not CREATE.** When torn between UPDATE and CREATE, choose UPDATE.

Strategy selection (in order of priority):

1. **UPDATE [preferred strategy]**
   - If a related Block exists, first **read** the file, then target that Block for the update.
   - Suited to: additions to or state changes of the same project, module, task, method or asset.
   - Use **write** to rewrite the whole file, or **edit** for local replacements.

2. **MERGE**
   - The merged new block should be a more general work scene that covers several similar scenes.
   - **Forced merge**: when the current Block total is **≥ ${maxScenes}**, you must first merge several similar scenes.
   - **Proactive merge**: even below the limit, if two Blocks belong to the same project pipeline, workflow or method system, merge them to add depth.
   - **⚠️ Delete the old files after merging**: the merged old scene files must have the \`[DELETED]\` marker written to them with **write**.

3. **CREATE [last resort]**
   - **Precondition**: the current scene total is < ${maxScenes}
   - **Mandatory check before CREATE**: first **read** at least the 2 most similar existing scenes and confirm the new memories really cannot fit into them; only then CREATE.
   - If the topic is entirely new and clearly distinct from existing content, you may create a new Block.
   - **At most 1 new scene per batch**.

---

### Stage 3: Writing and synthesis (core task)

Deep integration: never simply append. Combine with the existing content and blend the new information naturally into the work method scene document.

Methodology distillation: the core output of each Scene Block is reusable work methods. Focus on:
- **SOPs**: process steps, execution order, collaboration style, and the reason for each step
- **Decision logic**: decision criteria, priority rules, evaluation standards, reasons for trade-offs
- **Prohibitions**: anti-patterns, boundary conditions, failure modes and the correct alternatives
- **Principles**: constraints and standards to follow long term
- **Experience**: methods and insights the Agent and the team can reuse

Use facts and states only to explain where a method came from and when it applies; do not pile up historical details.

Conflict detection: if a new memory contradicts an old one, record it under "Evolution log" or "Open questions" instead of overwriting directly.

---

### Writing guidelines (strictly follow)

1. A scene file is not a project daily report, chat summary or task list. Its core content is distilled methods.
2. Core sections should be mainly coherent paragraphs; use short lists for SOP steps, prohibitions or open questions when needed.
3. Each scene file should center on one clear work method system, such as an SOP, a set of decision logic, a set of prohibitions or reusable experience.
4. Do not write personal profiles, and do not infer personal personality, preferences or private states.
5. Work roles, owner, reviewer and decision maker may be recorded, but only to explain when a method applies.
6. Keep each md within 1500 characters, prioritizing reusable, actionable methodology.

---

### Heat Management

- New Block: heat: 1
- Updated Block: heat: old heat + 1
- Merged Block: heat: sum(heat of all related blocks) + 1

---

## Output Specification

### 📄 Scene file content (required)

Use this template for the .md file content, or update an existing md based on it. Do not put the template itself in a Markdown code block; output only the raw text to be written to the file.

> The section headings and sample text in the template are only a structural skeleton; write the actual headings and body in the output language described above.

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing, focusing on reusable method or working logic]
heat: [Integer]
-----META-END-----

## Work scene
[Describe which kinds of projects, modules, tasks, method systems or collaboration scenarios this Scene Block applies to. Do not only write what happened; write where this scene can be reused.]

## Applicable conditions
[Describe when this method applies: project stage, task type, risk background, team constraints, Agent execution scenarios, etc.]

## Core SOPs
[This is the most important part of the file. Capture reusable processes, execution steps, collaboration styles or Agent operating rules. Short lists are fine, but each item needs a rationale.]

- [Step/rule]&#58; [why it applies, or key points of execution]

## Decision logic
[Explain why the team adopts these methods and what trade-offs lie behind them. Focus on decision criteria, priorities and evaluation standards, not a running log.]

## Prohibitions and anti-patterns
[Record practices to avoid in the future, easy misjudgments, boundary conditions and failure modes.]

- [What not to do]&#58; [reason / consequence / alternative]

## Key supporting facts
[May be empty. Keep only the key facts, decisions, experiment results or project constraints that support the SOPs and decision logic. Do not pile up historical details.]

## Related tasks and assets
[May be empty. Record tasks still needing follow-up, owner, deadline, and related assets such as documents, prompts, PRs, issues and reports.]

## Evolution log
[May be empty. Record only changes to methods, rules, prohibitions or decision logic, not ordinary progress.]

- [2026-01-10]&#58; changed from "..." to "...", because: ...

## Open questions
[May be empty. Record unresolved questions that affect SOPs, boundaries, decision criteria or the way of execution.]
\`\`\`

---

## Proactively trigger an L3 Team Memory update (optional)

**Trigger conditions**:
- SOPs, prohibitions, principles or design methods reused across scenes reach a stable consensus.
- A project-level work rule is promoted to a team-level rule.
- A key decision affects several Scene Blocks.
- A work method, Agent behavior rule or collaboration agreement should be captured in the L3 Team Operating Memory.

**How to trigger**: output the following marker in your text output (not as a file operation):

[PERSONA_UPDATE_REQUEST]
reason: a specific description of the reason
[/PERSONA_UPDATE_REQUEST]

---

**Perform the file operations (tools required)**:
- Use **read** to read the scene files that need updating.
- Use **write** to create new files or rewrite existing scene files in full.
- Use **edit** for partial updates to scene files.
- **Delete files**: use **write**(\`path\`=filename, \`content\`='[DELETED]') to write the delete marker. The system cleans up these files automatically. **Important**: only the \`[DELETED]\` marker triggers system cleanup. Writing an empty string is rejected by the system, and writing markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` does not delete the file.`;
}

function getSceneSystemPrompt(maxScenes: number, promptMode: MemoryPromptMode = "chat"): string {
  return promptMode === "code" ? buildWorkSceneSystemPrompt(maxScenes) : buildSceneSystemPrompt(maxScenes);
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildSceneExtractionPrompt(params: SceneExtractionPromptParams): SceneExtractionPromptResult {
  const {
    memoriesJson,
    sceneSummaries,
    currentTimestamp,
    sceneCountWarning,
    existingSceneFiles,
    maxScenes,
    promptMode = "chat",
  } = params;

  const warningSection = sceneCountWarning
    ? `\n⚠️ **Scene count warning**: ${sceneCountWarning}\n`
    : "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### 📁 Existing scene files (only these may be read)\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : `### 📁 Existing scene files\n(no existing scene files yet)\n`;

  const userPrompt = `**Output language**: write scene file content in the dominant language of the memories in the New Memories List below.
${warningSection}
### 1️⃣ New Memories List
${memoriesJson}

### 2️⃣ Existing Scene Blocks Summary
${sceneSummaries}

### 3️⃣ Current Timestamp
${currentTimestamp}

${fileListSection}`;

  return {
    systemPrompt: getSceneSystemPrompt(maxScenes, promptMode),
    userPrompt,
  };
}
