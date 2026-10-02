import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { buildAccess, countAccess } from "../src/access/model";
import { ACCESS_AREA, readAccess } from "../src/access/read";
import {
  composeAccessPulse,
  composeAttention,
  composePeople,
  composePrincipals,
} from "../src/boards/access";
import { Batch } from "../src/client";
import {
  ACCESS_BADGE_KEY,
  ATTENTION_KEY,
  PEOPLE_KEY,
  PRINCIPALS_KEY,
  PULSE_KEY,
} from "../src/keys";
import { accessModule } from "../src/modules/access";
import { SAMPLE_APPS, SIGNED_IN_AS, sampleAccess } from "./fixtures/access";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport, seededRuntime } from "./harness";

const model = () =>
  buildAccess(sampleAccess(), { signedInAs: SIGNED_IN_AS, admeAppId: SAMPLE_PROFILE.admeAppId });

describe("identity model", () => {
  test("reproduces the cast: 32 people, 4 applications, 27 healthy, 3 pending, 2 broken", () => {
    const counts = countAccess(model());
    expect(counts).toMatchObject({
      people: 32,
      apps: 4,
      healthy: 27,
      pending: 3,
      broken: 2,
      missingUsers: 1,
      duplicates: 1,
      needsYou: 5,
      roles: { Ops: 2, Admin: 1, Editor: 29, Viewer: 0 },
      rootApps: 1,
      unknown: 0,
      oldestInvite: "2026-09-28T09:00:00Z",
    });
  });

  test("a role without users@ is broken, and so is a second entry by email", () => {
    const people = model().people;
    expect(people.find((p) => p.name === "Rachel Kim")).toMatchObject({
      state: "broken",
      cause: "missing-users",
      role: "Editor",
    });
    expect(people.find((p) => p.name === "Dmitri Volkov")).toMatchObject({
      state: "broken",
      cause: "duplicate",
      duplicateIn: "editors",
    });
    expect(people.filter((p) => p.you).map((p) => p.name)).toEqual(["Ingrid Halvorsen"]);
  });

  test("missing users@ does not hide a duplicate entry", () => {
    const read = sampleAccess();
    const dmitri = Object.entries(read.directory).find(([, e]) => e.name === "Dmitri Volkov")?.[0];
    read.groups.users = read.groups.users.filter((m) => m.id !== dmitri);
    expect(countAccess(buildAccess(read))).toMatchObject({
      missingUsers: 2,
      duplicates: 1,
      broken: 2,
    });
  });

  test("an id Entra does not know is an unknown principal, not a person", () => {
    const read = sampleAccess();
    read.groups.editors.push({ id: "ffffffff-0000-4000-8000-000000000000", owner: false });
    read.groups.viewers.push({ id: "stranger@nowhere.example", owner: false });
    const m = buildAccess(read);
    expect(m.people).toHaveLength(32);
    expect(m.unknown.map((u) => u.name).sort()).toEqual([
      "ffffffff-0000-4000-8000-000000000000",
      "stranger@nowhere.example",
    ]);
  });
});

function rt(phase?: "connected" | "signin" | "firstrun") {
  return seededRuntime({ [ACCESS_AREA]: sampleAccess() }, phase ? { phase } : {});
}

