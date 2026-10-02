import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { SIGNIN_REASON } from "../src/boards/connection";
import {
  CLEAR_ACTION,
  composeRecords,
  NEXT_ACTION,
  PREV_ACTION,
  SEARCH_ACTIONS,
} from "../src/boards/records";
import { KINDS_AREA } from "../src/data/areas";
import {
  activeSearch,
  buildQuery,
  FIRST_PAGE_REASON,
  instanceOf,
  LAST_PAGE_REASON,
  pageInfo,
  type RecordQuery,
  searchBody,
  setSearch,
  WINDOW_REASON,
} from "../src/data/records";
import { RECORDS_KEY } from "../src/keys";
import { recordsModule } from "../src/modules/records";
import type { Runtime } from "../src/runtime";
import { NOW, SAMPLE_KINDS } from "./fixtures/data";
import { routeTransport, type SentRequest, seededRuntime } from "./harness";

const board = expectView(RECORDS_KEY, "board");
const WELLS = "osdu:wks:master-data--Well:*";
const WELL_TOTAL = 88_104;

function built(mode: Parameters<typeof buildQuery>[0], input: Record<string, unknown>) {
  const res = buildQuery(mode, input);
  if (!res.ok) throw new Error(res.error);
  return res.query;
}

function wellHit(i: number) {
  return {
    id: `opendes:master-data--Well:${8690 + i}`,
    kind: "osdu:wks:master-data--Well:1.2.0",
    version: 1_790_000_000_000_000 + i,
    createTime: "2026-09-01T08:00:00.000Z",
    modifyTime: "2026-09-30T10:12:00.000Z",
    legal: {
      legaltags: ["opendes-public-norway"],
      otherRelevantDataCountries: ["NO"],
      status: i === 1 ? "incompliant" : "compliant",
    },
    acl: {
      viewers: ["data.default.viewers@opendes.dataservices.energy"],
      owners: ["data.default.owners@opendes.dataservices.energy"],
    },
    data: { FacilityName: `NO 15/9-F-${i + 1}` },
  };
}

function searchRoutes(total = WELL_TOTAL) {
  return routeTransport({
    "POST /api/search/v2/query": (req: SentRequest) => {
      const body = req.body as { offset: number; limit: number };
      const n = Math.max(0, Math.min(body.limit, total - body.offset));
      return {
        status: 200,
        body: {
          results: Array.from({ length: n }, (_, i) => wellHit(body.offset + i)),
          aggregations: null,
          phraseSuggestions: [],
          totalCount: total,
        },
      };
    },
  });
}

function wired(transport = searchRoutes()) {
  const rt = seededRuntime({ [KINDS_AREA]: SAMPLE_KINDS }, { transport: transport.transport });
  const recomposed: string[][] = [];
  rt.recompose = (keys) => {
    recomposed.push([...keys]);
  };
  return { rt, recomposed, sent: transport.sent };
}

function frame(rt: Runtime): CanvasBoardView {
  const compose = recordsModule.composers?.[RECORDS_KEY];
  if (!compose) throw new Error("no records composer");
  return board(compose(rt)) as CanvasBoardView;
}

function act(rt: Runtime, type: string, payload?: unknown) {
  const handle = recordsModule.actions?.[type];
  if (!handle) throw new Error(`no action ${type}`);
  return handle(rt, payload);
}

function columns(view: CanvasBoardView) {
  const section = view.sections[0];
  if (section?.kind !== "columns") throw new Error("expected a columns section");
  return section.columns;
}

function leaf<K extends string>(view: CanvasBoardView, col: number, kind: K) {
  const found = columns(view)[col]?.sections.find((s) => s.kind === kind);
  if (!found) throw new Error(`no ${kind} in column ${col}`);
  return found as Extract<CanvasBoardView["sections"][number], { kind: K }>;
}

function pager(view: CanvasBoardView) {
  const actions = columns(view)[1]?.sections.find((s) => s.kind === "actions");
  if (actions?.kind !== "actions") throw new Error("no pager");
  return actions;
}

