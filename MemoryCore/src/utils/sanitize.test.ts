import { describe, expect, it } from "vitest";
import { extractL1Memories } from "../core/record/l1-extractor.js";

describe("structured L1 output after reasoning", () => {
  for (const fenced of [true, false]) {
    it(`ignores bracketed message ids before ${fenced ? "fenced" : "unfenced"} JSON`, async () => {
      const json = '[{"scene_name":"preferences","message_ids":["msg-123"],"memories":[]}]';
      const raw = '<think>Inspect [msg-123] before answering.</think>\n' +
        (fenced ? `\`\`\`json\n${json}\n\`\`\`` : json);
      const result = await extractL1Memories({
        messages: [{ id: "msg-123", role: "user", content: "Please remember my preferences for future conversations.", timestamp: Date.now() }],
        sessionKey: "sanitize-test", baseDir: ".", config: {},
        options: { llmRunner: { run: async () => raw } },
      });
      expect(result.success).toBe(true);
      expect(result.sceneNames).toEqual(["preferences"]);
    });
  }
});