describe("access boards", () => {
  test("the pulse says 5 need you and never draws an untracked pass as a number", () => {
    const view = expectView(PULSE_KEY, "board")(composeAccessPulse(rt()));
    const text = JSON.stringify(view);
    expect(text).toContain('"label":"5 need you"');
    expect(text).toContain("contoso-adme · opendes · measured 14:05Z");
    expect(text).toContain('{"label":"Next pass ends","value":null');
    expect(text).toContain("1 missing users@ · 1 duplicate entry");
  });

  test("needs you groups cards by cause, worst first", () => {
    const view = expectView(ATTENTION_KEY, "board")(composeAttention(rt()));
    const titles = view.view === "board" ? view.sections.map((s) => s.title) : [];
    expect(titles).toEqual([
      "Not in users@, every call returns 401 · 1",
      "Invited, not accepted · 3",
      "Duplicate member entry · 1",
      "Checks that found nothing",
    ]);
    const text = JSON.stringify(view);
    expect(text).toContain("member of users.datalake.editors but not users@");
    expect(text).toContain('"value":"4 d ago"');
  });

  test("the roster lists attention first and caps the healthy rows", () => {
    const view = expectView(PEOPLE_KEY, "board")(composePeople(rt()));
    const text = JSON.stringify(view);
    expect(text).toContain("Needs attention · 5");
    expect(text).toContain("Healthy · 27");
    expect(text).toContain("… 2 more · all healthy");
    expect(text).toContain("Ingrid Halvorsen (you)");
  });

  test("applications flag the root app as legacy", () => {
    const view = expectView(PRINCIPALS_KEY, "board")(composePrincipals(rt()));
    const text = JSON.stringify(view);
    expect(text).toContain('"label":"1 legacy"');
    for (const app of SAMPLE_APPS) expect(text).toContain(app.name);
  });

  test("before connecting the regions are hidden and the pulse is the connect journey", () => {
    const first = seededRuntime({}, { phase: "firstrun" });
    expect(composeAttention(first).sections).toEqual([]);
    expect(composePeople(first).sections).toEqual([]);
    expect(JSON.stringify(composeAccessPulse(first))).toContain("Step 2: pick the instance");
    expect(accessModule.badges?.[ACCESS_BADGE_KEY]?.(first)).toBe(0);
  });

  test("a lapsed sign-in keeps the last sweep and says cached", () => {
    const text = JSON.stringify(expectView(PULSE_KEY, "board")(composeAccessPulse(rt("signin"))));
    expect(text).toContain("sign-in needed");
    expect(text).toContain("cached from 14:05Z");
    expect(text).toContain('"label":"People","value":32');
  });

  test("the badge counts pending, broken and unknown principals", () => {
    expect(accessModule.badges?.[ACCESS_BADGE_KEY]?.(rt())).toBe(5);
    const read = sampleAccess();
    read.groups.editors.push({ id: "ffffffff-0000-4000-8000-000000000000", owner: false });
    const withUnknown = seededRuntime({ [ACCESS_AREA]: read });
    expect(accessModule.badges?.[ACCESS_BADGE_KEY]?.(withUnknown)).toBe(6);
    expect(JSON.stringify(composeAttention(withUnknown))).toContain("not found in Entra");
  });

  test("a failed re-read keeps the last people and says the read failed", () => {
    const runtime = rt();
    runtime.cache.fail(ACCESS_AREA, "Graph names: Forbidden", new Date("2026-10-02T14:20:00Z"));
    const text = JSON.stringify(expectView(PULSE_KEY, "board")(composeAccessPulse(runtime)));
    expect(text).toContain("Last read failed at 14:20Z: Graph names: Forbidden");
    expect(text).toContain('"label":"People","value":32');
  });
});

