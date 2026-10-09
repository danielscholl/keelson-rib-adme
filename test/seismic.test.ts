import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { ACCESS_AREA, ACCESS_AREAS } from "../src/access/read";
import { RETEST_ACTION } from "../src/boards/connection";
import { composePeople, PEOPLE_FILTER_ACTION, PEOPLE_VIEW_ACTION } from "../src/boards/people";
import {
  composeSeismicPulse,
  composeSeismicSelected,
  composeSeismicSubprojects,
  FLOW_SUBPROJECTS,
  measuredSeismic,
  SEIS_READ_ACTION,
  SEIS_SELECT_ACTION,
  seismicHeadline,
} from "../src/boards/seismic";
import { DATA_AREAS } from "../src/data/areas";
import { HEALTH_AREA } from "../src/data/health";
import {
  PEOPLE_KEY,
  SEIS_CHANGE_KEY,
  SEIS_PULSE_KEY,
  SEIS_SELECTED_KEY,
  SEIS_SUBPROJECTS_KEY,
} from "../src/keys";
import { accessModule } from "../src/modules/access";
import { seismicModule } from "../src/modules/seismic";
import type { Runtime } from "../src/runtime";
import { setSection } from "../src/section";
import { buildSeismic, countSeismic } from "../src/seismic/model";
import { fromOwnGroups, SEISMIC_AREA, type SeismicRead } from "../src/seismic/read";
import { REFRESH_ACTION } from "../src/surfaces";
import { SIGNED_IN_AS, sampleAccess, sampleCohortCsv } from "./fixtures/access";
import { NOW, SAMPLE_HEALTH } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import {
  groupEmail,
  sampleGroupMembers,
  sampleSeismic,
  sampleSubprojectList,
} from "./fixtures/seismic";
import { routeTransport, type SentRequest, seededRuntime } from "./harness";

const pulseBoard = expectView(SEIS_PULSE_KEY, "board");
const subprojectsBoard = expectView(SEIS_SUBPROJECTS_KEY, "board");
const selectedBoard = expectView(SEIS_SELECTED_KEY, "board");

type Section = CanvasBoardView["sections"][number];

function section<K extends Section["kind"]>(view: CanvasBoardView, kind: K) {
  return view.sections.find((s): s is Extract<Section, { kind: K }> => s.kind === kind);
}

function all<K extends Section["kind"]>(view: CanvasBoardView, kind: K) {
  const flat: Section[] = view.sections.flatMap((s) =>
    s.kind === "columns" ? (s.columns.flatMap((c) => c.sections) as Section[]) : [s],
  );
  return flat.filter((s): s is Extract<Section, { kind: K }> => s.kind === kind);
}

function tiles(view: CanvasBoardView) {
  return Object.fromEntries(
    (section(view, "stats")?.items ?? []).map((t) => [t.label, { value: t.value, sub: t.sub }]),
  );
}

const pulse = (rt: Runtime) => pulseBoard(composeSeismicPulse(rt)) as CanvasBoardView;
const subprojects = (rt: Runtime) =>
  subprojectsBoard(composeSeismicSubprojects(rt)) as CanvasBoardView;
const selected = (rt: Runtime) => selectedBoard(composeSeismicSelected(rt)) as CanvasBoardView;

const SEED = {
  [ACCESS_AREA]: sampleAccess(),
  [HEALTH_AREA]: SAMPLE_HEALTH,
  [SEISMIC_AREA]: sampleSeismic(),
};

const ctx = {
  directory: sampleAccess().directory,
  signedInAs: SIGNED_IN_AS,
  admeAppId: SAMPLE_PROFILE.admeAppId,
};