describe("query building", () => {
  test("by kind carries the kind and the optional Lucene query", () => {
    expect(searchBody(built("kind", { kind: WELLS }), 0)).toEqual({
      kind: WELLS,
      offset: 0,
      limit: 25,
      trackTotalCount: true,
      returnedFields: [
        "id",
        "kind",
        "version",
        "createTime",
        "modifyTime",
        "legal",
        "acl",
        "data.FacilityName",
        "data.Name",
      ],
    });
    const q = built("kind", { kind: WELLS, query: ' data.FacilityName:"NO 15/9*" ' });
    expect(searchBody(q, 0)).toMatchObject({ kind: WELLS, query: 'data.FacilityName:"NO 15/9*"' });
  });

  test("by kind refuses a kind that is not four parts", () => {
    expect(buildQuery("kind", { kind: "Well" })).toMatchObject({ ok: false });
    expect(buildQuery("kind", {})).toMatchObject({ ok: false });
  });

  test("by id, ACL group and legal tag quote the value across all kinds", () => {
    expect(searchBody(built("id", { id: "opendes:master-data--Well:8690" }), 0)).toMatchObject({
      kind: "*:*:*:*",
      query: 'id:"opendes:master-data--Well:8690"',
    });
    expect(
      searchBody(built("acl", { group: "data.default.viewers@opendes.dataservices.energy" }), 0),
    ).toMatchObject({
      kind: "*:*:*:*",
      query:
        'acl.viewers:"data.default.viewers@opendes.dataservices.energy" OR acl.owners:"data.default.viewers@opendes.dataservices.energy"',
    });
    expect(searchBody(built("legal", { tag: "opendes-pilot-trial" }), 0)).toMatchObject({
      kind: "*:*:*:*",
      query: 'legal.legaltags:"opendes-pilot-trial"',
    });
    expect(built("id", { id: 'a"b' }).query).toBe('id:"a\\"b"');
  });

  test("Lucene passes the query through over every kind", () => {
    expect(searchBody(built("lucene", { query: "data.Name:F*" }), 0)).toMatchObject({
      kind: "*:*:*:*",
      query: "data.Name:F*",
    });
  });

  test("an empty value is refused with a reason", () => {
    for (const mode of ["id", "lucene", "acl", "legal"] as const) {
      const res = buildQuery(mode, { id: " ", query: "", group: "", tag: "" });
      expect(res.ok).toBe(false);
    }
  });
});

describe("offset paging", () => {
  test("pages are 25 records at offset page * 25", () => {
    const q = built("kind", { kind: WELLS });
    expect(searchBody(q, 0)).toMatchObject({ offset: 0, limit: 25 });
    expect(searchBody(q, 3)).toMatchObject({ offset: 75, limit: 25 });
  });

  test("Prev stops on page 1 and Next on the last page", () => {
    expect(pageInfo(WELL_TOTAL, 0)).toEqual({
      page: 0,
      pages: 3_525,
      prev: { ok: false, reason: FIRST_PAGE_REASON },
      next: { ok: true },
    });
    expect(pageInfo(30, 1).next).toEqual({ ok: false, reason: LAST_PAGE_REASON });
    expect(pageInfo(0, 0)).toMatchObject({ pages: 1, next: { ok: false } });
  });

  test("Next stops where offset + limit would pass 10,000", () => {
    expect(pageInfo(WELL_TOTAL, 398).next).toEqual({ ok: true });
    expect(pageInfo(WELL_TOTAL, 399).next).toEqual({ ok: false, reason: WINDOW_REASON });
    expect(pageInfo(null, 399).next).toEqual({ ok: false, reason: WINDOW_REASON });
    expect(pageInfo(null, 0)).toMatchObject({ pages: null, next: { ok: true } });
  });
});

