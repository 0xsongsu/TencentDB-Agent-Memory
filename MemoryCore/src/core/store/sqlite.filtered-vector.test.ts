import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VectorStore } from "./sqlite.js";

describe("VectorStore filtered vector search", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("searches within the requested isolation before ranking", async () => {
    dir = await mkdtemp(join(tmpdir(), "tdai-filtered-vector-"));
    const store = new VectorStore(join(dir, "vectors.db"), 2);
    store.init();
    const now = new Date().toISOString();

    for (let index = 0; index < 30; index += 1) {
      const embedding = new Float32Array([1, index / 1_000]);
      store.upsertL1({
        id: `other-l1-${index}`, content: "needle needle needle", type: "work_fact", priority: 50,
        scene_name: "", source_message_ids: [], metadata: {}, timestamps: [now],
        createdAt: now, updatedAt: now, sessionKey: "other", sessionId: "other",
        teamId: "other", userId: "other", agentId: "other", taskId: "",
      }, embedding);
      store.upsertL0({
        id: `other-l0-${index}`, sessionKey: "other", sessionId: "other",
        teamId: "other", userId: "other", agentId: "other", taskId: "", role: "user",
        messageText: "needle needle needle", recordedAt: now, timestamp: Date.now(),
      }, embedding);
    }

    const scopedEmbedding = new Float32Array([0, 1]);
    store.upsertL1({
      id: "scoped-l1", content: "needle", type: "work_fact", priority: 50,
      scene_name: "", source_message_ids: [], metadata: {}, timestamps: [now],
      createdAt: now, updatedAt: now, sessionKey: "scoped", sessionId: "scoped",
      teamId: "target", userId: "target", agentId: "target", taskId: "workspace:target",
    }, scopedEmbedding);
    store.upsertL0({
      id: "scoped-l0", sessionKey: "scoped", sessionId: "scoped",
      teamId: "target", userId: "target", agentId: "target", taskId: "workspace:target", role: "user",
      messageText: "needle", recordedAt: now, timestamp: Date.now(),
    }, scopedEmbedding);

    const filter = { teamId: "target", userId: "target", agentId: "target", taskId: "workspace:target" };
    expect(store.searchL1Vector(new Float32Array([1, 0]), 1, undefined, filter)[0]?.record_id).toBe("scoped-l1");
    expect(store.searchL0Vector(new Float32Array([1, 0]), 1, undefined, filter)[0]?.record_id).toBe("scoped-l0");
    expect(store.searchL1Fts('"needle"', 1, filter)[0]?.record_id).toBe("scoped-l1");
    expect(store.searchL0Fts('"needle"', 1, filter)[0]?.record_id).toBe("scoped-l0");
    const emptyTaskFilter = { teamId: "other", userId: "other", agentId: "other", taskId: "" };
    expect(store.searchL1Vector(new Float32Array([1, 0]), 1, undefined, emptyTaskFilter)[0]?.record_id).toBe("other-l1-0");
    expect(store.searchL0Vector(new Float32Array([1, 0]), 1, undefined, emptyTaskFilter)[0]?.record_id).toBe("other-l0-0");
    store.close();
  });
});
