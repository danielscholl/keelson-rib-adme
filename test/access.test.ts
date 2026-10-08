import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { z } from "zod";
import { buildAccess, countAccess } from "../src/access/model";
import { selectPerson } from "../src/access/person";
import { ACCESS_AREA, readAccess } from "../src/access/read";
import {
  composeAccessPulse,
  composeAttention,
  composeCohorts,
  composePrincipals,
  EXPORT_ROSTER_ACTION,
  exportRoster,
  IMPORT_COHORTS_ACTION,
} from "../src/boards/access";
import { composePeople, PEOPLE_FILTER_ACTION, PEOPLE_VIEW_ACTION } from "../src/boards/people";
import { composePerson } from "../src/boards/person";
import { Batch } from "../src/client";
import { ATTENTION_KEY, COHORTS_KEY, PEOPLE_KEY, PRINCIPALS_KEY, PULSE_KEY } from "../src/keys";
import { accessModule } from "../src/modules/access";
import { planModule } from "../src/modules/plan";
import { planState } from "../src/plan/state";
import { Store } from "../src/store";
import { csvCell, Tracker, trackerFile } from "../src/tracker";
import {
  SAMPLE_APPS,
  SAMPLE_CLOSURES,
  SIGNED_IN_AS,
  sampleAccess,
  sampleCohortCsv,
} from "./fixtures/access";
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
  test("the pulse says 5 to follow up and draws unmeasured use as unmeasured, not 0", () => {
    const view = expectView(PULSE_KEY, "board")(composeAccessPulse(rt()));
    const text = JSON.stringify(view);
    expect(text).toContain('"label":"5 to follow up"');
    expect(text).toContain("contoso-adme · opendes · measured 14:05Z");
    expect(text).toContain('{"label":"In use: not measured","n":null}');
    expect(text).toContain('{"label":"Active this week","value":null');
    expect(text).toContain('{"label":"Accepted, not used","value":null');
    expect(text).toContain("32 people from 12 organizations. 3 not accepted yet.");
    expect(text).toContain("1 missing users@ · 1 duplicate entry");
    expect(text).not.toContain("Next pass ends");
  });

  test("follow up lists who cannot use it, then invitations oldest first", () => {
    const view = expectView(ATTENTION_KEY, "board")(composeAttention(rt()));
    const titles = view.view === "board" ? view.sections.map((s) => s.title) : [];
    expect(titles).toEqual([
      "Cannot use it · 2",
      "Has not accepted the invitation · 3",
      undefined,
      "Checks that found nothing",
    ]);
    const text = JSON.stringify(view);
    expect(text).toContain("Pacrim Energy · not in users@, every call returns 401");
    expect(text).toContain("Northfield · invited 4 d ago");
    expect(text).toContain("Who accepted but has not used it is not measured");
    const invited = view.view === "board" ? view.sections[1] : undefined;
    const names = invited?.kind === "rows" ? invited.items.map((i) => i.text) : [];
    expect(names.at(-1)).toBe("Jonas Lindqvist");
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
    expect(accessModule.counts?.access?.(first)).toBe(0);
  });

  test("a lapsed sign-in keeps the last sweep and says cached", () => {
    const text = JSON.stringify(expectView(PULSE_KEY, "board")(composeAccessPulse(rt("signin"))));
    expect(text).toContain("sign-in needed");
    expect(text).toContain("cached from 14:05Z");
    expect(text).toContain('"label":"People","value":32');
  });

  test("the badge counts pending, broken and unknown principals", () => {
    expect(accessModule.counts?.access?.(rt())).toBe(5);
    const read = sampleAccess();
    read.groups.editors.push({ id: "ffffffff-0000-4000-8000-000000000000", owner: false });
    const withUnknown = seededRuntime({ [ACCESS_AREA]: read });
    expect(accessModule.counts?.access?.(withUnknown)).toBe(6);
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

describe("follow up actions", () => {
  const rows = (runtime: ReturnType<typeof rt>) => {
    const view = expectView(ATTENTION_KEY, "board")(composeAttention(runtime));
    if (view.view !== "board") return [];
    return view.sections.flatMap((s) => (s.kind === "rows" ? s.items : []));
  };

  test("rows change nothing: each one opens the person", () => {
    for (const row of rows(rt()).filter((r) => r.action)) {
      expect(row.action?.type).toBe("select-person");
    }
    const rachel = rows(rt()).find((r) => r.text === "Rachel Kim");
    expect(rachel?.action?.payload).toEqual({ id: "00000000-0000-4000-8000-000000000011" });
  });

  test("the inspector offers no resend; the plan module still dry-runs one", async () => {
    const runtime = rt();
    selectPerson(runtime, "00000000-0000-4000-8000-000000000008");
    const text = JSON.stringify(composePerson(runtime));
    expect(text).not.toContain('"type":"preview-resend-invite"');
    const binding = {
      host: SAMPLE_PROFILE.host,
      partition: SAMPLE_PROFILE.partition,
      tenantId: SAMPLE_PROFILE.tenantId,
    };
    const payload = { ...binding, id: "00000000-0000-4000-8000-000000000008" };
    const res = await planModule.actions?.["preview-resend-invite"]?.(runtime, payload);
    await planState(runtime).pending;
    expect(res).toMatchObject({ ok: true, data: { effect: "open-canvas" } });
    expect(planState(runtime).plan?.kind).toBe("resend-invite");
  });
});

describe("cohorts", () => {
  const NOW = new Date("2026-10-02T14:05:00Z");
  const tracked = () => {
    const runtime = rt();
    const res = runtime.tracker.importCsv(sampleCohortCsv(), NOW);
    expect(res).toMatchObject({ ok: true, cohorts: 3 });
    expect(res.ok && res.emails).toHaveLength(32);
    return runtime;
  };

  test("untracked people draw as one Untracked card and the pass stays unmeasured", () => {
    const view = expectView(COHORTS_KEY, "board")(composeCohorts(rt()));
    const text = JSON.stringify(view);
    expect(text).toContain("No cohort is tracked");
    expect(text).toContain('"title":"Untracked","pill":{"label":"32 people"}');
    expect(text).toContain("32 people · 0 cohorts · 32 untracked");
    expect(text).toContain('{"label":"Pass ends","value":"?"}');
  });

  test("an import reproduces the cast: Pilot 29, Vendor 1, Permanent 2", () => {
    const runtime = tracked();
    const text = JSON.stringify(expectView(COHORTS_KEY, "board")(composeCohorts(runtime)));
    expect(text).toContain('"title":"Pilot","pill":{"label":"29 people"}');
    expect(text).toContain(
      '"segments":[{"label":"broken","n":2,"tone":"error"},{"label":"pending","n":3,"tone":"warn"},{"label":"healthy","n":24,"tone":"ok"}]',
    );
    expect(text).toContain('"value":"26 d · 2026-10-28"');
    expect(text).toContain('"title":"Vendor","pill":{"label":"1 person"}');
    expect(text).toContain('"value":"27 d · 2026-10-29"');
    expect(text).toContain('"label":"Pass ends","value":"none"');
    expect(text).not.toContain("Untracked");
    const pulse = JSON.stringify(expectView(PULSE_KEY, "board")(composeAccessPulse(runtime)));
    expect(pulse).toContain('"label":"Next pass ends","value":"26 d","sub":"Pilot · 2026-10-28"');
    expect(pulse).toContain("2 Permanent · 29 Pilot · 1 Vendor");
    const roster = JSON.stringify(expectView(PEOPLE_KEY, "board")(composePeople(runtime)));
    expect(roster).toContain("Pilot · 24");
    expect(roster).toContain("Permanent · 2");
  });

  test("a bad line refuses the whole import and names the line", () => {
    const runtime = rt();
    const csv = "lena.fischer@rheinseis.example,Pilot,2026-10-28\nnot-an-email,Pilot";
    expect(runtime.tracker.importCsv(csv, NOW)).toEqual({
      ok: false,
      error: "line 2: not an email address",
    });
    expect(runtime.tracker.cohorts).toEqual([]);
    expect(
      runtime.tracker.importCsv("a@b.example,Pilot,2026-10-28\nc@d.example,pilot,2026-11-01", NOW),
    ).toMatchObject({ ok: false, error: "line 2: Pilot already has pass end 2026-10-28" });
    for (const bad of ["2026-13-45", "2026-02-30"]) {
      expect(runtime.tracker.importCsv(`a@b.example,Pilot,${bad}`, NOW)).toMatchObject({
        ok: false,
        error: "line 1: pass end is not YYYY-MM-DD",
      });
    }
    expect(runtime.tracker.importCsv("a@b.example,untracked", NOW)).toMatchObject({
      ok: false,
      error: "line 1: Untracked is not a cohort name",
    });
  });

  test("quoted cells, a trailing comma and a repeated address import cleanly", () => {
    const runtime = rt();
    const csv = [
      '"lena.fischer@rheinseis.example","Pilot","2026-10-28"',
      "h.tanaka@kaiyo-data.example,Vendor,",
      "h.tanaka@kaiyo-data.example,Pilot",
    ].join("\n");
    expect(runtime.tracker.importCsv(csv, NOW)).toMatchObject({ ok: true, cohorts: 1 });
    expect(runtime.tracker.cohorts).toEqual([
      { name: "Pilot", created: "2026-10-02", passEnds: "2026-10-28" },
    ]);
    expect(runtime.tracker.cohortOf("H.Tanaka@kaiyo-data.example")).toBe("Pilot");
  });

  test("a tracker file that does not parse is shown as unreadable and never overwritten", () => {
    const store = new Store(undefined);
    const name = trackerFile(SAMPLE_PROFILE);
    const broken = { cohorts: [{ name: "Pilot", created: "2026-09-28", passEnds: "" }] };
    store.write(name, broken);
    const tracker = new Tracker(store, name);
    expect(tracker.unreadable).toBe(true);
    expect(tracker.importCsv("a@b.example,Pilot", NOW)).toMatchObject({ ok: false });
    expect(store.read(name, z.unknown())).toEqual(broken);
    const runtime = rt();
    runtime.tracker = tracker;
    expect(JSON.stringify(composeCohorts(runtime))).toContain("could not be read");
    expect(JSON.stringify(composeAccessPulse(runtime))).toContain(
      '{"label":"Next pass ends","value":null,"sub":"the tracker could not be read"}',
    );
  });

  test("cohorts are kept per instance and survive a restart", () => {
    const store = new Store(undefined);
    const first = new Tracker(store, trackerFile(SAMPLE_PROFILE));
    first.importCsv("lena.fischer@rheinseis.example,Pilot,2026-10-28", NOW);
    expect(new Tracker(store, trackerFile(SAMPLE_PROFILE)).cohorts).toHaveLength(1);
    const other = new Tracker(store, trackerFile({ ...SAMPLE_PROFILE, partition: "pilot" }));
    expect(other.cohorts).toEqual([]);
    expect(other.unreadable).toBe(false);
  });

  test("import and export actions report what happened", async () => {
    const runtime = rt();
    const imported = await accessModule.actions?.[IMPORT_COHORTS_ACTION]?.(runtime, {
      csv: "lena.fischer@rheinseis.example,R&D\nnobody@nowhere.example,R/D",
    });
    expect(imported).toEqual({
      ok: true,
      data: { message: "Imported 2 into 2 cohort(s); 1 not in entitlements" },
    });
    const exported = await accessModule.actions?.[EXPORT_ROSTER_ACTION]?.(runtime, {
      cohort: "R&D",
    });
    expect(exported).toEqual({ ok: false, error: "The rib has no data directory to write to." });
    const missing = await accessModule.actions?.[EXPORT_ROSTER_ACTION]?.(runtime, {
      cohort: "R/D",
    });
    expect(missing).toEqual({ ok: false, error: "Nobody is in that cohort." });
  });

  test("a formula-looking cell is defused and a comma is quoted", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("Dutta, Sample")).toBe('"Dutta, Sample"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
  });

  test("a pass that has ended is an error, not a negative count", () => {
    const runtime = rt();
    runtime.tracker.importCsv("lena.fischer@rheinseis.example,Pilot,2026-09-30", NOW);
    const pulse = JSON.stringify(composeAccessPulse(runtime));
    expect(pulse).toContain('"label":"Next pass ends","value":"ended"');
    expect(JSON.stringify(composeCohorts(runtime))).toContain("ended 2 d ago · 2026-09-30");
  });

  test("the roster export quotes names and carries the pass end", () => {
    const runtime = tracked();
    const csv = exportRoster(runtime, "Vendor");
    expect(csv).toBe(
      "name,email,role,state,cohort,pass_end\nElena Petrova,elena.petrova@vendor-partners.example,Editor,healthy,Vendor,2026-10-29\n",
    );
    expect(exportRoster(runtime, "Nobody")).toBeUndefined();
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
      "GET /api/entitlements/v2/members/": (req) => {
        const group = decodeURIComponent(req.url.split("/members/")[1] ?? "").split("@")[0] ?? "";
        const key = group === "users" ? "users" : group.replace("users.datalake.", "");
        const closure = SAMPLE_CLOSURES[key as keyof typeof SAMPLE_CLOSURES];
        return { status: 200, body: { groups: closure.map((email) => ({ email })) } };
      },
      [`GET /v1.0/groups/${SAMPLE_PROFILE.rosterGroupId}/members`]: () => ({
        status: 200,
        body: {
          value: cast.roster?.map((m) => ({ id: m.id, displayName: m.name, mail: m.mail })),
        },
      }),
    });
    const batch = new Batch(azExec(), SAMPLE_PROFILE, transport, async () => undefined);
    const res = await readAccess(batch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const model = buildAccess(res.data);
    expect(countAccess(model)).toMatchObject({ people: 32, apps: 4, broken: 2, rosterDrift: 0 });
    expect(model.people.find((p) => p.name === "Rachel Kim")?.groups).toEqual({
      held: 32,
      expected: 33,
    });
    const memberLists = sent.filter(
      (r) => r.url.includes("/api/entitlements/v2/groups/") && r.url.endsWith("/members"),
    );
    expect(memberLists).toHaveLength(5);
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

describe("people views", () => {
  const people = expectView(PEOPLE_KEY, "board");
  const act = (runtime: ReturnType<typeof rt>, type: string, payload: unknown) =>
    accessModule.actions?.[type]?.(runtime, payload);

  test("the roster shows a group count only where it differs from the role", () => {
    const text = JSON.stringify(people(composePeople(rt())));
    expect(text).toContain("rachel.kim@pacrim-energy.example · 32 of 33");
    expect(text).toContain('"trailing":"ingrid.halvorsen@contoso.example · member"');
  });

  test("the roles matrix chunks rows, flags gaps and duplicates, and says what it shows", async () => {
    const runtime = rt();
    expect(await act(runtime, PEOPLE_VIEW_ACTION, { view: "matrix" })).toMatchObject({ ok: true });
    const view = people(composePeople(runtime));
    if (view.view !== "board") throw new Error("board expected");
    const tables = view.sections.filter((s) => s.kind === "table");
    expect(tables.map((t) => t.title)).toEqual(["Needs attention · 5", "Healthy · 1 to 15 of 27"]);
    const attention = tables[0]?.kind === "table" ? tables[0].rows : [];
    const rachel = attention.find((r) => r.person === "Rachel Kim");
    expect(rachel).toMatchObject({
      users: { value: "✕ missing", tone: "error" },
      groups: { value: "32/33", tone: "warn" },
      editors: { badges: [{ text: "M" }] },
    });
    const dmitri = attention.find((r) => r.person === "Dmitri Volkov");
    expect(JSON.stringify(dmitri?.editors)).toContain("duplicate");
    expect(tables.at(-1)?.caption).toBe(
      "Showing 20 of 32 · filter: all. M is member, O is owner. Filter by organization or cohort to list everyone.",
    );
    // Pass has no value until a cohort is tracked, so its column stays hidden.
    const keys = tables[0]?.kind === "table" ? tables[0].columns.map((c) => c.key) : [];
    expect(keys).toContain("roster");
    expect(keys).not.toContain("pass");
  });

  test("a cohort filter lists everyone in it, 15 rows per table", async () => {
    const runtime = rt();
    runtime.tracker.importCsv(sampleCohortCsv(), new Date("2026-10-02T14:05:00Z"));
    await act(runtime, PEOPLE_VIEW_ACTION, { view: "matrix" });
    expect(await act(runtime, PEOPLE_FILTER_ACTION, { filter: "cohort:Pilot" })).toMatchObject({
      ok: true,
    });
    const view = people(composePeople(runtime));
    const titles = view.view === "board" ? view.sections.map((s) => s.title).filter(Boolean) : [];
    expect(titles).toEqual([
      "Needs attention · 5",
      "Pilot · 1 to 15 of 24",
      "Pilot · 16 to 24 of 24",
    ]);
    expect(JSON.stringify(view)).toContain('"chip":"29 of 32 · Pilot"');
    const table = view.view === "board" ? view.sections.find((s) => s.kind === "table") : undefined;
    expect(table?.kind === "table" && table.columns.some((c) => c.key === "pass")).toBe(true);
  });

  test("gaps, pending and applications filter the roster", async () => {
    const runtime = rt();
    await act(runtime, PEOPLE_FILTER_ACTION, { filter: "gaps" });
    let text = JSON.stringify(people(composePeople(runtime)));
    expect(text).toContain("Needs attention · 2");
    await act(runtime, PEOPLE_FILTER_ACTION, { filter: "apps" });
    text = JSON.stringify(people(composePeople(runtime)));
    expect(text).toContain("Applications · 4");
    expect(text).toContain('"chip":"4 of 4 · applications"');
  });

  test("an unknown view or filter is refused", async () => {
    const runtime = rt();
    expect(await act(runtime, PEOPLE_VIEW_ACTION, { view: "bogus" })).toMatchObject({ ok: false });
    expect(await act(runtime, PEOPLE_FILTER_ACTION, { filter: "cohort:Nope" })).toMatchObject({
      ok: false,
    });
  });
});

describe("drift checks", () => {
  test("a clean sample reports roster drift and deleted users as checks that found nothing", () => {
    const text = JSON.stringify(composeAttention(rt()));
    expect(text).toContain("Roster drift (Entra roster vs entitlements)");
    expect(text).toContain("Deleted in Entra, still in entitlements");
  });

  test("roster drift names both sides", () => {
    const read = sampleAccess();
    const lena = Object.entries(read.directory).find(([, e]) => e.name === "Lena Fischer")?.[0];
    read.roster = [
      ...(read.roster ?? []).filter((m) => m.id !== lena),
      {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        name: "Former Pilot",
        mail: "former@x.example",
      },
    ];
    const runtime = seededRuntime({ [ACCESS_AREA]: read });
    const text = JSON.stringify(composeAttention(runtime));
    expect(text).toContain("Roster drift · 2");
    expect(text).toContain("has entitlements, not in the roster group");
    expect(text).toContain("former@x.example · in the roster group, no entitlements");
    expect(countAccess(buildAccess(read)).rosterDrift).toBe(2);
  });

  test("a listed id Entra holds as deleted is named as deleted, not unknown", () => {
    const read = sampleAccess();
    const gone = "dddddddd-0000-4000-8000-000000000001";
    read.groups.editors.push({ id: gone, owner: false });
    read.deleted = [gone];
    const text = JSON.stringify(composeAttention(seededRuntime({ [ACCESS_AREA]: read })));
    expect(text).toContain("Deleted in Entra, still in entitlements · 1");
    expect(text).not.toContain("Unknown principals ·");
  });

  test("without a roster read the drift check is not claimed", () => {
    const read = sampleAccess();
    delete read.roster;
    const text = JSON.stringify(composeAttention(seededRuntime({ [ACCESS_AREA]: read })));
    expect(text).not.toContain("Roster drift");
  });
});
