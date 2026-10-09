import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { SIGNIN_REASON } from "../src/boards/connection";
import {
  FLOW_NODES,
  MAP_BROWSE_ACTION,
  MAP_COPY_ACTION,
  MAP_GROUP_ACTION,
  MAP_LENS_ACTION,
  MAP_SELECT_ACTION,
} from "../src/boards/map";
import { composeRecords } from "../src/boards/records";
import { createClient } from "../src/client";
import { KINDS_AREA, LEGAL_AREA } from "../src/data/areas";
import { FACETS_AREA, LENSES, mapState, readFacets } from "../src/data/map";
import { activeSearch } from "../src/data/records";
import { MAP_KEY } from "../src/keys";
import { focus, mapModule } from "../src/modules/map";
import type { Runtime } from "../src/runtime";
import { NOW, SAMPLE_FACETS, SAMPLE_KINDS, SAMPLE_LEGAL } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport, type SentRequest, seededRuntime } from "./harness";

type Section = CanvasBoardView["sections"][number];
type Leaf = Extract<Section, { kind: "columns" }>["columns"][number]["sections"][number];
type Buckets = { key: string; count: number }[];

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

function flowOf(view: CanvasBoardView) {
  const f = column(view, 1).find((x) => x.kind === "flow");
  if (f?.kind !== "flow") throw new Error("no flow");
  return f;
}

function cardOf(leaves: Leaf[]) {
  const c = leaves.find((x) => x.kind === "cards");
  return c?.kind === "cards" ? c.items[0] : undefined;
}

const act = (type: string, rt: Runtime, payload?: unknown) =>
  mapModule.actions?.[type]?.(rt, payload) ??
  Promise.resolve({ ok: false as const, error: "none" });

// Search answers each aggregate from `aggs`, keyed by "field query" first, then by field;
// entitlements answers members.
function routes(
  aggs: Record<string, Buckets | number>,
  members: { status: number; body?: unknown } = { status: 200, body: { members: [] } },
) {
  return routeTransport({
    "POST /api/search/v2/query": (req: SentRequest) => {
      const body = req.body as { aggregateBy?: string; query?: string };
      const a = body.aggregateBy
        ? (aggs[`${body.aggregateBy} ${body.query}`] ?? aggs[body.aggregateBy])
        : undefined;
      if (typeof a === "number") return { status: a, body: { message: "refused" } };
      return { status: 200, body: { results: [], totalCount: 7, aggregations: a ?? [] } };
    },
    "GET /api/entitlements/v2/groups/": () => members,
  });
}

const reads = (sent: SentRequest[]) =>
  sent
    .filter((r) => r.url.includes("/search/"))
    .map((r) => {
      const b = r.body as { aggregateBy?: string; query?: string };
      return `${b.aggregateBy} ${b.query}`;
    });

// Which tags each reader group's records carry, so the flow has ribbons to draw.
const FLOW_AGGS: Record<string, Buckets> = {
  [`legal.legaltags acl.viewers:"data.default.viewers${D}"`]: [
    { key: "opendes-public-usa-dataset", count: 702_410 },
    { key: "opendes-public-norway", count: 391_880 },
    { key: "opendes-sample-tag-01", count: 98_200 },
  ],
  [`legal.legaltags acl.viewers:"data.pilot.viewers${D}"`]: [
    { key: "opendes-pilot-trial", count: 8_400 },
    { key: "opendes-public-usa-dataset", count: 40_000 },
  ],
  [`legal.legaltags acl.viewers:"data.legacy.viewers${D}"`]: [
    { key: "opendes-retired-survey", count: 312 },
  ],
};

