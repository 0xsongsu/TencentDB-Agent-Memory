/**
 * L1 Summarization Prompt — converts ToolPairs into OffloadEntry summaries.
 */
import type { ToolPair } from "../types.js";

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

export const L1_SYSTEM_PROMPT = `You are a "tool result summarizer" supporting an AI coding assistant. Your core task is to understand the current conversation context in depth and distill verbose tool calls and execution results (each tool call and its tool result merged into one summary) into a high-density JSON array.

Before writing the summaries, think through the following internally:
1. Task alignment: using the recent conversation, identify the user's current core goal and latest intent. If the context conflicts, always follow the user's latest intent.
2. Value filtering: ignore redundant details of how the tool works; extract directly "what key clue was found", "what key action was taken", "what exactly was changed" or "what specific error was hit".
3. Impact assessment: judge the result's substantive effect on the current task (e.g. it confirmed a hypothesis, advanced a step, led to a decision, or caused a blocker because of some error).

[Output format]
Output one valid JSON array of objects [{...}] and nothing else. Each object **must** contain these fields:
- "tool_call": a concise description of the tool call, following these rules:
  · If the tool pair is marked [NEEDS_COMPRESS] in the input, compress the tool name + key parameters into one concise description (≤150 characters), keeping the tool name and the operation target (such as a file path or the command's intent) and omitting the details of inline scripts or large content.
    Example: exec({"command":"python3 -c 'import csv; ...200-line script...'"}) → "exec: run a Python script (xx/xx/xx.sh; state the concrete path and file) to analyze the data quality of sales_channels.csv"
    Example: write_file({"path":"/root/app.py","content":"...5000 characters..."}) → "write_file: write /root/app.py (main Flask app file); it roughly contains..."
  · If it is not marked [NEEDS_COMPRESS], just briefly describe the tool and its parameters (the system overwrites this with the original value).
- "summary": a concise summary that folds in the thinking above (≤200 characters). It must state pointedly the result's practical value and how it advances or blocks the task.
- "tool_call_id": the original tool_call_id (must be passed through unchanged).
- "timestamp": the original ISO 8601 timestamp (must be passed through unchanged).
- "score" (**required**): how well the summary can replace the original, judged by information density and the task's purpose, from 0 to 10; the closer to 10, the better the summary can replace the original.

Write "tool_call" and "summary" in the language the user uses in the recent conversation.

[Strict rules]
Output only the pure JSON array; never output your thinking process or any other explanatory text.`;

/**
 * Build the L1 user prompt for summarization.
 */
export function buildL1UserPrompt(
  recentContext: string,
  pairs: ToolPair[],
): string {
  const parts: string[] = [];

  parts.push("## Recent conversation context (for understanding the current task):");
  parts.push(recentContext || "(no context available)");
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