describe("actions", () => {
  test("search, next, prev and clear recompose the region and draw the right page", async () => {
    const { rt, recomposed, sent } = wired();

    const resting = frame(rt);
    expect(leaf(resting, 1, "rows").items[0]?.text).toContain("Search by kind");

    expect(await act(rt, SEARCH_ACTIONS.kind, { kind: WELLS, query: "" })).toEqual({ ok: true });
    expect(recomposed.at(-1)).toEqual([RECORDS_KEY]);
    expect(sent.at(-1)?.body).toMatchObject({ kind: WELLS, offset: 0, limit: 25 });
    expect(sent.at(-1)?.headers["data-partition-id"]).toBe("opendes");
    let view = frame(rt);
    expect(view.header?.chip).toBe(`kind: ${WELLS} · 88,104 hits`);
    let rows = leaf(view, 1, "rows");
    expect(rows.title).toBe(`88,104 records · kind ${WELLS} · page 1 of 3,525`);
    expect(rows.items).toHaveLength(25);
    expect(rows.items[0]).toMatchObject({
      chip: { label: "compliant", tone: "ok" },
      text: "opendes:master-data--Well:8690",
      trailing: "NO 15/9-F-1 · Well 1.2.0 · modified 2026-09-30",
    });
    expect(rows.items[1]?.chip).toEqual({ label: "incompliant", tone: "warn" });
    expect(rows.items[0]?.trailing).not.toMatch(/\bv\d/);
    expect(pager(view).title).toBe(
      "Showing 25 of 25 on this page · 25 per page, paged by the server",
    );
    expect(pager(view).items.map((a) => [a.label, a.disabled ?? false, a.reason])).toEqual([
      ["Prev", true, FIRST_PAGE_REASON],
      ["Next 25", false, undefined],
      ["Clear", false, undefined],
    ]);

    expect(await act(rt, NEXT_ACTION)).toEqual({ ok: true });
    expect(sent.at(-1)?.body).toMatchObject({ offset: 25 });
    view = frame(rt);
    rows = leaf(view, 1, "rows");
    expect(rows.title).toBe(`88,104 records · kind ${WELLS} · page 2 of 3,525`);
    expect(rows.items[0]?.text).toBe("opendes:master-data--Well:8715");
    expect(pager(view).items[0]?.disabled).toBeUndefined();

    expect(await act(rt, PREV_ACTION)).toEqual({ ok: true });
    expect(sent.at(-1)?.body).toMatchObject({ offset: 0 });
    expect(leaf(frame(rt), 1, "rows").title).toContain("page 1 of 3,525");
    expect(await act(rt, PREV_ACTION)).toEqual({ ok: false, error: FIRST_PAGE_REASON });

    const calls = sent.length;
    expect(await act(rt, CLEAR_ACTION)).toEqual({ ok: true });
    expect(recomposed.at(-1)).toEqual([RECORDS_KEY]);
    expect(sent.length).toBe(calls);
    view = frame(rt);
    expect(leaf(view, 1, "rows").items[0]?.text).toContain("Search by kind");
    expect(view.header?.chip).toBe("214 kinds");
  });

  test("the By kind form opens by default and remembers the active kind", async () => {
    const { rt } = wired();
    let tabs = leaf(frame(rt), 0, "actions");
    expect(tabs.tabs).toBe(true);
    expect(tabs.items.map((a) => a.label)).toEqual([
      "By kind",
      "By id",
      "Lucene",
      "By ACL group",
      "By legal tag",
    ]);
    expect(tabs.items[0]?.defaultOpen).toBe(true);
    expect(tabs.items[0]?.fields?.[0]?.defaultValue).toBe(WELLS);

    await act(rt, SEARCH_ACTIONS.kind, { kind: "osdu:wks:master-data--Wellbore:*" });
    tabs = leaf(frame(rt), 0, "actions");
    expect(tabs.items[0]?.fields?.[0]?.defaultValue).toBe("osdu:wks:master-data--Wellbore:*");
  });

  test("a bad query or a refused search returns a readable error and keeps the last page", async () => {
    const { rt, sent } = wired();
    expect(await act(rt, SEARCH_ACTIONS.kind, { kind: "Well" })).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);

    await act(rt, SEARCH_ACTIONS.kind, { kind: WELLS });
    const refusing = routeTransport({
      "POST /api/search/v2/query": () => ({ status: 403, body: { message: "Access denied" } }),
    });
    const other = seededRuntime({}, { transport: refusing.transport });
    expect(await act(other, SEARCH_ACTIONS.lucene, { query: "data.Name:F*" })).toEqual({
      ok: false,
      error: "search refused this sign-in (403): Access denied",
    });
    expect(activeSearch(other)).toBeUndefined();
    expect(activeSearch(rt)?.query.kind).toBe(WELLS);
  });

  test("paging stops at the 10,000 search window with a reason to narrow", () => {
    const { rt } = wired();
    const query: RecordQuery = { mode: "kind", kind: WELLS, subject: WELLS };
    setSearch(rt, {
      instance: instanceOf(rt.profile),
      query,
      page: 399,
      result: { total: WELL_TOTAL, records: [] },
      at: NOW.toISOString(),
    });
    const next = pager(frame(rt)).items.find((a) => a.label === "Next 25");
    expect(next).toMatchObject({ disabled: true, reason: WINDOW_REASON });
    expect(WINDOW_REASON).toContain("narrow the query");
  });
});