describe("partition map, lenses", () => {
  test("tags in use rank largest first and the largest is selected", () => {
    const view = draw(seededRuntime(SEED, { now: NOW }));
    expect(view.header?.chip).toBe("measured 14:05Z");
    const left = column(view, 0);
    const strip = left[0];
    expect(strip?.kind === "actions" && strip.items.map((i) => [i.label, i.selected])).toEqual([
      ["Tags in use · 4", true],
      ["Readers · 4", false],
      ["Owners · 2", false],
      ["Kinds · 214", false],
      ["Cleanup · 12", false],
    ]);
    const items = rows(left, "Tags holding records · 4 of 15");
    expect(items.map((r) => [r.chip?.label ?? r.glyph, r.text, r.trailing])).toEqual([
      ["ok", "opendes-public-usa-dataset", "702,410 · 55%"],
      ["ok", "opendes-public-norway", "391,880 · 31%"],
      ["ok", "opendes-sample-tag-01", "98,200 · 7.6%"],
      ["22 d", "opendes-pilot-trial", "8,400 · 0.7%"],
    ]);
    expect(items[0]?.selected).toBe(true);
    expect(items[3]).toMatchObject({
      bar: { value: 8_400, total: 702_410 },
      action: { type: MAP_SELECT_ACTION, payload: { lens: "tags", key: "opendes-pilot-trial" } },
    });
    const right = column(view, 1);
    expect(rows(right, "Where the records sit")[0]?.text).toBe("Reading where the records sit…");
    expect(cardOf(right)?.title).toBe("opendes-public-usa-dataset");
  });

  test("the Cleanup lens carries a dot only while a tag that needs a decision holds records", () => {
    const strip = (rt: Runtime) => {
      const s = column(draw(rt), 0)[0];
      return s?.kind === "actions" ? s.items.find((i) => i.label.startsWith("Cleanup")) : undefined;
    };
    expect(strip(seededRuntime(SEED, { now: NOW }))).toMatchObject({
      glyph: "●",
      tone: "error",
      hint: "1 tag that needs a decision holds records",
    });
    const facets = { ...SAMPLE_FACETS, tags: (SAMPLE_FACETS.tags ?? []).slice(0, 4) };
    const calm = strip(seededRuntime({ ...SEED, [FACETS_AREA]: facets }, { now: NOW }));
    expect(calm?.glyph).toBeUndefined();
  });

  test("readers shorten group names to the partition domain", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: routes({}).transport });
    expect(await act(MAP_LENS_ACTION, rt, { lens: "viewers" })).toEqual({ ok: true });
    const items = rows(column(draw(rt), 0), "Records per reader group");
    expect(items.map((r) => [r.text, r.trailing])).toEqual([
      ["data.default.viewers", "1,194,078 · 93%"],
      ["data.vendor.viewers", "52,644 · 4.1%"],
      ["data.pilot.viewers", "48,400 · 3.8%"],
      ["data.legacy.viewers", "312 · <0.1%"],
    ]);
    expect(items[0]?.action?.payload).toEqual({ lens: "viewers", key: `data.default.viewers${D}` });
    expect((await act(MAP_LENS_ACTION, rt, { lens: "colour" })).ok).toBe(false);
  });

  test("kinds group by family by default and switch with the group strip", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: routes({}).transport });
    await act(MAP_LENS_ACTION, rt, { lens: "kinds" });
    let items = rows(column(draw(rt), 0), "Records per family");
    expect(items[0]).toMatchObject({ text: "WellLog", trailing: "412,300 · 32% · 1 version" });
    expect(await act(MAP_GROUP_ACTION, rt, { by: "version" })).toEqual({ ok: true });
    items = rows(column(draw(rt), 0), "Records per schema version");
    expect(items[0]?.text).toBe("1.2.0");
    expect(items[0]?.selected).toBe(true);
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
    const items = rows(left, "Tags holding records");
    expect(items[0]).toMatchObject({
      text: "opendes-pilot-trial",
      trailing: "?",
      bar: { value: null },
    });
    expect(JSON.stringify(left)).toContain("Records per tag not measured: bad");
    mapState(rt).lens = "viewers";
    expect(JSON.stringify(column(draw(rt), 0))).toContain("search did not count acl.viewers (bad)");
  });

  test("sign-in needed keeps the rows, and selecting says why it cannot read", async () => {
    const rt = seededRuntime(SEED, { now: NOW, phase: "signin" });
    const view = draw(rt);
    expect(view.header?.chip).toBe("cached from 14:05Z");
    expect(rows(column(view, 0), "Tags holding records")[0]?.selected).toBe(true);
    const res = await act(MAP_SELECT_ACTION, rt, { lens: "tags", key: "opendes-pilot-trial" });
    expect(res).toEqual({ ok: false, error: SIGNIN_REASON });
  });

  test("first run hides the region", () => {
    expect(draw(seededRuntime({}, { phase: "firstrun" })).sections).toEqual([]);
  });
});

