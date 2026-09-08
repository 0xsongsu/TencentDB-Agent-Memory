import { describe, expect, it } from "vitest";
import { handleV3MetaRoute } from "./v3-meta-router.js";
import type { MetadataService } from "../service/metadata-service.js";

async function call(embeddedOwnerUserId: string | undefined) {
  const responses: Array<{ status: number; body: unknown }> = [];
  const service = {
    getAgentById: async (agentId: string) => ({ agent_id: agentId }),
  } as unknown as MetadataService;
  const req = { headers: { "x-tdai-service-id": "ghast-desktop" } } as never;
  await handleV3MetaRoute(
    req,
    {} as never,
    "/v3/meta/agent/get",
    "POST",
    async () => ({ agent_id: "team-agent:a" }) as never,
    (_res, status, body) => void responses.push({ status, body }),
    { getMetadataService: () => service, logger: console, embeddedOwnerUserId },
  );
  return responses[0];
}

describe("handleV3MetaRoute embedded owner", () => {
  it("runs a request without x-tdai-user-key as the embedded owner", async () => {
    const response = await call("profile-1");
    expect(response.status).toBe(200);
    expect((response.body as { data: { agent_id: string } }).data.agent_id).toBe("team-agent:a");
  });

  it("still rejects a missing user key outside embedded mode", async () => {
    expect((await call(undefined)).status).toBe(401);
  });
});
