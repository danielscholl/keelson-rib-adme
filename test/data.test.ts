import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { formatBytes, RECORD_OPEN_ACTION } from "../src/boards/record";
import { createClient, MAX_BODY_BYTES, readCapped } from "../src/client";
import { readKinds } from "../src/data/areas";
import { HEALTH_AREA } from "../src/data/health";
import { groupKinds } from "../src/data/inventory";
import { RECORD_KEY } from "../src/keys";
import { recordModule } from "../src/modules/record";
import type { Area, Runtime } from "../src/runtime";
import { NOW } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport, type SentRequest, seededRuntime } from "./harness";

const recordBoard = expectView(RECORD_KEY, "board");

function drawer(rt: Runtime): CanvasBoardView {
  return recordBoard(recordModule.composers?.[RECORD_KEY]?.(rt)) as CanvasBoardView;
}

const KINDS = [
  { kind: "osdu:wks:work-product-component--WellLog:1.2.0", count: 400 },
  { kind: "osdu:wks:work-product-component--WellLog:1.1.0", count: 12 },
  { kind: "osdu:wks:master-data--Well:1.2.0", count: 88 },
  { kind: "contoso:pilot:master-data--Well:1.0.0", count: 5 },
  { kind: "not-a-kind", count: 3 },
];

describe("grouping kinds", () => {
  test("family sums versions and authorities of one entity, and names its search pattern", () => {
    expect(groupKinds(KINDS, "family")).toEqual([
      {
        key: "work-product-component--WellLog",
        label: "WellLog",
        count: 412,
        kinds: 2,
        versions: 2,
        pattern: "*:*:work-product-component--WellLog:*",
      },
      {
        key: "master-data--Well",
        label: "Well",
        count: 93,
        kinds: 2,
        versions: 2,
        pattern: "*:*:master-data--Well:*",
      },
    ]);
  });

  test("authority, namespace and version each split on their own segment", () => {
    expect(groupKinds(KINDS, "authority").map((g) => [g.key, g.count, g.pattern])).toEqual([
      ["osdu", 500, "osdu:*:*:*"],
      ["contoso", 5, "contoso:*:*:*"],
    ]);
    expect(groupKinds(KINDS, "namespace").map((g) => g.key)).toEqual(["wks", "pilot"]);
    expect(groupKinds(KINDS, "version").map((g) => [g.key, g.count, g.kinds])).toEqual([
      ["1.2.0", 488, 2],
      ["1.1.0", 12, 1],
      ["1.0.0", 5, 1],
    ]);
  });
});

