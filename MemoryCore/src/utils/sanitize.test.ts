import { describe, expect, it } from "vitest";
import { extractJsonArrayCandidate } from "./sanitize.js";

describe("extractJsonArrayCandidate", () => {
  it("ignores bracketed message ids in reasoning before fenced JSON", () => {
    const raw = `<think>Inspect [msg-123] before answering.</think>\n\`\`\`json\n[{"scene_name":"preferences","message_ids":["msg-123"],"memories":[]}]\n\`\`\``;

    expect(JSON.parse(extractJsonArrayCandidate(raw)!)).toEqual([
      { scene_name: "preferences", message_ids: ["msg-123"], memories: [] },
    ]);
  });

  it("ignores bracketed message ids when the final JSON is not fenced", () => {
    const raw = `<think>Inspect [msg-123] before answering.</think>\n[{"scene_name":"preferences","message_ids":["msg-123"],"memories":[]}]`;

    expect(JSON.parse(extractJsonArrayCandidate(raw)!)).toEqual([
      { scene_name: "preferences", message_ids: ["msg-123"], memories: [] },
    ]);
  });
});
