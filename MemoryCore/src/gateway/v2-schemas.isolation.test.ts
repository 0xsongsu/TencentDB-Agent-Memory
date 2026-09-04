import { describe, expect, it } from "vitest";
import { resolveIsolation } from "./v2-schemas.js";

describe("resolveIsolation", () => {
  it("preserves an explicit empty task bucket", () => {
    expect(resolveIsolation({ task_id: "" }, {}).ctx.taskId).toBe("");
    expect(resolveIsolation({}, {}).ctx.taskId).toBeUndefined();
  });
});