describe("partition map, where the records sit", () => {
  test("the tags lens reads each reader group's tags and draws tag to who can read", async () => {
    const { transport, sent } = routes(FLOW_AGGS);
    const rt = seededRuntime(SEED, { now: NOW, transport });
    await focus(rt);
    expect(reads(sent).filter((r) => r.startsWith("legal.legaltags"))).toEqual(
      (SAMPLE_FACETS.viewers ?? []).map((b) => `legal.legaltags acl.viewers:"${b.key}"`),
    );
    const flow = flowOf(draw(rt));
    expect(flow).toMatchObject({
      title: "Where the records sit · legal tag to who can read",
      left: "Legal tag",
      right: "Who can read",
    });
    expect(flow.nodes.map((x) => [x.id, x.label, x.sublabel, x.selected])).toEqual([
      ["l:opendes-public-usa-dataset", "opendes-public-usa-dataset", "702,410 · 55%", true],
      ["l:opendes-public-norway", "opendes-public-norway", "391,880 · 31%", undefined],
      ["l:opendes-sample-tag-01", "opendes-sample-tag-01", "98,200 · 7.6%", undefined],
      ["l:opendes-pilot-trial", "opendes-pilot-trial", "8,400 · 0.7%", undefined],
      ["l:opendes-retired-survey", "opendes-retired-survey", "312 · <0.1%", undefined],
      [`r:data.default.viewers${D}`, "data.default.viewers", "1,194,078 · 93%", undefined],
      [`r:data.pilot.viewers${D}`, "data.pilot.viewers", "48,400 · 3.8%", undefined],
      [`r:data.legacy.viewers${D}`, "data.legacy.viewers", "312 · <0.1%", undefined],
    ]);
    expect(flow.links[0]).toEqual({
      source: "l:opendes-public-usa-dataset",
      target: `r:data.default.viewers${D}`,
      n: 702_410,
    });
  });

  test("the profile drops what the flow already shows", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: routes(FLOW_AGGS).transport });
    await focus(rt);
    const right = column(draw(rt), 1);
    expect(right.some((x) => x.kind === "rows" && x.title === "Who can read it")).toBe(false);
    expect(right.some((x) => x.kind === "rows" && x.title === "Who owns it")).toBe(true);
  });

  test("past the node cap a side folds into one node, keeping the selected one", async () => {
    const tags = Array.from({ length: 10 }, (_, i) => ({
      key: `opendes-sample-tag-${String(i + 1).padStart(2, "0")}`,
      count: 10_000 - i * 500,
    }));
    const facets = { ...SAMPLE_FACETS, tags };
    const aggs = { [`legal.legaltags acl.viewers:"data.default.viewers${D}"`]: tags };
    const rt = seededRuntime(
      { ...SEED, [FACETS_AREA]: facets },
      { now: NOW, transport: routes(aggs).transport },
    );
    await act(MAP_SELECT_ACTION, rt, { lens: "tags", key: "opendes-sample-tag-10" });
    await focus(rt);
    const flow = flowOf(draw(rt));
    const lefts = flow.nodes.filter((x) => x.side === "left");
    expect(lefts).toHaveLength(FLOW_NODES.left + 1);
    expect(lefts.find((x) => x.selected)?.label).toBe("opendes-sample-tag-10");
    const more = lefts.at(-1);
    expect(more).toMatchObject({ id: "l:\u0000more", label: "4 more tags" });
    expect(more?.folded?.map((m) => m.label)).toEqual([
      "opendes-sample-tag-06",
      "opendes-sample-tag-07",
      "opendes-sample-tag-08",
      "opendes-sample-tag-09",
    ]);
  });

  test("owners draw tag to who owns; kinds draw family to tag over the largest tags", async () => {
    const { transport, sent } = routes({
      [`legal.legaltags acl.owners:"data.default.owners${D}"`]: [
        { key: "opendes-public-usa-dataset", count: 702_410 },
      ],
      'kind legal.legaltags:"opendes-public-usa-dataset"': [
        { key: "osdu:wks:work-product-component--WellLog:1.2.0", count: 400_000 },
        { key: "osdu:wks:master-data--Well:1.2.0", count: 88_104 },
      ],
    });
    const rt = seededRuntime(SEED, { now: NOW, transport });
    await act(MAP_LENS_ACTION, rt, { lens: "owners" });
    expect(flowOf(draw(rt))).toMatchObject({ right: "Who owns" });
    sent.length = 0;
    await act(MAP_LENS_ACTION, rt, { lens: "kinds" });
    expect(
      reads(sent)
        .filter((r) => r.startsWith("kind "))
        .sort(),
    ).toEqual([
      'kind legal.legaltags:"opendes-pilot-trial"',
      'kind legal.legaltags:"opendes-public-norway"',
      'kind legal.legaltags:"opendes-public-usa-dataset"',
      'kind legal.legaltags:"opendes-sample-tag-01"',
    ]);
    const flow = flowOf(draw(rt));
    expect(flow).toMatchObject({ left: "Family", right: "Legal tag" });
    expect(flow.nodes.filter((x) => x.side === "left").map((x) => [x.label, x.selected])).toEqual([
      ["WellLog", true],
      ["Well", undefined],
    ]);
  });

  test("a sweep with new facets reads the flow again; the same facets do not", async () => {
    const { transport, sent } = routes(FLOW_AGGS);
    const rt = seededRuntime(SEED, { now: NOW, transport });
    await focus(rt);
    sent.length = 0;
    await focus(rt);
    expect(sent).toHaveLength(0);
    rt.cache.succeed(FACETS_AREA, SAMPLE_FACETS, new Date(NOW.getTime() + 60_000));
    await focus(rt);
    expect(reads(sent).filter((r) => r.startsWith("legal.legaltags"))).toHaveLength(4);
  });
});