describe("access read", () => {
  test("reads five member lists, then names, then looks unresolved ids up as app ids", async () => {
    const cast = sampleAccess();
    const { transport, sent } = routeTransport({
      "GET /api/entitlements/v2/groups/": (req) => {
        const group = decodeURIComponent(req.url.split("/groups/")[1] ?? "").split("@")[0] ?? "";
        const key = group === "users" ? "users" : group.replace("users.datalake.", "");
        return {
          status: 200,
          body: {
            members: cast.groups[key as keyof typeof cast.groups].map((m) => ({
              email: m.id.toUpperCase(),
              role: m.owner ? "OWNER" : "MEMBER",
            })),
          },
        };
      },
      "POST /v1.0/directoryObjects/getByIds": (req) => {
        const ids = (req.body as { ids: string[] }).ids;
        return {
          status: 200,
          body: {
            value: ids
              .filter((id) => cast.directory[id]?.kind === "user")
              .map((id) => ({
                "@odata.type": "#microsoft.graph.user",
                id,
                displayName: cast.directory[id]?.name,
                mail: cast.directory[id]?.mail,
                userType: cast.directory[id]?.guest ? "Guest" : "Member",
                externalUserState: cast.directory[id]?.inviteState,
                externalUserStateChangeDateTime: cast.directory[id]?.inviteChangedAt,
              })),
          },
        };
      },
      "GET /v1.0/servicePrincipals": (req) => ({
        status: 200,
        body: {
          value: SAMPLE_APPS.filter((a) => decodeURIComponent(req.url).includes(`'${a.id}'`)).map(
            (a) => ({ id: "sp", appId: a.id, displayName: a.name }),
          ),
        },
      }),
    });
    const batch = new Batch(azExec(), SAMPLE_PROFILE, transport, async () => undefined);
    const res = await readAccess(batch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(countAccess(buildAccess(res.data))).toMatchObject({ people: 32, apps: 4, broken: 2 });
    expect(sent.filter((r) => r.method === "GET" && r.url.includes("/members"))).toHaveLength(5);
    const lookup = sent.find((r) => r.url.includes("/servicePrincipals"));
    expect(decodeURIComponent(lookup?.url ?? "")).toContain(`'${SAMPLE_APPS[1]?.id}'`);
    expect(sent.every((r) => r.method === "GET" || r.url.includes("getByIds"))).toBe(true);
  });

  test("a Graph refusal fails the area with a reason; a lapsed sign-in passes through", async () => {
    const { transport } = routeTransport({
      "GET /api/entitlements/v2/groups/": () => ({
        status: 200,
        body: { members: [{ email: SAMPLE_APPS[1]?.id, role: "MEMBER" }] },
      }),
      "POST /v1.0/directoryObjects/getByIds": () => ({
        status: 403,
        body: { message: "Forbidden" },
      }),
    });
    const refused = await readAccess(
      new Batch(azExec(), SAMPLE_PROFILE, transport, async () => undefined),
    );
    expect(refused).toMatchObject({
      ok: false,
      failure: { kind: "forbidden", message: "Graph names: Forbidden" },
    });
    const lapsed = await readAccess(
      new Batch(
        azExec(() => ({ error: "ERROR: AADSTS50173: expired" })),
        SAMPLE_PROFILE,
        transport,
        async () => undefined,
      ),
    );
    expect(lapsed).toMatchObject({ ok: false, failure: { kind: "signin", status: null } });
  });

  test("an application listed by object id is keyed by its app id", async () => {
    const objectId = "eeeeeeee-0000-4000-8000-000000000001";
    const { transport } = routeTransport({
      "GET /api/entitlements/v2/groups/": () => ({
        status: 200,
        body: { members: [{ email: objectId, role: "MEMBER" }] },
      }),
      "POST /v1.0/directoryObjects/getByIds": () => ({
        status: 200,
        body: {
          value: [
            {
              "@odata.type": "#microsoft.graph.servicePrincipal",
              id: objectId,
              appId: SAMPLE_PROFILE.admeAppId,
              displayName: "",
            },
          ],
        },
      }),
    });
    const res = await readAccess(
      new Batch(azExec(), SAMPLE_PROFILE, transport, async () => undefined),
    );
    if (!res.ok) throw new Error(res.failure.message);
    const apps = buildAccess(res.data, { admeAppId: SAMPLE_PROFILE.admeAppId }).apps;
    expect(apps).toMatchObject([{ name: objectId, appId: SAMPLE_PROFILE.admeAppId, root: true }]);
  });

  test("without an entitlements domain the read fails with a reason and calls nothing", async () => {
    const { transport, sent } = routeTransport({});
    const { entitlementsDomain, ...profile } = SAMPLE_PROFILE;
    const batch = new Batch(azExec(), profile, transport, async () => undefined);
    const res = await readAccess(batch);
    expect(res).toMatchObject({
      ok: false,
      failure: { message: expect.stringContaining("Re-test") },
    });
    expect(sent).toEqual([]);
  });
});
