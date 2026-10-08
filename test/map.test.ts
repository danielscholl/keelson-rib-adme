import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import {
  MAP_BROWSE_ACTION,
  MAP_GROUP_ACTION,
  MAP_LENS_ACTION,
  MAP_SELECT_ACTION,
} from "../src/boards/map";
import { composeRecords } from "../src/boards/records";
import { createClient } from "../src/client";
import { KINDS_AREA, LEGAL_AREA } from "../src/data/areas";
import { FACETS_AREA, mapState, readFacets } from "../src/data/map";
import { activeSearch } from "../src/data/records";
import { MAP_KEY } from "../src/keys";
import { mapModule } from "../src/modules/map";
import type { Runtime } from "../src/runtime";
import { NOW, SAMPLE_FACETS, SAMPLE_KINDS, SAMPLE_LEGAL } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport, type SentRequest, seededRuntime } from "./harness";

type Section = CanvasBoardView["sections"][number];
type Leaf = Extract<Section, { kind: "columns" }>["columns"][number]["sections"][number];

const board = expectView(MAP_KEY, "board");
const D = "@opendes.dataservices.energy";

const SEED = {
  [KINDS_AREA]: { ...SAMPLE_KINDS, visible: 1_284_512 },
  [LEGAL_AREA]: SAMPLE_LEGAL,
  [FACETS_AREA]: SAMPLE_FACETS,
};

function draw(rt: Runtime): CanvasBoardView {
  return board(mapModule.composers?.[MAP_KEY]?.(rt)) as CanvasBoardView;
}

function column(view: CanvasBoardView, i: 0 | 1): Leaf[] {
  const cols = view.sections.find((s) => s.kind === "columns");
  if (cols?.kind !== "columns") throw new Error("no columns");
  return cols.columns[i]?.sections ?? [];
}

function rows(leaves: Leaf[], title: string) {
  const s = leaves.find((x) => x.kind === "rows" && x.title?.startsWith(title));
  if (s?.kind !== "rows") throw new Error(`no rows titled ${title}`);
  return s.items;
}

const act = (type: string, rt: Runtime, payload?: unknown) =>
  mapModule.actions?.[type]?.(rt, payload) ??
  Promise.resolve({ ok: false as const, error: "none" });

// Search answers each aggregate from `aggs`, keyed by field; entitlements answers members.
function routes(
  aggs: Record<string, { key: string; count: number }[] | number>,
  members: { status: number; body?: unknown } = { status: 200, body: { members: [] } },
) {
  return routeTransport({
    "POST /api/search/v2/query": (req: SentRequest) => {
      const body = req.body as { aggregateBy?: string };
      const a = body.aggregateBy ? aggs[body.aggregateBy] : undefined;
      if (typeof a === "number") return { status: a, body: { message: "refused" } };
      return { status: 200, body: { results: [], totalCount: 7, aggregations: a ?? [] } };
    },
    "GET /api/entitlements/v2/groups/": () => members,
  });
}

