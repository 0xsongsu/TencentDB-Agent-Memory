/**
 * L1 Extraction Prompt: 情境切分 + 记忆提取
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `Extract sourced facts from the new conversation messages; use background messages only to resolve references. Write scene_name and content in the language the user writes in, not the language of these instructions. Return strict JSON with no Markdown fences.
Output protocol: a JSON array where each item is a scene with scene_name, message_ids and memories. Each memory has content, type (persona/episodic/instruction), priority, source_message_ids and metadata. With no valid memory, memories is [] and the scene and its message range are still kept.
Source protocol: message_ids, source_message_ids and metadata.evidence.message_id use only the identifiers in the new message headers, such as new_1, never old IDs inside message bodies. source_message_ids is non-empty; metadata.evidence is a non-empty [{message_id,quote}], where quote is a contiguous excerpt of that user message copied verbatim in its original language, never translated. The assistant provides background only and is never evidence of a user fact. Code verifies sources and writes source_timestamp; never fabricate evidence.
metadata.scope: user for persona/instruction, task for episodic. An instruction also needs metadata.long_term_quote: the contiguous excerpt of the source user message, verbatim, in which the user says the requirement also applies to later, unrelated tasks (such as "from now on", "always", "every time"); without such words from the user it is not an instruction, however firm or conditional the requirement is. Code checks that quote and writes explicit_long_term. metadata may include status, activity_start_time, activity_end_time and other information the text supports; omit what is unknown. priority is 0-100.
Times follow the messages' ISO timestamps; Z means UTC. Keep the negations, limits and undecided states in the user's words; do not guess identity, location or when something happened.
Output example:
[{"scene_name":"Concrete matter","message_ids":["new_1"],"memories":[{"content":"A self-contained, scoped fact","type":"episodic","priority":80,"source_message_ids":["new_1"],"metadata":{"scope":"task","status":"open","evidence":[{"message_id":"new_1","quote":"The user's words, verbatim"}]}}]}]`;

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `You are an expert in "work scene segmentation and team-shared memory extraction".
Your task is to analyze multi-person work messages, detect work scene switches, and extract structured work memories that can be shared within the project team.

This task targets team collaboration in work settings. Focus on project facts, task progress, decisions, working methods, SOPs, prohibitions, design rationale, deliverables and other information with lasting value for the team's future collaboration and for Agent execution.

**Output language**: write all free-text fields (\`scene_name\`, memory \`content\`) in the dominant language of the messages to extract; keep JSON field names, enum values and ISO timestamps in English.

---

### Task 1: Work Scene Segmentation

Analyze [New messages to extract], together with [Previous scene] and [Background conversation], and decide which work scene the current messages belong to.

[Scene definition]
A scene is a group of messages about the same project, task, module, requirement, problem, decision, incident, customer scenario or work goal.

[Continuation condition]
If the new messages still continue the previous project, task, requirement, problem or work goal, keep the previous scene.

[Switch conditions]
Switch to or create a new scene when any of the following occurs:
1. The subject becomes another project, module, requirement, customer, issue, PR, experiment, incident or deliverable.
2. The work goal changes clearly, e.g. from "requirements discussion" to "release scheduling".
3. A new independent task, decision thread or troubleshooting thread clearly appears.
4. When several work topics appear in a row in the same batch, split them into separate scenes.

[Naming rules]
- Name the scene after the work object.
- Recommended format: "The team is [target activity] for [project/module/topic]".
- About 30-50 characters or an equivalent length; one sentence; globally unique.
- Examples:
  - "The team is designing shared memory rules for Agent Memory group-chat extraction"
  - "The team is troubleshooting production timeouts in the Billing API"
  - "The team is confirming query API requirements for the Andon pilot"

---

### Task 2: Work Memory Extraction

Using the background and the current scene, extract shareable core work information only from [New messages to extract].

[General extraction principles]

1. Serve work collaboration:
   - An extracted memory should help team members or Agents in later tasks understand the project background, pick up tasks, reuse experience or avoid repeating mistakes.
   - Do not extract greetings, small talk, passing emotional expressions or one-off tool requests.

2. Serve team sharing:
   - Extracted content is shared within the project team by default.
   - Extract only work content suitable for team sharing.
   - Do not extract non-work personal preferences, private life or sensitive information.

3. Self-contained:
   - Every memory must be understandable outside the current conversation.
   - content must include a clear subject, work object, conclusion, state or method.
   - Do not use context-dependent expressions such as "this", "that" or "the above".

4. Accurate attribution:
   - A suggestion, concern or judgment raised by one person is not a team decision.
   - Write a definite conclusion only when there is explicit confirmation, sign-off, adoption or an execution plan.
   - Express unconfirmed content as "The team is discussing...", "A proposal is still pending confirmation...", "There is a risk that...".

5. Consolidate:
   - Merge strongly related messages into one complete memory.
   - Do not split one work conclusion into several fragments.
   - But extract different work objects, tasks and methodologies separately.

6. Extract only from new messages:
   - [Background conversation] is only for understanding context, references and times.
   - Never extract new memories from background messages.
   - source_message_ids must contain only message ids from [New messages to extract].

7. Handling AI / Agent output:
   - Do not automatically treat an AI's suggestion as a team fact or team decision.
   - Extract it only when a human member adopts or confirms it, or when the Agent output itself is a definite tool execution result, deliverable or experiment result.
   - AI-generated drafts, proposals and analyses that are explicitly used as assets for later work may be extracted as work_artifact or work_method.

---

### The four supported types of work memory

memory \`type\` must be one of the following enum values:

1. Work fact (type: "work_fact")

Definition:
Factual information about projects, systems, business, customers, requirements, decisions, states, risks, constraints and experiment results.

Suitable for extraction:
- Project goals
- Product requirements
- Technical solutions
- Architecture constraints
- Customer feedback
- Decisions
- Current state
- Risks and blockers
- Experiment results
- Term definitions
- System facts

Examples:
- "The Agent Memory team edition uses a four-layer structure: L0 Work Event, L1 Work Record, L2 Project Scene Block, L3 Team Operating Memory."
- "The team decided that team-shared memory extracts only work content and does not build personal profiles."
- "The Andon pilot requires the memory query API to support filtering by project and configurable return fields."
- "Multi-person group chats mix work discussion with small talk, so there is a risk of extracting unrelated content."

priority:
- 90-100: key decisions, core requirements, long-term constraints, major risks.
- 70-89: general facts with ongoing value for the current project.
- <70: trivial, temporary, low-impact facts; discard them.

---

2. Work task (type: "work_task")

Definition:
Tasks, action items and responsibility assignments that need later execution, follow-up, confirmation or delivery.

Suitable for extraction:
- To-dos
- Tasks with a clear owner
- Tasks with a clear deadline
- Issues needing follow-up
- Blocked items
- Next-step plans
- Task state changes

Examples:
- "The backend team needs to finish the table design for many-to-many traceability between records and events by Friday."
- "The product side needs to add a description of the permission boundaries of team-shared memory."
- "The L1 prompt has entered the stage of consolidating work memory types; the next step is to update the downstream enum accordingly."

priority:
- 90-100: tasks that block delivery, have a clear deadline or affect the critical path.
- 70-89: general tasks with a clear owner or a clear follow-up action.
- <70: vague, temporary to-dos with no clear follow-up action; discard them.

metadata suggestions:
- If the owner can be determined, fill in {"owner": "name or ID"}.
- If the deadline can be determined, fill in {"deadline": "ISO8601"}.
- If the state can be determined, fill in {"status": "todo|doing|done|blocked|deferred|cancelled"}.

---

3. Work method (type: "work_method")

Definition:
Reusable methods, SOPs, processes, principles, prohibitions, design rationale, lessons learned, judgment criteria and Agent behavior rules that the team forms in its work.

This is one of the most important types in the team's long-term work memory. It records not only what happened, but how to handle similar tasks in the future, what not to do, and by which principles to judge.

Suitable for extraction:
- SOPs
- Collaboration processes
- Design principles
- Reasoning behind technical route choices
- Evaluation criteria
- Risk-avoidance rules
- Prohibitions and boundaries
- Reusable experience
- Agent execution strategies
- Prompt-writing principles
- Project methodology

Examples:
- "L1 extraction for the Agent Memory team edition should prefer a few high-level work types, to avoid splitting types too finely and making later aggregation hard."
- "Team-shared memory extraction should prioritize project facts, tasks, methods and deliverables over ordinary chat content."
- "When multi-person messages contain only one person's suggestion without explicit confirmation, it must not be extracted as a team decision."
- "The L1 prompt should keep its output JSON structure stable and adapt to new scenarios mainly by adjusting the type enum and extraction rules."
- "Work method memories can capture SOPs, prohibitions, design rationale and reusable experience to support later Agent execution."

priority:
- 90-100: core methods that are stable over the long term, reusable across tasks, and affect Agent behavior or team processes.
- 70-89: methods with clear reuse value for later work on the current project.
- <70: methods that are too temporary, vague or only fit a one-off operation; discard them.

metadata suggestions:
- If the scope can be determined, fill in {"scope": "project|team|module|agent|workflow"}.
- If the method category can be determined, fill in {"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}.
- For a prohibition or anti-pattern, fill in {"method_type": "anti_pattern"}.

---

4. Work artifact (type: "work_artifact")

Definition:
Work assets the team produces, references, maintains or needs later, including documents, PRs, issues, design files, experiment reports, code repositories, data tables, meeting notes, prompts and draft proposals.

Suitable for extraction:
- Documents
- PRs / Issues
- Code branches
- Experiment reports
- Design files
- Meeting notes
- Prompts
- Spreadsheets
- Links
- Draft proposals
- Agent-generated work output that was adopted

Examples:
- "The L1 work memory extraction prompt is a core prompt asset in the Agent Memory team edition design."
- "The team uses the four-layer work memory structure as the design basis for the later L2 and L3 aggregation prompts."
- "The Flowchart vs. StateDiagram comparison results can serve as the basis for choosing a short-term memory compression approach."

priority:
- 90-100: core documents, key PRs, release-related assets, important experiment reports.
- 70-89: general work assets likely to be reused later.
- <70: temporary files, low-value links, drafts that were not adopted; discard them.

metadata suggestions:
- If the asset type can be determined, fill in {"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note"}.
- If a link or identifier can be determined, fill in {"artifact_ref": "link, ID or name"}.

---

### What not to extract

The following should usually not be extracted:
- Greetings, pleasantries, jokes and small talk with no work value.
- Temporary one-off requests, e.g. "just fix the formatting for me this time".
- AI suggestions or temporary drafts that were not adopted.
- Details with no clear later value.
- Personal preferences, private life or sensitive information unrelated to the team's work.

---

### Task 3: Output format (JSON)

Return one valid JSON array and nothing else. Each item is a work scene with its message range and the work memories extracted from it:

[
  {
    "scene_name": "Name of the work scene created or continued",
    "message_ids": ["IDs of the messages in this scene"],
    "memories": [
      {
        "content": "A complete, self-contained work memory statement suitable for team sharing",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

metadata fields:
- Every type may output an empty object {}.
- work_task may add owner, deadline, status.
- work_method may add scope, method_type.
- work_artifact may add artifact_type, artifact_ref.
- work_fact may add work_object, status, activity_start_time, activity_end_time.
- metadata must not include unrelated personal information.

If the new messages contain no meaningful team-shared work memory, still output the scene segmentation, with memories as an empty array:

[
  {
    "scene_name": "Work scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above, with no extra Markdown code fences (such as \`\`\`json) and no explanatory text.`;

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "none" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "none";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**Output language**: write \`scene_name\` and memory \`content\` in the dominant language of the user's turns under "New messages to extract" below.

Local time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. All Z times below are UTC; keep the original offset, or convert explicitly before describing local time.

[Previous scene]: ${previousSceneName}

[Background conversation] (context only, for inferring relations and times; never extract memories from it):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[New messages to extract] (work out times from the timestamps; extract memories only from here):
${newText}`;
}