describe("record drawer", () => {
  const RECORD = {
    id: "opendes:master-data--Well:8690",
    kind: "osdu:wks:master-data--Well:1.2.0",
    version: 1_790_000_000_000_000,
    createTime: "2026-09-01T08:00:00.000Z",
    createUser: "pilot-loader@contoso.example",
    acl: {
      viewers: ["data.pilot.viewers@contoso.example"],
      owners: ["data.pilot.owners@contoso.example"],
    },
    legal: {
      legaltags: ["opendes-pilot-trial"],
      otherRelevantDataCountries: ["US"],
      status: "compliant",
    },
    ancestry: { parents: ["opendes:master-data--Field:alpha:1"] },
    data: { FacilityName: "alpha-well-01", Notes: "é" },
  };

  function storage(status = 200) {
    return routeTransport({
      "GET /api/storage/v2/records/": (req: SentRequest) =>
        status === 200
          ? {
              status,
              body: { ...RECORD, id: decodeURIComponent(req.url.split("/records/")[1] ?? "") },
            }
          : { status, body: { message: "nope" } },
    });
  }

  test("opening a row reads the latest version and draws allowlisted fields and its size", async () => {
    const { transport, sent } = storage();
    const rt = seededRuntime({}, { transport, now: NOW });
    const res = await recordModule.actions?.[RECORD_OPEN_ACTION]?.(rt, { id: RECORD.id });
    expect(res).toMatchObject({
      ok: true,
      data: { effect: "open-canvas", key: RECORD_KEY, placement: "side" },
    });
    expect(sent[0]?.url).toEndWith("/records/opendes%3Amaster-data--Well%3A8690");
    const view = drawer(rt);
    expect(view.header?.chip).toBe("opendes:master-data--Well:8690 · 14:05Z");
    const stats = view.sections.find((s) => s.kind === "stats");
    const bytes = new TextEncoder().encode(JSON.stringify(RECORD)).length;
    expect(stats?.kind === "stats" && stats.items[0]?.value).toBe(formatBytes(bytes));
    const text = JSON.stringify(view);
    expect(text).toContain("alpha-well-01");
    expect(text).toContain("opendes:master-data--Field:alpha:1");
    expect(text).not.toContain("Notes");
  });

  test("a 404 or 403 opens the drawer with the reason", async () => {
    for (const [status, why] of [
      [404, "storage has no record with this id (404)"],
      [403, "storage refused this sign-in (403)"],
    ] as const) {
      const rt = seededRuntime({}, { transport: storage(status).transport });
      const res = await recordModule.actions?.[RECORD_OPEN_ACTION]?.(rt, { id: "x" });
      expect(res?.ok).toBe(true);
      expect(JSON.stringify(drawer(rt))).toContain(why);
    }
  });

  test("sign-in needed refuses before any call", async () => {
    const { transport, sent } = storage();
    const rt = seededRuntime({}, { transport, phase: "signin" });
    const res = await recordModule.actions?.[RECORD_OPEN_ACTION]?.(rt, { id: RECORD.id });
    expect(res?.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("nothing opened draws an invitation", () => {
    expect(JSON.stringify(drawer(seededRuntime({})))).toContain("Open a record from Records.");
  });

  test("sizes read in bytes, KiB and MiB", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(4200)).toBe("4.1 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  });
});

describe("kind counts read", () => {
  function kindsRoutes(agg: unknown, count: { status: number; body?: unknown }) {
    return routeTransport({
      "POST /api/search/v2/query": (req) =>
        (req.body as { aggregateBy?: string }).aggregateBy
          ? { status: 200, body: { aggregations: agg, totalCount: 1 } }
          : count,
    });
  }

  async function read(routes: ReturnType<typeof routeTransport>) {
    const client = createClient(azExec(), SAMPLE_PROFILE, { transport: routes.transport });
    return client.batch((b) => readKinds(b));
  }

  test("one aggregate and one tracked count", async () => {
    const routes = kindsRoutes(
      [
        { key: "osdu:wks:master-data--Well:1.2.0", count: 5 },
        { key: "osdu:wks:master-data--Wellbore:1.1.0", count: 9 },
      ],
      { status: 200, body: { totalCount: 21 } },
    );
    const res = await read(routes);
    expect(res).toMatchObject({ ok: true, data: { total: 14, visible: 21 } });
    expect(routes.sent).toHaveLength(2);
    expect(
      routes.sent.find((r) => !(r.body as { aggregateBy?: string }).aggregateBy)?.body,
    ).toEqual({
      kind: "*:*:*:*",
      limit: 1,
      returnedFields: ["id"],
      trackTotalCount: true,
    });
  });

  test("a failed count leaves the visible total unmeasured", async () => {
    const res = await read(kindsRoutes([], { status: 400, body: { message: "bad" } }));
    expect(res).toMatchObject({ ok: true, data: { total: 0, visible: null } });
  });

  test("a missing aggregation fails the read instead of drawing no kinds", async () => {
    const res = await read(kindsRoutes(null, { status: 200, body: { totalCount: 21 } }));
    expect(res.ok).toBe(false);
  });
});

describe("area intervals", () => {
  test("an area with everyMs is skipped while fresh unless the sweep is forced", async () => {
    const { transport } = routeTransport({});
    let now = new Date("2026-10-02T14:05:00Z");
    const rt = seededRuntime({}, { transport });
    (rt as { now: () => Date }).now = () => now;
    const reads: string[] = [];
    const area = (name: string, everyMs?: number): Area => ({
      name,
      keys: [],
      read: async () => {
        reads.push(name);
        return { ok: true, status: 200, data: name };
      },
      ...(everyMs ? { everyMs } : {}),
    });
    rt.addArea(area(HEALTH_AREA, 60 * 60_000));
    rt.addArea(area("other"));
    await rt.sweep();
    now = new Date("2026-10-02T14:35:00Z");
    await rt.sweep();
    await rt.sweep({ force: true });
    now = new Date("2026-10-02T16:00:00Z");
    await rt.sweep();
    expect(reads).toEqual([
      HEALTH_AREA,
      "other",
      "other",
      HEALTH_AREA,
      "other",
      HEALTH_AREA,
      "other",
    ]);
  });
});

describe("response size guard", () => {
  test("a body past the cap answers 413 without keeping it", async () => {
    const big = new Response("x".repeat(64));
    expect((await readCapped(big, 32)).status).toBe(413);
    const declared = new Response("small", {
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    });
    expect((await readCapped(declared)).status).toBe(413);
    const ok = await readCapped(new Response('{"a":1}', { status: 200 }), 32);
    expect(ok).toEqual({ status: 200, body: '{"a":1}' });
  });
});
