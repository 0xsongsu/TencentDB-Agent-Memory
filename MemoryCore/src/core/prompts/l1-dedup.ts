/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `Compare each new memory with its related candidates and output one strict JSON decision per new memory, with no Markdown fences.

- Check summaries only against the user's words in source_message_ids and metadata.evidence. An old summary is not evidence; correct its unsupported identity, state or rules instead of propagating them.
- New progress on the same task prefers update, replacing the old state with the latest explicit state; the timeline can be traced through the sources, so do not stitch every stage into one long narrative. A clear new result or correction is never skipped.
- store: a different fact, a different scope, or an old record with no checkable evidence; save it separately.
- skip: same scope, reliable source, and the old fact already contains the new information fully and accurately, with no new state or correction.
- update: a new state of, or a correction to, the same fact. merged_content uses the new memory's content and keeps its type and priority.
- merge: only for the same fact in the same scope with genuinely complementary information; every detail must be supported by evidence. Never merge different tasks or people because they share a topic.
- Never turn tasks, test observations or assistant statements into long-term rules, system guarantees, personality or user claims. A single "hello" that reached an activity may only be described as that test's result.
- Keep the new memory's type, scope and explicit_long_term; merging never raises certainty or priority. Do not add team, occupation, psychology, time or completion state.
- target_ids come only from that new memory's related candidates; store/skip use an empty array. For merge/update, merged_timestamps keeps the input timestamps and never invents any; Z is UTC.

Output structure: [{"record_id":"new ID","action":"store|skip|update|merge","target_ids":[],"merged_content":"merge/update only","merged_type":"keep the new type","merged_priority":80,"merged_timestamps":[]}]
Write merged_content in the language of the new memory.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a team work memory conflict detector. Batch-compare the memories under "New memories to judge" with the existing memories in the "Unified candidate pool", and decide how to handle each one.

**Output language**: write \`merged_content\` in the language of the new memory; keep JSON field names, enum values, record_id and ISO timestamps in English.

## Core rules

- **Cross-type merge**: memories of different types (work_fact / work_task / work_method / work_artifact) **may be merged** if they semantically describe the same work object, task, method or asset.
- **Many-to-many merge**: one new memory may replace or merge **several** existing memories in the candidate pool at once (listed in the target_ids array).
- After a merge you must decide the new memory's best type (merged_type).
- Memories are shared within the project team by default; merged content should keep only work-related information.

## Decision logic

1. **Identify the nature of each memory**:
   - **Work fact (work_fact)**: project facts, requirements, decisions, states, risks, constraints, experiment results, customer feedback.
   - **Work task (work_task)**: to-dos, owner, deadline, next-step plans, task state changes.
   - **Work method (work_method)**: SOPs, prohibitions, principles, experience, design rationale, judgment criteria, Agent behavior rules.
   - **Work artifact (work_artifact)**: documents, PRs, issues, prompts, reports, code branches, design files, links, etc.

2. **Decide whether it is the same work object or evolution**:
   - The same project, module, requirement, task, risk, decision, method or asset, with a highly similar scene_name or meaning.
   - Different stages of the same task, additions to the same method, or version or usage changes of the same asset can usually be merged.
   - Items that merely belong to the same large project but discuss different objects must not be forced together.

3. **Choose the action**:
   - "store": treat it as new information and add the current memory.
   - "skip": the existing memory is better and the new memory adds nothing or is vaguer; ignore the current memory.
   - "update": same work object, and the new memory is more specific, newer, more authoritative or corrects the old information; overwrite the old memory with the new one as the base, keeping details from the old memory that are still correct.
   - "merge": same work object or same evolution, and the old and new memories complement each other without contradiction; combine them into one more complete memory with as little redundancy as possible.

4. **Strategy tendencies**:
   - work_fact: an addition to or correction of the same fact/decision/state → prefer update or merge.
   - work_task: owner, deadline or state changes of the same task → prefer update; added dependencies or acceptance criteria → prefer merge.
   - work_method: additions to the same SOP, prohibition, principle or experience → prefer merge; a clearer, more general wording → prefer update.
   - work_artifact: added usage, version or link for the same document, PR, prompt, report or other asset → prefer merge or update.
   - Cross-type example: a work_fact "The team decided to keep L1 types to a few high-level categories" + a work_method "L1 types should not be too fine-grained, or L2/L3 aggregation suffers" → can be merged into a work_method.

5. **Timestamp handling**:
   - For merge / update, merged_timestamps should contain **the union of the timestamps of all related memories** (deduplicated and sorted).
   - This keeps the full timeline of how the work fact, task or method evolved.

## Output format

Output strictly a JSON array, one element per new memory's decision. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id 1 of a candidate memory to delete", "record_id 2"],
    "merged_content": "memory content after merge/update (required for merge/update)",
    "merged_type": "best type after merging: work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["timestamp array after merging: the union of all new and old memory timestamps (required for merge/update)"]
  }
]

Fields:
- target_ids: an **array** of old memory IDs to delete and replace (one or more). Omit or leave empty for store/skip.
- merged_content: the final memory text for merge/update. Omit for store/skip.
- merged_type: the type the memory belongs to after merge/update, judged by the nature of the merged content.
- merged_priority: the new priority after merge/update (integer 0-100, required for merge/update). Merged information is more complete and more certain, so priority should usually be **raised as appropriate**. Reference: 80-100 (key facts / important tasks / core methods / important assets), 60-79 (general work information), <60 (minor information).
- merged_timestamps: the timestamp array after merging. Collect the timestamps of the new memory plus all merged old memories, deduplicated and sorted.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
    source_message_ids: c.source_message_ids,
    metadata: c.metadata,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Unified candidate pool\n\n(Empty: there are no existing memories, so every new memory is stored.)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified candidate pool (${poolList.length} existing memories)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (no similar candidates; store it)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
        source_message_ids: m.newMemory.source_message_ids,
        metadata: m.newMemory.metadata,
      },
      null,
      2,
    );

    return `### New memory ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related candidate IDs] ${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**Output language**: write \`merged_content\` in the language of the new memory.

${poolSection}

${"═".repeat(50)}

## New memories to judge (${matches.length})

${newMemoriesText}

Judge each one and output the decision JSON array. When a new memory's candidate list is empty, output action=store for it.`;
}
