import { describe, expect, test } from "bun:test";
import { classifyTokenError, GRAPH_RESOURCE } from "../src/az";
import { createClient } from "../src/client";
import { profileSchema } from "../src/profile";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport } from "./harness";

const noSleep = async () => undefined;

describe("profile", () => {
  test("normalises a pasted URL to a bare host", () => {
    const p = profileSchema.parse({
      ...SAMPLE_PROFILE,
      host: "https://contoso-adme.energy.azure.com/",
    });
    expect(p.host).toBe("contoso-adme.energy.azure.com");
  });

  test("rejects a non-GUID tenant id", () => {
    expect(profileSchema.safeParse({ ...SAMPLE_PROFILE, tenantId: "contoso" }).success).toBe(false);
  });
});

describe("token errors", () => {
  test("a resource missing from the tenant is a profile problem", () => {
    expect(
      classifyTokenError("ERROR: AADSTS500011: The resource principal named x was not found").kind,
    ).toBe("profile");
  });

  test("an expired refresh token is a sign-in problem", () => {
    expect(
      classifyTokenError("ERROR: AADSTS700082: The refresh token has expired due to inactivity.")
        .kind,
    ).toBe("signin");
  });

  test("a missing az binary is reported as such", () => {
    expect(classifyTokenError("az not found").kind).toBe("az-missing");
  });
});