function act(rt: Runtime, type: string, payload?: unknown) {
  const handler = seismicModule.actions?.[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  return handler(rt, payload);
}

const OPERATOR_ID = "00000000-0000-4000-8000-000000000001";

function seismicRoutes(
  opts: { refuseList?: boolean; refuse?: string[]; own?: string[] } = {},
): Record<string, (req: SentRequest) => { status: number; body?: unknown }> {
  const members = sampleGroupMembers();
  return {
    "GET /seistore-svc/api/v3/subproject/tenant/opendes": () =>
      opts.refuseList
        ? { status: 403, body: "[seismic-store-service] User not authorized" }
        : { status: 200, body: sampleSubprojectList() },
    "GET /api/entitlements/v2/groups/": (req) => {
      const email = decodeURIComponent(
        req.url.split("/groups/")[1]?.replace(/\/members$/, "") ?? "",
      );
      if (opts.refuse?.includes(email)) return { status: 403, body: { message: "Forbidden" } };
      const list = members[email];
      return list ? { status: 200, body: { members: list } } : { status: 404 };
    },
    "GET /api/entitlements/v2/groups": () => ({
      status: 200,
      body: {
        desId: OPERATOR_ID,
        memberEmail: OPERATOR_ID,
        groups: (opts.own ?? []).map((email) => ({ name: email.split("@")[0], email })),
      },
    }),
  };
}

describe("seismic model", () => {
  const model = buildSeismic(sampleSeismic(), ctx);
  const byName = (n: string) => model.subprojects.find((s) => s.name === n);
  const names = (n: string, role: "admins" | "viewers") => {
    const s = byName(n)?.[role];
    return s?.kind === "members" ? s.members.map((m) => m.name) : s?.kind;
  };

  test("inverts group member lists into members by name, people before applications", () => {
    expect(names("alpha", "admins")).toEqual(["Ingrid Halvorsen", "Priya Nair", "Tomas Reyes"]);
    expect(names("alpha", "viewers")).toEqual([
      "Marcus Oyelaran",
      "contoso-adme-tier-admin",
      "contoso-adme-tier-editor",
      "contoso-adme-tier-viewer",
    ]);
    const alpha = byName("alpha");
    expect(alpha?.path).toBe("sd://opendes/alpha");
    expect(alpha?.legalTag).toBe("opendes-public-usa-dataset");
    expect(alpha?.accessPolicy).toBe("uniform");
  });

  test("the root app and users.data.root are structure, not grants", () => {
    const all = Object.values(model.members).map((m) => m.name);
    expect(all).not.toContain("contoso-adme-root-app");
    expect(all.some((n) => n.startsWith("users.data.root"))).toBe(false);
    expect(byName("subproject-legacy")?.empty).toBe(true);
  });

  test("grants per person follow the spec's cast", () => {
    const grantsOf = (name: string) => {
      const id = Object.values(model.members).find((m) => m.name === name)?.id ?? "";
      return (model.grants[id] ?? []).map((g) => `${g.subproject} ${g.role}`);
    };
    expect(grantsOf("Marcus Oyelaran")).toEqual(["alpha viewer", "delta viewer"]);
    expect(grantsOf("Priya Nair")).toEqual(["alpha admin", "bravo admin"]);
    expect(grantsOf("Dmitri Volkov")).toEqual(["golf viewer"]);
    expect(Object.values(model.members).find((m) => m.you)?.name).toBe("Ingrid Halvorsen");
  });

  test("counts: 13 subprojects, 11 own, 2 default, 1 empty, 9 people with grants", () => {
    expect(countSeismic(model)).toEqual({
      subprojects: 13,
      own: 11,
      defaults: ["volve", "drogon"],
      empty: ["subproject-legacy"],
      peopleWithGrants: 9,
    });
    expect(model.partial).toBe(false);
  });

  test("default ACL roles are marked as reached through data.default", () => {
    expect(byName("volve")?.viewers).toEqual({ kind: "default", group: "data.default.viewers" });
    expect(byName("volve")?.admins).toEqual({ kind: "default", group: "data.default.owners" });
    expect(byName("drogon")?.acl).toBe("default");
    expect(names("drogon", "admins")).toEqual([]);
  });

  test("an id the access read does not know reads as its short id", () => {
    const read = sampleSeismic();
    const email = groupEmail("golf2", "viewer");
    read.groups[email] = { members: ["0badc0de-0000-4000-8000-00000000beef"] };
    const m = buildSeismic(read, ctx).subprojects.find((s) => s.name === "golf2");
    expect(m?.viewers).toMatchObject({ kind: "members", members: [{ kind: "unknown" }] });
  });
});

describe("seismic read", () => {
  test("lists subprojects and reads every own group's members with GETs only", async () => {
    const { transport, sent } = routeTransport(seismicRoutes());
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    expect(await act(rt, SEIS_READ_ACTION)).toEqual({ ok: true });
    const read = rt.cache.get<SeismicRead>(SEISMIC_AREA).data;
    expect(read?.source).toBe("list");
    expect(read?.subprojects).toHaveLength(13);
    expect(sent.every((r) => r.method === "GET")).toBe(true);
    // Two groups for each of the 11 own-ACL subprojects, plus drogon's own admin group.
    expect(sent.filter((r) => r.url.includes("/members"))).toHaveLength(23);
    expect(sent.some((r) => r.url.includes("data.default"))).toBe(false);
    expect(countSeismic(buildSeismic(read as SeismicRead, ctx)).peopleWithGrants).toBe(9);
  });

  test("refused member lists fall back to your own groups and mark the read partial", async () => {
    const refused = groupEmail("bravo", "admin");
    const { transport } = routeTransport(seismicRoutes({ refuse: [refused], own: [refused] }));
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    await act(rt, SEIS_READ_ACTION);
    const read = rt.cache.get<SeismicRead>(SEISMIC_AREA).data as SeismicRead;
    expect(read.groups[refused]).toMatchObject({ refused: true });
    const model = buildSeismic(read, ctx);
    expect(model.partial).toBe(true);
    expect(model.subprojects.find((s) => s.name === "bravo")?.admins).toEqual({
      kind: "unread",
      reason: "listing members was refused",
      you: true,
    });
    const view = pulse(seededRuntime({ ...SEED, [SEISMIC_AREA]: read }, { now: NOW }));
    expect(view.header?.status?.tone).toBe("caution");
    expect(tiles(view)["People with grants"]?.sub).toContain("partial read");
    const rows = all(
      subprojects(seededRuntime({ ...SEED, [SEISMIC_AREA]: read }, { now: NOW })),
      "rows",
    );
    const bravo = rows[0]?.items.find((r) => r.text === "bravo");
    expect(bravo).toMatchObject({
      chip: { label: "partial", tone: "warn" },
      trailing: "? reach it",
    });
  });

  test("a refused subproject list falls back to data.sdms groups you are in", async () => {
    const own = [
      groupEmail("alpha", "admin"),
      groupEmail("golf", "admin"),
      "users.datalake.ops@opendes.dataservices.energy",
    ];
    const { transport } = routeTransport(seismicRoutes({ refuseList: true, own }));
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    expect(await act(rt, SEIS_READ_ACTION)).toEqual({ ok: true });
    const read = rt.cache.get<SeismicRead>(SEISMIC_AREA).data as SeismicRead;
    expect(read.source).toBe("own-groups");
    expect(read.subprojects.map((s) => s.name)).toEqual(["alpha", "golf"]);
    const model = buildSeismic(read, ctx);
    expect(model.partial).toBe(true);
    const alpha = model.subprojects.find((s) => s.name === "alpha");
    expect(alpha?.admins.kind).toBe("members");
    expect(alpha?.viewers).toMatchObject({ kind: "unread", reason: "group not known" });
    const view = pulse(seededRuntime({ ...SEED, [SEISMIC_AREA]: read }, { now: NOW }));
    expect(section(view, "rows")?.items[0]?.text).toStartWith("at least 2 subprojects; at least ");
  });

  test("the parser ignores other tenants and non-seismic groups", () => {
    const subs = fromOwnGroups("opendes", [
      "data.sdms.opendes.alpha.admin@opendes.dataservices.energy",
      "data.sdms.other.bravo.viewer@opendes.dataservices.energy",
      "data.default.viewers@opendes.dataservices.energy",
    ]);
    expect(subs).toEqual([
      {
        name: "alpha",
        admins: ["data.sdms.opendes.alpha.admin@opendes.dataservices.energy"],
        viewers: [],
      },
    ]);
  });

  test("the tier-1 sweep never reads the seismic store", async () => {
    const { transport, sent } = routeTransport(seismicRoutes());
    const rt = seededRuntime({}, { now: NOW, transport });
    for (const area of [...ACCESS_AREAS, ...DATA_AREAS]) rt.addArea(area);
    expect(seismicModule.areas).toBeUndefined();
    await rt.sweep();
    expect(sent.some((r) => r.url.includes("/subproject/"))).toBe(false);
    expect(rt.cache.get(SEISMIC_AREA).at).toBeUndefined();
  });

  test("Refresh now reads the store only while the Seismic section shows", async () => {
    const { transport, sent } = routeTransport(seismicRoutes());
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    await act(rt, REFRESH_ACTION);
    expect(sent.some((r) => r.url.includes("/subproject/"))).toBe(false);
    setSection(rt, "seismic");
    await act(rt, REFRESH_ACTION);
    expect(sent.some((r) => r.url.includes("/subproject/tenant/opendes"))).toBe(true);
    expect(rt.cache.get(SEISMIC_AREA).at).toBeDefined();
  });

  test("Re-test reads the store only once the section has been used", async () => {
    const { transport, sent } = routeTransport(seismicRoutes());
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    await act(rt, RETEST_ACTION);
    expect(rt.cache.get(SEISMIC_AREA).at).toBeUndefined();
    await act(rt, SEIS_READ_ACTION);
    const reads = () => sent.filter((r) => r.url.includes("/groups/data.sdms")).length;
    const before = reads();
    rt.status = { ...rt.status, phase: "connected" };
    rt.cache.fail(SEISMIC_AREA, "stale", NOW);
    await act(rt, RETEST_ACTION);
    expect(reads()).toBeGreaterThanOrEqual(before);
  });

  test("a failed read is recorded and offers Try again", async () => {
    const { transport } = routeTransport({
      "GET /seistore-svc/api/v3/subproject/tenant/opendes": () => ({
        status: 400,
        body: { message: "bad tenant" },
      }),
    });
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    expect(await act(rt, SEIS_READ_ACTION)).toMatchObject({ ok: false });
    const view = pulse(rt);
    expect(section(view, "rows")?.items[0]?.text).toContain("bad tenant");
    expect(section(view, "actions")?.items[0]).toMatchObject({
      type: SEIS_READ_ACTION,
      label: "Try again",
    });
  });
});

describe("seismic pulse", () => {
  test("the sample cast reproduces the spec's status, chip and tiles", () => {
    const view = pulse(seededRuntime(SEED, { now: NOW }));
    expect(view.header?.status).toEqual({ label: "13 subprojects · service ok", tone: "ok" });
    expect(view.header?.chip).toBe("sd://opendes · measured 14:05Z");
    expect(tiles(view)).toEqual({
      Subprojects: { value: 13, sub: "11 own ACL, 2 default" },
      "People with grants": { value: 9, sub: "of 32 people" },
      "On default ACL": { value: 2, sub: "volve, drogon" },
      "No members": { value: 1, sub: "subproject-legacy" },
    });
    expect(section(view, "stats")?.items.find((t) => t.label === "No members")?.tone).toBe(
      "caution",
    );
    expect(section(view, "rows")?.items[0]?.text).toBe(
      "13 subprojects; 9 of 32 people hold a grant; 2 rely on the default ACL and 1 has no members.",
    );
  });

  test("the headline agrees with one grant holder", () => {
    const rt = seededRuntime(SEED, { now: NOW });
    const m = measuredSeismic(rt);
    if (!m) throw new Error("not measured");
    const one = { ...m, counts: { ...m.counts, peopleWithGrants: 1 } };
    expect(seismicHeadline(rt, one)).toStartWith("13 subprojects; 1 of 32 people holds a grant;");
  });

  test("not measured yet: a header that reads on first use, other regions hidden", () => {
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW });
    const view = pulse(rt);
    expect(view.header?.status).toEqual({ label: "not measured yet", tone: "neutral" });
    expect(view.header?.chip).toBe("sd://opendes · not measured yet");
    expect(section(view, "rows")?.items[0]?.text).toContain("on first use");
    expect(section(view, "actions")?.items[0]).toMatchObject({
      type: SEIS_READ_ACTION,
      label: "Read subprojects",
    });
    expect(Object.values(tiles(view)).every((t) => t.value === null)).toBe(true);
    expect(subprojects(rt).sections).toEqual([]);
    expect(selected(rt).sections).toEqual([]);
  });

  test("not connected: the resting header, other regions hidden", () => {
    const rt = seededRuntime(SEED, { now: NOW, phase: "firstrun" });
    const view = pulse(rt);
    expect(view.header?.status?.label).toBe(
      "not connected, finish the connect steps in the header",
    );
    expect(Object.values(tiles(view)).every((t) => t.value === null)).toBe(true);
    expect(subprojects(rt).sections).toEqual([]);
    expect(selected(rt).sections).toEqual([]);
  });

  test("sign-in needed keeps the cached values, marked cached", () => {
    const rt = seededRuntime(SEED, { now: NOW, phase: "signin" });
    const view = pulse(rt);
    expect(view.header?.status).toEqual({ label: "sign-in needed", tone: "error" });
    expect(view.header?.chip).toBe("sd://opendes · cached from 14:05Z");
    expect(section(view, "cards")?.title).toBe("Sign in again");
    expect(tiles(view).Subprojects?.value).toBe(13);
    expect(all(subprojects(rt), "rows")[0]?.items).toHaveLength(13);
    expect(selected(rt).header?.chip).toBe("sd://opendes/alpha");
  });
});

