import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { ACCESS_AREA, type AccessRead } from "../src/access/read";
import { MAP_LENS_ACTION, MAP_SELECT_ACTION } from "../src/boards/map";
import { KINDS_AREA, LEGAL_AREA } from "../src/data/areas";
import { FACETS_AREA } from "../src/data/map";
import { reachQuery } from "../src/data/reach";
import { MAP_KEY } from "../src/keys";
import { focus, mapModule } from "../src/modules/map";
import type { Runtime } from "../src/runtime";
import { sampleAccess } from "./fixtures/access";
import { NOW, SAMPLE_FACETS, SAMPLE_KINDS, SAMPLE_LEGAL } from "./fixtures/data";
import { routeTransport, type SentRequest, seededRuntime } from "./harness";

type Section = CanvasBoardView["sections"][number];
type Leaf = Extract<Section, { kind: "columns" }>["columns"][number]["sections"][number];

const D = "@opendes.dataservices.energy";
const board = expectView(MAP_KEY, "board");
const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MARCUS = oid(4);
const RACHEL = oid(11);

// Editors are nested in data.default.*, ops reach every group the way data root does,
// and Marcus is a direct member of data.pilot.viewers.
function access(): AccessRead {
  const read = sampleAccess();
  const c = read.closures as NonNullable<AccessRead["closures"]>;
  const def = [`data.default.viewers${D}`, `data.default.owners${D}`];
  const every = [
    ...def,
    `data.vendor.viewers${D}`,
    `data.pilot.viewers${D}`,
    `data.legacy.viewers${D}`,
    `data.pilot.owners${D}`,
  ];
  return {
    ...read,
    closures: {
      ...c,
      editors: [...c.editors, ...def],
      admins: [...c.admins, ...def],
      ops: [...c.ops, ...every],
    },
  };
}

const SEED = {
  [KINDS_AREA]: { ...SAMPLE_KINDS, visible: 1_284_512 },
  [LEGAL_AREA]: SAMPLE_LEGAL,
  [FACETS_AREA]: SAMPLE_FACETS,
  [ACCESS_AREA]: access(),
};

const COUNTS: Record<number, number> = { 2: 1_194_078, 3: 1_194_078, 6: 1_284_512 };

function transport() {
  return routeTransport({
    "POST /api/search/v2/query": (req: SentRequest) => {
      const body = req.body as { aggregateBy?: string; query?: string };
      if (body.aggregateBy) {
        const aggregations = body.query?.includes("data.pilot.viewers")
          ? [{ key: "opendes-pilot-trial", count: 8_400 }]
          : body.query?.startsWith("acl.viewers:")
            ? [{ key: "opendes-public-usa-dataset", count: 702_410 }]
            : [];
        return { status: 200, body: { results: [], aggregations } };
      }
      const groups = (body.query?.split(" OR acl.owners:")[0]?.match(/"/g)?.length ?? 0) / 2;
      return { status: 200, body: { results: [], totalCount: COUNTS[groups] ?? 0 } };
    },
    [`GET /api/entitlements/v2/groups/${encodeURIComponent(`data.pilot.viewers${D}`)}`]: () => ({
      status: 200,
      body: { members: [{ email: MARCUS, role: "MEMBER" }, { email: `users.data.root${D}` }] },
    }),
    "GET /api/entitlements/v2/groups/": () => ({ status: 200, body: { members: [] } }),
  });
}

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

describe("people lens", () => {
  test("the query covers readers and owners of every group in the set", () => {
    expect(reachQuery(["a", 'b"c'])).toBe(
      'acl.viewers:("a" OR "b\\"c") OR acl.owners:("a" OR "b\\"c")',
    );
  });

  test("people rank by the records their groups open, and gates come first", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: transport().transport });
    expect(await act(MAP_LENS_ACTION, rt, { lens: "people" })).toEqual({ ok: true });
    const left = column(draw(rt), 0);
    const strip = left[0];
    expect(
      strip?.kind === "actions" && strip.items.find((i) => i.label.startsWith("People"))?.label,
    ).toBe("People · 35");
    const items = rows(left, "People and apps · stopped first");
    expect(items[0]).toMatchObject({
      chip: { label: "no users@", tone: "error" },
      text: "Rachel Kim",
      trailing: "reaches nothing · Editor",
    });
    expect(items[0]?.selected).toBeUndefined();
    expect(items[1]?.selected).toBe(true);
    expect(items[1]).toMatchObject({
      text: "Ingrid Halvorsen (you)",
      trailing: "1,284,512 · 100% · Ops",
    });
    const marcus = items.find((r) => r.text === "Marcus Oyelaran");
    expect(marcus?.trailing).toBe("1,194,078 · 93% · Editor");
    expect(items.at(-1)?.text).toMatch(/^… \d+ more people and apps$/);
  });

  test("a person shows each path in and what they cannot reach", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: transport().transport });
    await act(MAP_LENS_ACTION, rt, { lens: "people" });
    expect(await act(MAP_SELECT_ACTION, rt, { lens: "people", key: MARCUS })).toEqual({ ok: true });
    await focus(rt);
    const right = column(draw(rt), 1);
    const paths = rows(right, "Paths in · 3");
    expect(paths.map((r) => [r.text, r.trailing])).toEqual([
      ["data.default.viewers", "through users.datalake.editors · 1,194,078"],
      ["data.pilot.viewers", "direct member · 48,400"],
      ["data.default.owners", "through users.datalake.editors · 1,194,078"],
    ]);
    expect(rows(right, "Cannot reach · 3").map((r) => r.text)).toEqual([
      "data.vendor.viewers",
      "data.legacy.viewers",
      "data.pilot.owners",
    ]);
    const flow = right.find((x) => x.kind === "flow");
    expect(
      flow?.kind === "flow" && flow.nodes.filter((x) => x.selected).map((x) => x.label),
    ).toEqual(["data.default.viewers", "data.pilot.viewers"]);
  });

  test("someone outside users@ reaches nothing, whatever their role", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: transport().transport });
    await act(MAP_LENS_ACTION, rt, { lens: "people" });
    expect(await act(MAP_SELECT_ACTION, rt, { lens: "people", key: RACHEL })).toEqual({ ok: true });
    const right = column(draw(rt), 1);
    const card = right.find((x) => x.kind === "cards");
    expect(card?.kind === "cards" && card.items[0]).toMatchObject({
      title: "Rachel Kim",
      pill: { label: "no users@", tone: "error" },
      reason: { label: "Reaches nothing" },
    });
    expect(rows(right, "Paths in · 2").map((r) => r.glyph)).toEqual(["neutral", "neutral"]);
  });

  test("a reader group names the role groups nested in it and its direct members", async () => {
    const rt = seededRuntime(SEED, { now: NOW, transport: transport().transport });
    await act(MAP_LENS_ACTION, rt, { lens: "viewers" });
    await act(MAP_SELECT_ACTION, rt, { lens: "viewers", key: `data.pilot.viewers${D}` });
    const who = rows(column(draw(rt), 1), "Who can reach it");
    expect(who.map((r) => [r.text, r.trailing])).toEqual([
      ["users.datalake.ops", "2 members · nested"],
      ["Marcus Oyelaran", "Editor · direct"],
    ]);
  });
});