describe("partition map, cleanup", () => {
  const HELD = {
    ...SAMPLE_FACETS,
    tags: [...(SAMPLE_FACETS.tags ?? []), { key: "opendes-legacy-training", count: 40 }],
  };

  test("tags that need a decision list first; empty ones sit in grids with Copy names", async () => {
    const { transport, sent } = routes({});
    const rt = seededRuntime({ ...SEED, [FACETS_AREA]: HELD }, { now: NOW, transport });
    await act(MAP_LENS_ACTION, rt, { lens: "cleanup" });
    expect(reads(sent).some((r) => r.startsWith("legal.legaltags acl."))).toBe(false);
    const view = draw(rt);
    const items = rows(column(view, 0), "Hold records, need a decision · 2");
    expect(items.map((r) => [r.chip?.label, r.text, r.trailing, r.selected])).toEqual([
      ["invalid", "opendes-legacy-training", "40 · expired 2026-08-31", true],
      ["not listed", "opendes-retired-survey", "312", undefined],
    ]);
    const right = column(view, 1);
    const stats = right[0];
    expect(stats?.kind === "stats" && stats.items[0]).toMatchObject({
      label: "Need a decision",
      value: "2",
      sub: "1 invalid · 1 not listed · 352 records",
    });
    expect(cardOf(right)?.title).toBe("opendes-legacy-training");
    const grids = right.filter((x) => x.kind === "grid");
    expect(grids.map((g) => g.kind === "grid" && g.title)).toEqual([
      "Valid, no records · 10 · opendes- dropped",
    ]);
    const copy = [...right].reverse().find((x) => x.kind === "cards");
    expect(copy?.kind === "cards" && copy.items[0]?.fields).toEqual([
      {
        label: "valid, no records",
        value: "10 names",
        copyAction: { type: MAP_COPY_ACTION, payload: { set: "valid-empty" } },
      },
    ]);
  });

  test("Copy hands back the names, one per line", async () => {
    const rt = seededRuntime(SEED, { now: NOW });
    expect(await act(MAP_COPY_ACTION, rt, { set: "invalid-empty" })).toEqual({
      ok: true,
      data: "opendes-legacy-training",
    });
    const valid = await act(MAP_COPY_ACTION, rt, { set: "valid-empty" });
    expect(valid.ok && String(valid.data).split("\n")).toHaveLength(10);
    expect((await act(MAP_COPY_ACTION, rt, { set: "everything" })).ok).toBe(false);
    const held = seededRuntime({ ...SEED, [FACETS_AREA]: HELD }, { now: NOW });
    expect((await act(MAP_COPY_ACTION, held, { set: "invalid-empty" })).ok).toBe(false);
  });
});