describe("batch", () => {
  test("ADME calls carry the bearer token, partition and correlation id", async () => {
    const exec = azExec();
    const { transport, sent } = routeTransport({
      "GET /api/entitlements/v2/groups": () => ({ status: 200, body: { groups: [] } }),
    });
    const client = createClient(exec, SAMPLE_PROFILE, { transport, sleep: noSleep });
    const res = await client.batch((b) =>
      b.adme("entitlements", "/groups", { correlationId: "keelson-adme-4f2a-1" }),
    );
    expect(res.ok).toBe(true);
    expect(sent[0]?.url).toBe("https://contoso-adme.energy.azure.com/api/entitlements/v2/groups");
    expect(sent[0]?.headers).toMatchObject({
      Authorization: `Bearer tok-${SAMPLE_PROFILE.admeAppId}`,
      "data-partition-id": "opendes",
      "correlation-id": "keelson-adme-4f2a-1",
    });
  });

  test("tokens are fetched once per resource per batch, for the profile's tenant", async () => {
    const exec = azExec();
    const { transport } = routeTransport({
      "GET /api/entitlements/v2/groups": () => ({ status: 200, body: {} }),
      "GET graph.microsoft.com/v1.0/me": () => ({ status: 200, body: {} }),
    });
    const client = createClient(exec, SAMPLE_PROFILE, { transport, sleep: noSleep });
    await client.batch(async (b) => {
      await b.adme("entitlements", "/groups");
      await b.adme("entitlements", "/groups");
      await b.graph("/v1.0/me");
    });
    await client.batch((b) => b.graph("/v1.0/me"));
    const resources = exec.calls.map((c) => c.args[c.args.indexOf("--resource") + 1]);
    expect(resources).toEqual([SAMPLE_PROFILE.admeAppId, GRAPH_RESOURCE, GRAPH_RESOURCE]);
    for (const c of exec.calls) {
      expect(c.args[c.args.indexOf("--tenant") + 1]).toBe(SAMPLE_PROFILE.tenantId);
    }
  });

  test("a token failure fails the call without touching the network", async () => {
    const exec = azExec(() => ({ error: "ERROR: AADSTS70043: The refresh token has expired" }));
    const { transport, sent } = routeTransport({});
    const client = createClient(exec, SAMPLE_PROFILE, { transport, sleep: noSleep });
    const res = await client.batch((b) => b.adme("legal", "/legaltags"));
    expect(res).toMatchObject({ ok: false, failure: { kind: "signin", status: null } });
    expect(sent).toHaveLength(0);
  });

  test.each([
    [401, "signin"],
    [403, "forbidden"],
    [404, "not-found"],
    [409, "conflict"],
    [400, "client"],
  ])("HTTP %d classifies as %s and is not retried", async (status, kind) => {
    const { transport, sent } = routeTransport({
      "POST /groups/users@": () => ({ status, body: { message: "nope" } }),
    });
    const client = createClient(azExec(), SAMPLE_PROFILE, { transport, sleep: noSleep });
    const res = await client.batch((b) =>
      b.adme("entitlements", "/groups/users@opendes.dataservices.energy/members", {
        method: "POST",
        body: { email: "oid", role: "MEMBER" },
      }),
    );
    expect(res).toMatchObject({ ok: false, failure: { kind, status, message: "nope" } });
    expect(sent).toHaveLength(1);
  });

  test("a 5xx is retried twice, then reported", async () => {
    const { transport, sent } = routeTransport({
      "GET /api/search/v2/info": () => ({ status: 503 }),
    });
    const delays: number[] = [];
    const client = createClient(azExec(), SAMPLE_PROFILE, {
      transport,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const res = await client.batch((b) => b.adme("search", "/info"));
    expect(res).toMatchObject({ ok: false, failure: { kind: "server", status: 503 } });
    expect(sent).toHaveLength(3);
    expect(delays).toEqual([500, 1500]);
  });

  test("a throttled call waits out the limit and retries twice", async () => {
    let n = 0;
    const { transport, sent } = routeTransport({
      "POST /api/search/v2/query": () =>
        ++n < 3 ? { status: 429 } : { status: 200, body: { totalCount: 1 } },
    });
    const delays: number[] = [];
    const client = createClient(azExec(), SAMPLE_PROFILE, {
      transport,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const res = await client.batch((b) => b.adme("search", "/query", { method: "POST", body: {} }));
    expect(res).toMatchObject({ ok: true, data: { totalCount: 1 } });
    expect(sent).toHaveLength(3);
    expect(delays).toEqual([2000, 4000]);
  });

  test("a 5xx that recovers on retry succeeds", async () => {
    let n = 0;
    const { transport } = routeTransport({
      "GET /api/legal/v1/info": () =>
        ++n < 2 ? { status: 502 } : { status: 200, body: { version: "0.28.0" } },
    });
    const client = createClient(azExec(), SAMPLE_PROFILE, { transport, sleep: noSleep });
    const res = await client.batch((b) => b.adme<{ version: string }>("legal", "/info"));
    expect(res).toMatchObject({ ok: true, data: { version: "0.28.0" } });
  });

  test("graph $batch splits into chunks of 20 and merges responses by id", async () => {
    const { transport, sent } = routeTransport({
      "POST /v1.0/$batch": (req) => ({
        status: 200,
        body: {
          responses: (req.body as { requests: { id: string }[] }).requests.map((r) => ({
            id: r.id,
            status: 200,
            body: { id: r.id },
          })),
        },
      }),
    });
    const client = createClient(azExec(), SAMPLE_PROFILE, { transport, sleep: noSleep });
    const requests = Array.from({ length: 45 }, (_, i) => ({
      id: String(i),
      method: "GET" as const,
      url: `/users/${i}`,
    }));
    const res = await client.batch((b) => b.graphBatch(requests));
    expect(sent).toHaveLength(3);
    expect(res.ok && res.data.size).toBe(45);
  });

  test("the token never appears in a failure", async () => {
    const { transport } = routeTransport({
      "GET /api/storage/v2/info": () => ({ status: 401, body: "" }),
    });
    const client = createClient(
      azExec(() => ({ token: "SECRET-TOKEN" })),
      SAMPLE_PROFILE,
      {
        transport,
        sleep: noSleep,
      },
    );
    const res = await client.batch((b) => b.adme("storage", "/info"));
    expect(JSON.stringify(res)).not.toContain("SECRET-TOKEN");
  });
});
