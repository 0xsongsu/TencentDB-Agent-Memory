import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateBackend } from "./local-backend.js";
import type { TaskPayload } from "./types.js";

describe("LocalStateBackend durable task settlement", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("replays an unacknowledged task once after restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "tdai-state-"));
    const checkpointPath = join(dir, "state.json");
    const task: TaskPayload = {
      id: "L2-session-1",
      type: "L2",
      instanceId: "default",
      sessionId: "session-1",
      priority: 1,
      createdAt: 1,
    };

    const first = new LocalStateBackend({ checkpointPath });
    await first.initialize();
    await first.enqueueTask(task);
    expect(await first.consumeTask("worker-1")).toMatchObject({ id: task.id, _msgId: task.id });
    await first.destroy();

    const recovered = new LocalStateBackend({ checkpointPath });
    await recovered.initialize();
    expect(await recovered.consumeTask("worker-2")).toMatchObject({ id: task.id, _msgId: task.id });
    await recovered.ackTask(task.id);
    await recovered.destroy();

    const settled = new LocalStateBackend({ checkpointPath });
    await settled.initialize();
    expect(await settled.consumeTask("worker-3")).toBeNull();
    await settled.destroy();
  });

  it("does not fire restored timers before initialization returns", async () => {
    dir = await mkdtemp(join(tmpdir(), "tdai-state-"));
    const checkpointPath = join(dir, "state.json");
    const first = new LocalStateBackend({ checkpointPath });
    await first.initialize();
    await first.setTimer("default", "session-1:L1_idle", Date.now() + 5);
    await first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));

    let initialized = false;
    let resolveExpired!: () => void;
    const expired = new Promise<void>((resolve) => {
      resolveExpired = resolve;
    });
    const recovered = new LocalStateBackend({
      checkpointPath,
      onTimerExpired: () => {
        expect(initialized).toBe(true);
        resolveExpired();
      },
    });
    await recovered.initialize();
    initialized = true;
    await expired;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recovered.destroy();
  });
});