describe("subprojects and the selected subproject", () => {
  test("subprojects ranked by who reaches them, beside a flow to people", () => {
    const view = subprojects(seededRuntime(SEED, { now: NOW }));
    expect(view.header?.status?.label).toBe("13 subprojects");
    expect(view.header?.chip).toBe("selected: alpha");
    const list = all(view, "rows")[0];
    expect(list?.items.map((r) => [r.text, r.chip?.label, r.trailing])).toEqual([
      ["volve", "default", "all 32 people"],
      ["drogon", "default", "all 32 people"],
      ["alpha", "own", "7 reach it"],
      ["delta", "own", "4 reach it"],
      ["bravo", "own", "3 reach it"],
      ["charlie", "own", "3 reach it"],
      ["sleipner", "own", "3 reach it"],
      ["echo", "own", "3 reach it"],
      ["foxtrot", "own", "3 reach it"],
      ["golf", "own", "3 reach it"],
      ["golf2", "own", "1 reaches it"],
      ["golf3", "own", "1 reaches it"],
      ["subproject-legacy", "empty", "0 reach it"],
    ]);
    expect(list?.items.filter((r) => r.selected).map((r) => r.text)).toEqual(["alpha"]);
    expect(list?.items.every((r) => r.action?.type === SEIS_SELECT_ACTION)).toBe(true);
    const flow = all(view, "flow")[0];
    const left = flow?.nodes.filter((n) => n.side === "left") ?? [];
    expect(left.filter((n) => !n.folded)).toHaveLength(FLOW_SUBPROJECTS);
    expect(left.find((n) => n.selected)?.label).toBe("alpha");
    const right = flow?.nodes.filter((n) => n.side === "right") ?? [];
    expect(right[0]).toMatchObject({
      label: "everyone with a data role",
      sublabel: "via data.default.viewers",
    });
    expect(
      right
        .filter((n) => n.selected)
        .map((n) => n.label)
        .sort(),
    ).toEqual([
      "Ingrid Halvorsen (you)",
      "Marcus Oyelaran",
      "Priya Nair",
      "Tomas Reyes",
      "contoso-adme-tier-admin",
      "contoso-adme-tier-editor",
      "contoso-adme-tier-viewer",
    ]);
    expect(flow?.links.find((l) => l.source === "s:volve")?.n).toBe(32);
  });

  test("the flow lights an empty selection and leaves out widths it cannot measure", async () => {
    const rt = seededRuntime(SEED, { now: NOW });
    await act(rt, SEIS_SELECT_ACTION, { subproject: "subproject-legacy" });
    const lit = all(subprojects(rt), "flow")[0]?.nodes.filter((n) => n.selected);
    expect(lit?.map((n) => n.label)).toEqual(["subproject-legacy"]);
    const unmeasured = seededRuntime(
      { [HEALTH_AREA]: SAMPLE_HEALTH, [SEISMIC_AREA]: sampleSeismic() },
      { now: NOW },
    );
    const flow = all(subprojects(unmeasured), "flow")[0];
    expect(flow?.nodes.some((n) => n.id.startsWith("d:"))).toBe(false);
    const volve = all(subprojects(unmeasured), "rows")[0]?.items.find((r) => r.text === "volve");
    expect(volve?.trailing).toBe("everyone with a data role");
  });

  test("the selected region names alpha's admins and viewers with copyable identifiers", () => {
    const view = selected(seededRuntime(SEED, { now: NOW }));
    expect(view.header?.status?.label).toBe("3 admins · 4 viewers");
    expect(view.header?.chip).toBe("sd://opendes/alpha");
    const ids = all(view, "cards")[0]?.items[0];
    expect(ids?.fields?.map((f) => [f.label, f.value, f.copyable ?? false])).toEqual([
      ["sd path", "sd://opendes/alpha", true],
      ["admin group", groupEmail("alpha", "admin"), true],
      ["viewer group", groupEmail("alpha", "viewer"), true],
      ["legal tag", "opendes-public-usa-dataset", true],
      ["access policy", "uniform", false],
    ]);
    const [admins, viewers] = all(view, "rows");
    expect(admins?.title).toBe("Admins · 3");
    expect(admins?.items.map((r) => [r.text, r.trailing])).toEqual([
      ["Ingrid Halvorsen (you)", "contoso.example"],
      ["Priya Nair", "halden-geo.example"],
      ["Tomas Reyes", "contoso.example"],
    ]);
    expect(viewers?.title).toBe("Viewers · 4");
    expect(viewers?.items.map((r) => r.trailing)).toEqual([
      "northfield.example",
      "application",
      "application",
      "application",
    ]);
  });

  test("clicking a row selects it and recomposes the selected region, no drawer", async () => {
    const recomposed: string[][] = [];
    const rt = seededRuntime(SEED, {
      now: NOW,
      recompose: (keys) => recomposed.push([...keys]),
    });
    setSection(rt, "seismic");
    const res = await act(rt, SEIS_SELECT_ACTION, { subproject: "delta" });
    expect(res).toMatchObject({
      ok: true,
      data: { effect: "open-surface", surfaceId: "surface:adme:adme" },
    });
    expect(recomposed).toEqual([[SEIS_SUBPROJECTS_KEY, SEIS_SELECTED_KEY, SEIS_CHANGE_KEY]]);
    const view = selected(rt);
    expect(view.header?.status?.label).toBe("1 admin · 3 viewers");
    expect(view.header?.chip).toBe("sd://opendes/delta");
    const rows = all(subprojects(rt), "rows")[0]?.items ?? [];
    expect(rows.filter((r) => r.selected).map((r) => r.text)).toEqual(["delta"]);
    expect(await act(rt, SEIS_SELECT_ACTION, { subproject: "nope" })).toMatchObject({ ok: false });
  });

  test("a default-ACL subproject explains its reach", () => {
    const rt = seededRuntime(SEED, { now: NOW });
    return act(rt, SEIS_SELECT_ACTION, { subproject: "volve" }).then(() => {
      const view = selected(rt);
      const [, viewers] = all(view, "rows");
      expect(viewers?.items[0]).toMatchObject({
        text: "all 32 people with a data role",
        trailing: "via data.default.viewers",
      });
    });
  });

  test("the first Seismic action reads the store when it was never measured", async () => {
    const { transport } = routeTransport(seismicRoutes());
    const rt = seededRuntime(
      { [ACCESS_AREA]: sampleAccess(), [HEALTH_AREA]: SAMPLE_HEALTH },
      { now: NOW, transport },
    );
    expect(await act(rt, SEIS_SELECT_ACTION, { subproject: "golf" })).toMatchObject({ ok: true });
    expect(selected(rt).header?.chip).toBe("sd://opendes/golf");
  });
});