describe("partition map, lenses", () => {
  test("legal tags open first, attention before the rest, with counts from search", () => {
    const view = draw(seededRuntime(SEED, { now: NOW }));
    expect(view.header?.chip).toBe("measured 14:05Z");
    const left = column(view, 0);
    const strip = left[0];
    expect(strip?.kind === "actions" && strip.items.map((i) => [i.label, i.selected])).toEqual([
      ["Legal tags · 15", true],
      ["Readers · 4", false],
      ["Owners · 2", false],
      ["Kinds · 214", false],
    ]);
    const items = rows(left, "Records per legal tag");
    expect(items.slice(0, 6).map((r) => [r.chip?.label, r.text, r.trailing])).toEqual([
      ["invalid", "opendes-legacy-training", "0"],
      ["22 d", "opendes-pilot-trial", "8,400"],
      ["not listed", "opendes-retired-survey", "312"],
      ["valid", "opendes-public-usa-dataset", "702,410"],
      ["valid", "opendes-public-norway", "391,880"],
      ["valid", "opendes-sample-tag-01", "98,200"],
    ]);
    expect(items[1]).toMatchObject({
      bar: { value: 8_400, total: 1_284_512 },
      action: { type: MAP_SELECT_ACTION, payload: { lens: "tags", key: "opendes-pilot-trial" } },
    });
    expect(items).toHaveLength(13);
    expect(items[12]).toMatchObject({ text: "… 4 more tags", trailing: "0" });
    expect(items[12]?.action).toBeUndefined();
    expect(JSON.stringify(column(view, 1))).toContain("Select a row");
  });

  test("readers shorten group names to the partition domain", async () => {
    const rt = seededRuntime(SEED, { now: NOW });
    expect(await act(MAP_LENS_ACTION, rt, { lens: "viewers" })).toEqual({ ok: true });
    const items = rows(column(draw(rt), 0), "Records per reader group");
    expect(items.map((r) => [r.text, r.trailing])).toEqual([
      ["data.default.viewers", "1,194,078"],
      ["data.vendor.viewers", "52,644"],
      ["data.pilot.viewers", "48,400"],
      ["data.legacy.viewers", "312"],
    ]);
    expect(items[0]?.action?.payload).toEqual({ lens: "viewers", key: `data.default.viewers${D}` });
    expect((await act(MAP_LENS_ACTION, rt, { lens: "colour" })).ok).toBe(false);
  });

  test("kinds group by family by default and switch with the group strip", async () => {
    const rt = seededRuntime(SEED, { now: NOW });
    await act(MAP_LENS_ACTION, rt, { lens: "kinds" });
    let items = rows(column(draw(rt), 0), "Records per family");
    expect(items[0]).toMatchObject({ text: "WellLog", trailing: "412,300 · 1 version" });
    expect(await act(MAP_GROUP_ACTION, rt, { by: "version" })).toEqual({ ok: true });
    items = rows(column(draw(rt), 0), "Records per schema version");
    expect(items[0]?.text).toBe("1.2.0");
  });

  test("a refused facet draws ? and says why; tags still list from the legal service", () => {
    const facets = {
      ...SAMPLE_FACETS,
      tags: null,
      viewers: null,
      errors: { tags: "bad", viewers: "bad" },
    };
    const rt = seededRuntime({ ...SEED, [FACETS_AREA]: facets }, { now: NOW });
    const left = column(draw(rt), 0);
    const items = rows(left, "Records per legal tag");
    expect(items[0]).toMatchObject({
      text: "opendes-legacy-training",
      trailing: "?",
      bar: { value: null },
    });
    expect(JSON.stringify(left)).toContain("Records per tag not measured: bad");
    mapState(rt).lens = "viewers";
    expect(JSON.stringify(column(draw(rt), 0))).toContain("search did not count acl.viewers (bad)");
  });

  test("sign-in needed keeps the rows without actions", () => {
    const view = draw(seededRuntime(SEED, { now: NOW, phase: "signin" }));
    expect(view.header?.chip).toBe("cached from 14:05Z");
    const items = rows(column(view, 0), "Records per legal tag");
    expect(items.every((r) => r.action === undefined)).toBe(true);
  });

  test("first run hides the region", () => {
    expect(draw(seededRuntime({}, { phase: "firstrun" })).sections).toEqual([]);
  });
});

