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

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `比较新记忆与关联候选，输出每条新记忆对应的一项严格 JSON 决策，不要 Markdown 围栏。

- 只依据 source_message_ids、metadata.evidence 中的用户原文核对概括。旧概括不是证据；其无依据的身份、状态、规则应纠正，不得继续传播。
- 同一任务的新进度优先 update，以最新明确状态替换旧状态；时间线可由来源追溯，不必把所有阶段拼成一段长叙事。明确的新结果、纠错不能 skip。
- store：不同事实、范围不同、旧记录无可核对证据，独立保存。
- skip：相同范围、来源可靠，旧事实已完整准确包含新信息，且无新状态或纠错。
- update：同一事实的新状态或纠错。merged_content 使用新记忆内容，保留其 type、priority。
- merge：只有同范围、相同事实且确有互补信息才合并；每个细节必须有 evidence 支持。不得用同一主题把不同任务/人物合并。
- 不将任务、测试观测或助手陈述变为长期规则、系统保证、人格或用户主张。一次“你好”接上活动只能表述为该次测试结果。
- 保持新记忆 type、scope、explicit_long_term，不因合并提高确定性或优先级。不得补团队、职业、心理、时间、完成状态。
- target_ids 只能来自该新记忆关联候选；store/skip 使用空数组。merge/update 的 merged_timestamps 保留输入时间戳，不捏造；Z 为 UTC。

输出结构：[{"record_id":"新ID","action":"store|skip|update|merge","target_ids":[],"merged_content":"仅 merge/update 需要","merged_type":"保持新 type","merged_priority":80,"merged_timestamps":[]}]
输出语言与新记忆一致。`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `你是团队工作记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（work_fact / work_task / work_method / work_artifact）的记忆如果语义上描述同一工作对象、任务、方法或资产，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。
- 记忆默认会在项目团队内共享，合并内容应只保留工作相关信息。

## 判断逻辑

1. **分辨记忆性质**：
   - **工作事实类（work_fact）**：项目事实、需求、决策、状态、风险、约束、实验结果、客户反馈。
   - **工作任务类（work_task）**：待办、owner、deadline、下一步计划、任务状态变化。
   - **工作方法类（work_method）**：SOP、禁忌、原则、经验、设计思路、判断标准、Agent 行为规则。
   - **工作资产类（work_artifact）**：文档、PR、Issue、Prompt、报告、代码分支、设计稿、链接等。

2. **判断是否同一工作对象/演化过程**：
   - 同一项目、模块、需求、任务、风险、决策、方法、资产，且 scene_name 或语义高度相似。
   - 同一任务的不同阶段、同一方法的补充、同一资产的版本或用途变化，通常可以合并。
   - 仅属于同一大项目但讨论对象不同，不应强行合并。

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一工作对象，新记忆更具体、更新、更权威或纠正旧信息，以新记忆为主覆盖旧记忆，可保留旧记忆中仍正确的细节。
   - "merge"：同一工作对象或同一演化过程，新旧记忆互补且不矛盾，合并成一条更完整记忆，信息尽量不冗余。

4. **策略倾向**：
   - work_fact：同一事实/决策/状态的补充或修正 → 倾向 update 或 merge。
   - work_task：同一任务的 owner、deadline、状态变化 → 倾向 update；补充依赖或验收标准 → 倾向 merge。
   - work_method：同一 SOP、禁忌、原则、经验的补充 → 倾向 merge；更清晰通用的表述 → 倾向 update。
   - work_artifact：同一文档、PR、Prompt、报告等资产的用途、版本、链接补充 → 倾向 merge 或 update。
   - 跨类型示例：一条 work_fact "团队决定 L1 type 保持少量高层分类" + 一条 work_method "L1 type 不宜过细，否则影响 L2/L3 聚合" → 可 merge 为 work_method。

5. **timestamp 处理**：
   - merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）。
   - 这样可以保留工作事实、任务或方法演化的完整时间线。

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type：work_fact|work_task|work_method|work_artifact（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳数组，包含所有新旧记忆时间戳的并集（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**（可以 1 条或多条）。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。根据合并后内容本质判断。
- merged_priority：merge/update 后的新优先级（0-100 整数，merge/update 时必填）。合并后信息更完整、更确定，通常应**酌情提升** priority。参考标准：80-100（关键事实/重要任务/核心方法/重要资产），60-79（一般工作信息），<60（次要信息）。
- merged_timestamps：合并后的时间戳数组。收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。`;

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
    poolSection = "## 统一候选记忆池\n\n（空，没有已有记忆，所有新记忆直接 store）";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## 统一候选记忆池（共 ${poolList.length} 条已有记忆）\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[]（无相似候选，直接 store）";

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

    return `### 第 ${idx + 1} 条新记忆 (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【关联候选 ID】${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言。

${poolSection}

${"═".repeat(50)}

## 待判断的新记忆（共 ${matches.length} 条）

${newMemoriesText}

请逐条判断并输出决策 JSON 数组。当某条新记忆的候选列表为空时，该条直接输出 action=store。`;
}