describe("every frame passes its validator", () => {
  const states: [string, () => Runtime][] = [
    ["measured", () => seededRuntime(SEED, { now: NOW })],
    ["signin", () => seededRuntime(SEED, { now: NOW, phase: "signin" })],
    ["firstrun", () => seededRuntime(SEED, { now: NOW, phase: "firstrun" })],
    ["unmeasured", () => seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW })],
    ["no access read", () => seededRuntime({ [SEISMIC_AREA]: sampleSeismic() }, { now: NOW })],
  ];
  for (const [name, make] of states) {
    test(name, async () => {
      const rt = make();
      const subs = sampleSeismic().subprojects.map((s) => s.name);
      for (const sub of subs) {
        if (rt.status.phase === "connected" && rt.cache.get(SEISMIC_AREA).data) {
          await act(rt, SEIS_SELECT_ACTION, { subproject: sub });
        }
        for (const [key, compose] of Object.entries(seismicModule.composers ?? {})) {
          expect(() => expectView(key, "board")(compose(rt))).not.toThrow();
        }
      }
    });
  }
});

describe("members open the person inspector", () => {
  test("a person or application row in the selected subproject dispatches select-person", async () => {
    const text = JSON.stringify(selected(seededRuntime(SEED, { now: NOW })));
    expect(text).toContain('"type":"select-person"');
  });
});