describe("partition map, selection", () => {
  test("selecting a tag reads its kinds, readers and owners, then draws the profile", async () => {
    const { transport, sent } = routes({
      kind: [
        { key: "osdu:wks:work-product-component--WellLog:1.2.0", count: 6_100 },
        { key: "osdu:wks:master-data--Wellbore:1.1.0", count: 2_000 },
        { key: "osdu:wks:master-data--Well:1.2.0", count: 300 },
      ],
      "acl.viewers": [{ key: `data.pilot.viewers${D}`, count: 8_400 }],
      "acl.owners": [{ key: `data.pilot.owners${D}`, count: 8_400 }],
    });
    const rt = seededRuntime(SEED, { now: NOW, transport });
    const res = await act(MAP_SELECT_ACTION, rt, { lens: "tags", key: "opendes-pilot-trial" });
    expect(res).toEqual({ ok: true });
    expect(sent.map((r) => (r.body as { aggregateBy: string }).aggregateBy).sort()).toEqual([
      "acl.owners",
      "acl.viewers",
      "kind",
    ]);
    expect(
      sent.every(
        (r) => (r.body as { query: string }).query === 'legal.legaltags:"opendes-pilot-trial"',
      ),
    ).toBe(true);
    const view = draw(rt);
    expect(rows(column(view, 0), "Records per legal tag")[1]?.selected).toBe(true);
    const right = column(view, 1);
    const card = right[0];
    expect(card?.kind === "cards" && card.items[0]).toMatchObject({
      title: "opendes-pilot-trial",
      pill: { label: "expires in 22 d", tone: "warn" },
      actions: [{ type: MAP_BROWSE_ACTION, label: "Browse records" }],
    });
    expect(JSON.stringify(card)).toContain('"value":"8,400"');
    expect(rows(right, "Who can read it")).toEqual([
      { glyph: "info", text: "data.pilot.viewers", trailing: "8,400" },
    ]);
    const bars = right.find((s) => s.kind === "bars");
    expect(bars?.kind === "bars" && bars.items.map((b) => [b.label, b.trailing])).toEqual([
      ["WellLog", "6,100"],
      ["Wellbore", "2,000"],
      ["Well", "300"],
    ]);
  });

  test("a group that entitlements does not know is flagged", async () => {
    const { transport, sent } = routes(
      { kind: [], "legal.legaltags": [{ key: "opendes-retired-survey", count: 312 }] },
      { status: 404, body: { message: "not found" } },
    );
    const rt = seededRuntime(SEED, { now: NOW, transport });
    await act(MAP_LENS_ACTION, rt, { lens: "viewers" });
    await act(MAP_SELECT_ACTION, rt, { lens: "viewers", key: `data.legacy.viewers${D}` });
    expect(sent.some((r) => r.url.includes("/groups/data.legacy.viewers%40opendes"))).toBe(true);
    const right = column(draw(rt), 1);
    const card = right[0];
    expect(card?.kind === "cards" && card.items[0]?.pill).toEqual({
      label: "not in entitlements",
      tone: "caution",
    });
    expect(rows(right, "Under which legal tags")[0]).toMatchObject({
      chip: { label: "not listed" },
      text: "opendes-retired-survey",
    });
  });

  test("a group's members are named when they are groups and counted otherwise", async () => {
    const { transport } = routes(
      { kind: [], "legal.legaltags": [] },
      {
        status: 200,
        body: {
          members: [
            { email: `users.datalake.editors${D}` },
            { email: "7c2e0000-0000-4000-8000-0000000041ab" },
          ],
        },
      },
    );
    const rt = seededRuntime(SEED, { now: NOW, transport });
    await act(MAP_SELECT_ACTION, rt, { lens: "viewers", key: `data.pilot.viewers${D}` });
    const right = column(draw(rt), 1);
    expect(JSON.stringify(right[0])).toContain("1 group · 1 people or applications");
    expect(rows(right, "Member groups")).toEqual([
      { glyph: "info", text: "users.datalake.editors" },
    ]);
  });

  test("only a drawn row can be selected", async () => {
    const { transport, sent } = routes({});
    const rt = seededRuntime(SEED, { now: NOW, transport });
    const res = await act(MAP_SELECT_ACTION, rt, { lens: "tags", key: 'x" OR *' });
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("Browse records searches the selected slice and jumps to Records", async () => {
    const { transport, sent } = routes({});
    const rt = seededRuntime(SEED, { now: NOW, transport });
    await act(MAP_SELECT_ACTION, rt, { lens: "tags", key: "opendes-pilot-trial" });
    sent.length = 0;
    const res = await act(MAP_BROWSE_ACTION, rt);
    expect(res).toMatchObject({
      ok: true,
      data: { effect: "open-surface", regionKey: "rib:adme:records" },
    });
    expect((sent[0]?.body as { query?: string } | undefined)?.query).toBe(
      'legal.legaltags:"opendes-pilot-trial"',
    );
    expect(activeSearch(rt)?.result.total).toBe(7);
  });

  test("Browse records with nothing selected says so", async () => {
    expect((await act(MAP_BROWSE_ACTION, seededRuntime(SEED, { now: NOW }))).ok).toBe(false);
  });
});

describe("facet read", () => {
  async function read(aggs: Record<string, { key: string; count: number }[] | number>) {
    const r = routes(aggs);
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

describe("records folds until a search runs", () => {
  test("defaultCollapsed follows the search", () => {
    const status = seededRuntime(SEED, { now: NOW }).status;
    expect(composeRecords({ status }).header?.defaultCollapsed).toBe(true);
  });
});

describe("every map frame passes its validator", () => {
  test("connected, unmeasured, sign-in", () => {
    for (const rt of [
      seededRuntime(SEED, { now: NOW }),
      seededRuntime({}, { now: NOW }),
      seededRuntime(SEED, { now: NOW, phase: "signin" }),
    ]) {
      for (const lens of ["tags", "viewers", "owners", "kinds"] as const) {
        mapState(rt).lens = lens;
        draw(rt);
      }
    }
  });
});