describe("partition map, selection", () => {
  test("selecting a tag reads its kinds and owners, then draws the profile", async () => {
    const { transport, sent } = routes({
      kind: [
        { key: "osdu:wks:work-product-component--WellLog:1.2.0", count: 6_100 },
        { key: "osdu:wks:master-data--Wellbore:1.1.0", count: 2_000 },
        { key: "osdu:wks:master-data--Well:1.2.0", count: 300 },
      ],
      "acl.owners": [{ key: `data.pilot.owners${D}`, count: 8_400 }],
    });
    const rt = seededRuntime(SEED, { now: NOW, transport });
    const res = await act(MAP_SELECT_ACTION, rt, { lens: "tags", key: "opendes-pilot-trial" });
    expect(res).toEqual({ ok: true });
    expect(reads(sent).sort()).toEqual([
      'acl.owners legal.legaltags:"opendes-pilot-trial"',
      'kind legal.legaltags:"opendes-pilot-trial"',
    ]);
    const view = draw(rt);
    expect(rows(column(view, 0), "Tags holding records")[3]?.selected).toBe(true);
    const right = column(view, 1);
    const card = cardOf(right);
    expect(card).toMatchObject({
      title: "opendes-pilot-trial",
      pill: { label: "expires in 22 d", tone: "warn" },
      actions: [{ type: MAP_BROWSE_ACTION, label: "Browse records" }],
    });
    expect(JSON.stringify(card)).toContain('"value":"8,400"');
    expect(rows(right, "Who owns it")).toEqual([
      { glyph: "info", text: "data.pilot.owners", trailing: "8,400" },
    ]);
    const bars = right.find((s) => s.kind === "bars");
    expect(bars?.kind === "bars" && bars.items.map((b) => [b.label, b.trailing])).toEqual([
      ["WellLog", "6,100"],
      ["Wellbore", "2,000"],
      ["Well", "300"],
    ]);
  });

  test("returning through a lens restores the row picked there", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: routes({}).transport });
    await act(MAP_SELECT_ACTION, rt, { lens: "tags", key: "opendes-public-norway" });
    await act(MAP_LENS_ACTION, rt, { lens: "viewers" });
    expect(rows(column(draw(rt), 0), "Records per reader group")[0]?.selected).toBe(true);
    await act(MAP_LENS_ACTION, rt, { lens: "tags" });
    const items = rows(column(draw(rt), 0), "Tags holding records");
    expect(items.find((r) => r.selected)?.text).toBe("opendes-public-norway");
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
    expect(cardOf(right)?.pill).toEqual({ label: "not in entitlements", tone: "caution" });
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
    await act(MAP_LENS_ACTION, rt, { lens: "viewers" });
    await act(MAP_SELECT_ACTION, rt, { lens: "viewers", key: `data.pilot.viewers${D}` });
    const right = column(draw(rt), 1);
    expect(JSON.stringify(cardOf(right))).toContain("1 group · 1 people or applications");
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

  test("Browse records searches the focused slice and jumps to Records", async () => {
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

  test("Browse records with nothing to focus says so", async () => {
    expect((await act(MAP_BROWSE_ACTION, seededRuntime({}, { now: NOW }))).ok).toBe(false);
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
  test("connected, unmeasured, sign-in, with and without a flow", async () => {
    const flowed = seededRuntime(SEED, { now: NOW, transport: routes(FLOW_AGGS).transport });
    await focus(flowed);
    for (const rt of [
      flowed,
      seededRuntime(SEED, { now: NOW }),
      seededRuntime({}, { now: NOW }),
      seededRuntime(SEED, { now: NOW, phase: "signin" }),
    ]) {
      for (const lens of LENSES) {
        mapState(rt).lens = lens;
        draw(rt);
      }
    }
  });
});