describe("people's seismic grants", () => {
  const peopleBoard = expectView(PEOPLE_KEY, "board");

  async function grants(rt: Runtime) {
    const res = await accessModule.actions?.[PEOPLE_VIEW_ACTION]?.(rt, { view: "grants" });
    expect(res).toMatchObject({ ok: true });
    return peopleBoard(composePeople(rt)) as CanvasBoardView;
  }

  function badges(cell: unknown): string {
    if (cell === null || cell === undefined) return "";
    if (typeof cell !== "object") return String(cell);
    return ((cell as { badges?: { text: string }[] }).badges ?? []).map((b) => b.text).join("");
  }

  function byPerson(view: CanvasBoardView) {
    const table = section(view, "table");
    if (!table) throw new Error("no grants table");
    const name = (cell: unknown) =>
      typeof cell === "string" ? cell : String((cell as { value?: unknown }).value);
    return Object.fromEntries(
      table.rows.map((r) => {
        const cells = Object.entries(r)
          .filter(([k, v]) => k.startsWith("sp:") && badges(v))
          .map(([k, v]) => `${k.slice(3)} ${badges(v)}`);
        return [
          name(r.person),
          {
            cells,
            default: badges(r.default),
            admin: typeof r.person === "object" ? badges(r.person) : "",
          },
        ];
      }),
    );
  }

  test("reproduces the cast: who holds which subproject, A for admin and V for viewer", async () => {
    const view = await grants(seededRuntime(SEED, { now: NOW }));
    const table = section(view, "table");
    expect(table?.title).toBe("Subproject grants · 9 of 9 people");
    expect(table?.columns.map((c) => c.label)).toEqual([
      "Person",
      "default (volve, drogon)",
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "sleipner",
      "echo",
      "foxtrot",
      "golf",
      "golf2",
      "golf3",
    ]);
    expect(table?.caption).toBe(
      "9 of 32 people hold a subproject grant. Editors reach volve and drogon through data.default. A is admin, V is viewer.",
    );
    const rows = byPerson(view);
    expect(rows["Priya Nair"]).toEqual({
      cells: ["alpha A", "bravo A"],
      default: "V",
      admin: "tenant admin",
    });
    expect(rows["Marcus Oyelaran"]).toEqual({
      cells: ["alpha V", "delta V"],
      default: "V",
      admin: "",
    });
    expect(rows["Hiro Tanaka"]?.cells).toEqual(["sleipner V"]);
    expect(rows["Sofia Marchetti"]?.cells).toEqual(["echo A", "foxtrot V"]);
    expect(rows["Dmitri Volkov"]?.cells).toEqual(["golf V"]);
    expect(rows["Elena Petrova"]?.cells).toEqual(["charlie V"]);
    expect(rows["Ingrid Halvorsen (you)"]?.admin).toBe("tenant admin");
    expect(rows["Tomas Reyes"]).toMatchObject({
      cells: ["alpha A", "sleipner A", "foxtrot A"],
      admin: "tenant admin",
    });
    expect(rows["Lena Fischer"]).toBeUndefined();
    const names = Object.keys(rows);
    expect(names.slice(-3).sort()).toEqual(["Ingrid Halvorsen (you)", "Priya Nair", "Tomas Reyes"]);
    const table2 = table?.rows.find((r) => r.person === "Marcus Oyelaran");
    expect(table2?.["sp:alpha"]).toEqual({ badges: [{ text: "V", tone: "info" }] });
  });

  test("explains tenant admins and names what it leaves out, then offers Open person", async () => {
    const view = await grants(seededRuntime(SEED, { now: NOW }));
    const notes = all(view, "rows").flatMap((r) => r.items);
    expect(notes).toContainEqual({
      glyph: "info",
      text: "Tenant admins",
      trailing: "can list and manage every subproject; reading one still needs its ACL group",
    });
    expect(notes).toContainEqual({
      glyph: "neutral",
      text: "Not shown",
      trailing: "subproject-legacy (no members)",
    });
    const open = all(view, "actions").at(-1)?.items[0];
    expect(open).toMatchObject({ type: "select-person", label: "Open person" });
    expect(open?.fields?.[0]?.options).toHaveLength(9);
  });

  test("filters apply: Vendor shows only Elena Petrova", async () => {
    const rt = seededRuntime(SEED, { now: NOW });
    rt.tracker.importCsv(sampleCohortCsv(), NOW);
    await accessModule.actions?.[PEOPLE_FILTER_ACTION]?.(rt, { filter: "cohort:Vendor" });
    const view = await grants(rt);
    expect(section(view, "table")?.title).toBe("Subproject grants · 1 of 1 person");
    expect(section(view, "table")?.caption).toStartWith("1 of 1 person hold");
    expect(Object.keys(byPerson(view))).toEqual(["Elena Petrova"]);
  });

  test("many subprojects: columns are capped and the rest are named", async () => {
    const read = sampleSeismic();
    const lena = Object.entries(sampleAccess().directory).find(
      ([, e]) => e.name === "Lena Fischer",
    )?.[0] as string;
    for (let i = 1; i <= 15; i++) {
      const name = `extra${String(i).padStart(2, "0")}`;
      const admin = `data.sdms.opendes.${name}.admin@opendes.dataservices.energy`;
      const viewer = `data.sdms.opendes.${name}.viewer@opendes.dataservices.energy`;
      read.subprojects.push({ name, admins: [admin], viewers: [viewer] });
      read.groups[admin] = { members: [] };
      read.groups[viewer] = { members: [lena] };
    }
    const view = await grants(seededRuntime({ ...SEED, [SEISMIC_AREA]: read }, { now: NOW }));
    expect(section(view, "table")?.columns).toHaveLength(2 + 12);
    const notShown = all(view, "rows")
      .flatMap((r) => r.items)
      .find((r) => r.text === "Not shown");
    expect(notShown?.trailing).toBe(
      "13 more subprojects (extra03, extra04 and 11 more), and subproject-legacy (no members)",
    );
  });

  test("a store never read says so and offers the seismic read", async () => {
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW });
    const view = await grants(rt);
    expect(section(view, "table")).toBeUndefined();
    expect(JSON.stringify(view)).toContain("Seismic grants are not measured yet");
    const read = all(view, "actions").at(-1)?.items[0];
    expect(read).toMatchObject({ type: SEIS_READ_ACTION, label: "Read subprojects" });
    expect(read?.disabled).toBeUndefined();

    const signedOut = seededRuntime(
      { [ACCESS_AREA]: sampleAccess() },
      { now: NOW, phase: "signin" },
    );
    const gated = all(await grants(signedOut), "actions").at(-1)?.items[0];
    expect(gated).toMatchObject({ type: SEIS_READ_ACTION, disabled: true });
  });

  test("reading the store redraws the people region", async () => {
    const { transport } = routeTransport(seismicRoutes());
    const keys: string[] = [];
    const rt = seededRuntime(
      { [ACCESS_AREA]: sampleAccess() },
      { now: NOW, transport, recompose: (k) => keys.push(...k) },
    );
    expect(await act(rt, SEIS_READ_ACTION)).toEqual({ ok: true });
    expect(keys).toContain(PEOPLE_KEY);
    expect(section(await grants(rt), "table")?.title).toBe("Subproject grants · 9 of 9 people");
  });

  const states: [string, () => Runtime][] = [
    ["measured", () => seededRuntime(SEED, { now: NOW })],
    ["signin", () => seededRuntime(SEED, { now: NOW, phase: "signin" })],
    ["firstrun", () => seededRuntime(SEED, { now: NOW, phase: "firstrun" })],
    ["never read", () => seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW })],
  ];
  for (const [name, make] of states) {
    test(`every frame passes its validator: ${name}`, async () => {
      const rt = make();
      await accessModule.actions?.[PEOPLE_VIEW_ACTION]?.(rt, { view: "grants" });
      for (const filter of ["all", "apps", "pending", "gaps"]) {
        await accessModule.actions?.[PEOPLE_FILTER_ACTION]?.(rt, { filter });
        expect(() => peopleBoard(composePeople(rt))).not.toThrow();
      }
    });
  }
});