describe("top kinds", () => {
  test("six named bars and one for the rest, the active kind accented", async () => {
    const { rt } = wired();
    let bars = leaf(frame(rt), 0, "bars");
    expect(bars.title).toBe("Top kinds · share of 1,284,512 records");
    expect(bars.items).toHaveLength(7);
    expect(bars.items[0]).toMatchObject({
      label: "osdu:wks:work-product-component--WellLog:1.2.0",
      value: 412_300,
      total: 1_284_512,
      trailing: "412,300",
    });
    expect(bars.items[6]).toMatchObject({
      label: "208 more kinds",
      value: 393_216,
      trailing: "393,216",
    });
    expect(bars.items.some((b) => b.tone === "accent")).toBe(false);

    await act(rt, SEARCH_ACTIONS.kind, { kind: WELLS });
    bars = leaf(frame(rt), 0, "bars");
    expect(bars.items.filter((b) => b.tone === "accent").map((b) => b.label)).toEqual([
      "osdu:wks:master-data--Well:1.2.0",
    ]);
  });

  test("unmeasured kinds draw as ?, not as zero", () => {
    const rt = seededRuntime({});
    const rows = leaf(frame(rt), 0, "rows");
    expect(rows.items[0]?.trailing).toBe("?");
  });
});

describe("phases", () => {
  test("not connected publishes no sections so the region hides", () => {
    const view = frame(seededRuntime({}, { phase: "firstrun" }));
    expect(view.sections).toEqual([]);
  });

  test("sign-in needed keeps the results readable and disables every live read", async () => {
    const { rt, sent } = wired();
    await act(rt, SEARCH_ACTIONS.kind, { kind: WELLS });
    await act(rt, NEXT_ACTION);
    rt.status = { ...rt.status, phase: "signin", error: "expired" };

    const view = frame(rt);
    expect(view.header?.status).toEqual({ label: "sign-in needed", tone: "error" });
    expect(view.header?.chip).toBe(`kind: ${WELLS} · 88,104 hits · cached from 14:05Z`);
    for (const tab of leaf(view, 0, "actions").items) {
      expect(tab).toMatchObject({ disabled: true, reason: SIGNIN_REASON });
    }
    const [prev, next, clear] = pager(view).items;
    expect(prev).toMatchObject({ disabled: true, reason: SIGNIN_REASON });
    expect(next).toMatchObject({ disabled: true, reason: SIGNIN_REASON });
    expect(clear?.disabled).toBeUndefined();
    expect(leaf(view, 1, "rows").items).toHaveLength(25);

    const calls = sent.length;
    expect(await act(rt, NEXT_ACTION)).toEqual({ ok: false, error: SIGNIN_REASON });
    expect(await act(rt, SEARCH_ACTIONS.id, { id: "x" })).toEqual({
      ok: false,
      error: SIGNIN_REASON,
    });
    expect(sent.length).toBe(calls);
  });

  test("a search from another instance is not drawn", async () => {
    const { rt } = wired();
    await act(rt, SEARCH_ACTIONS.kind, { kind: WELLS });
    const profile = rt.profile;
    if (!profile) throw new Error("no profile");
    rt.status = { ...rt.status, profile: { ...profile, partition: "other" } };
    expect(activeSearch(rt)).toBeUndefined();
    expect(leaf(frame(rt), 1, "rows").items[0]?.text).toContain("Search by kind");
  });

  test("every frame passes the board validator", async () => {
    const composed = [
      composeRecords({ status: { phase: "firstrun" } }),
      composeRecords({ status: { phase: "profile-error", error: "x" } }),
    ];
    const { rt } = wired(searchRoutes(0));
    composed.push(frame(rt));
    await act(rt, SEARCH_ACTIONS.legal, { tag: "opendes-legacy-training" });
    const empty = frame(rt);
    expect(leaf(empty, 1, "rows").items[0]?.text).toBe("No records match this query.");
    composed.push(empty);
    rt.status = { ...rt.status, phase: "signin" };
    composed.push(frame(rt));
    for (const view of composed) expect(() => board(view)).not.toThrow();
  });
});
