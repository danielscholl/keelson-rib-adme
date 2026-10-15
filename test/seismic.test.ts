import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import {
  composeSeismicSelected,
  SEIS_READ_ACTION,
  SEIS_SELECT_ACTION,
} from "../src/boards/seismic";
import { briefInputs, briefOf } from "../src/brief/inputs";
import { seismicMatrix } from "../src/brief/seismic";
import { HEALTH_AREA } from "../src/data/health";
import { INSPECT_KEY } from "../src/keys";
import { connectionModule } from "../src/modules/connection";
import { composeInspect } from "../src/modules/console";
import { seismicModule } from "../src/modules/seismic";
import type { Runtime } from "../src/runtime";
import { buildSeismic, countSeismic } from "../src/seismic/model";
import { fromOwnGroups, SEISMIC_AREA, type SeismicRead } from "../src/seismic/read";
import { REFRESH_ACTION } from "../src/surfaces";
import { SIGNED_IN_AS, sampleAccess } from "./fixtures/access";
import { NOW, SAMPLE_HEALTH } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import {
  groupEmail,
  sampleGroupMembers,
  sampleSeismic,
  sampleSubprojectList,
} from "./fixtures/seismic";
import { routeTransport, type SentRequest, seededRuntime } from "./harness";

const selectedBoard = expectView(INSPECT_KEY, "board");

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

function _tiles(view: CanvasBoardView) {
  return Object.fromEntries(
    (section(view, "stats")?.items ?? []).map((t) => [t.label, { value: t.value, sub: t.sub }]),
  );
}

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
    const m = seismicMatrix(
      briefInputs(seededRuntime({ ...SEED, [SEISMIC_AREA]: read }, { now: NOW })),
    );
    expect(m?.headline).toStartWith("At least ");
    expect(m?.columns.find((c) => c.name === "bravo")?.unread).toBe(true);
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
    const brief = briefOf(seededRuntime({ ...SEED, [SEISMIC_AREA]: read }, { now: NOW }));
    expect(brief.items.find((i) => i.cls === "READ")).toMatchObject({
      title: "Seismic members were not all read",
      sub: "subprojects listed from your own groups; listing was refused",
    });
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

  test("the sweep reads membership, then not again for 30 minutes unless forced", async () => {
    const { transport, sent } = routeTransport(seismicRoutes());
    let now = NOW;
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: () => now, transport });
    for (const area of seismicModule.areas ?? []) rt.addArea(area);
    await rt.sweep();
    const lists = () => sent.filter((r) => r.url.includes("/subproject/tenant/opendes")).length;
    expect(lists()).toBe(1);
    expect(rt.cache.get(SEISMIC_AREA).at).toBe(NOW.toISOString());
    now = new Date(NOW.getTime() + 10 * 60_000);
    await rt.sweep();
    expect(lists()).toBe(1);
    await rt.sweep({ force: true });
    expect(lists()).toBe(2);
    now = new Date(NOW.getTime() + 41 * 60_000);
    await rt.sweep();
    expect(lists()).toBe(3);
  });

  test("Refresh now reads membership with the other areas", async () => {
    const { transport, sent } = routeTransport(seismicRoutes());
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    for (const area of seismicModule.areas ?? []) rt.addArea(area);
    await connectionModule.actions?.[REFRESH_ACTION]?.(rt, undefined);
    expect(sent.some((r) => r.url.includes("/subproject/tenant/opendes"))).toBe(true);
    expect(rt.cache.get(SEISMIC_AREA).at).toBeDefined();
  });

  test("a failed read is recorded and becomes a READ item", async () => {
    const { transport } = routeTransport({
      "GET /seistore-svc/api/v3/subproject/tenant/opendes": () => ({
        status: 400,
        body: { message: "bad tenant" },
      }),
    });
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    expect(await act(rt, SEIS_READ_ACTION)).toMatchObject({ ok: false });
    expect(briefOf(rt).items.find((i) => i.cls === "READ")).toMatchObject({
      title: "Seismic members could not be read",
      sub: "subprojects: bad tenant",
    });
  });
});

describe("subprojects and the selected subproject", () => {
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
        expect(() => expectView(INSPECT_KEY, "board")(composeInspect(rt))).not.toThrow();
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
