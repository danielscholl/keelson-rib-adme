import { describe, expect, test } from "bun:test";
import { createClient } from "../src/client";
import { readFacets } from "../src/data/facets";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport, type SentRequest } from "./harness";

type Buckets = { key: string; count: number }[];

describe("facet read", () => {
  async function read(aggs: Record<string, Buckets | number>) {
    const r = routeTransport({
      "POST /api/search/v2/query": (req: SentRequest) => {
        const a = aggs[(req.body as { aggregateBy?: string }).aggregateBy ?? ""];
        if (typeof a === "number") return { status: a, body: { message: "refused" } };
        return { status: 200, body: { results: [], totalCount: 7, aggregations: a ?? [] } };
      },
    });
    const client = createClient(azExec(), SAMPLE_PROFILE, { transport: r.transport });
    return { res: await client.batch((b) => readFacets(b)), sent: r.sent };
  }

  test("three aggregates over every kind", async () => {
    const { res, sent } = await read({
      "legal.legaltags": [{ key: "a", count: 1 }],
      "acl.viewers": [{ key: "v", count: 2 }],
      "acl.owners": [{ key: "o", count: 3 }],
    });
    expect(sent).toHaveLength(3);
    expect(res).toMatchObject({
      ok: true,
      data: {
        tags: [{ key: "a", count: 1 }],
        viewers: [{ key: "v" }],
        owners: [{ key: "o" }],
        errors: {},
      },
    });
  });

  test("one refused facet is null with its reason; all refused fails the read", async () => {
    const one = await read({ "legal.legaltags": 400, "acl.viewers": [], "acl.owners": [] });
    expect(one.res).toMatchObject({
      ok: true,
      data: { tags: null, viewers: [], errors: { tags: "refused" } },
    });
    const all = await read({ "legal.legaltags": 400, "acl.viewers": 400, "acl.owners": 400 });
    expect(all.res.ok).toBe(false);
  });
});
