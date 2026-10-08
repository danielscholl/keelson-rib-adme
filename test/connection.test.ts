import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectView } from "@keelson/shared";
import {
  CONNECTION_DETAILS_ACTION,
  composeConnection,
  composeFirstRun,
  connectionLine,
} from "../src/boards/connection";
import { parseInstances } from "../src/discover";
import { CONNECTION_KEY } from "../src/keys";
import { composeRestingHeader } from "../src/resting";
import { IDLE_WINDOW_MS, Runtime } from "../src/runtime";
import { Store } from "../src/store";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport } from "./harness";

const board = expectView(CONNECTION_KEY, "board");

// Every probe answers the way the sample instance does.
function sampleRoutes(overrides: Record<string, () => { status: number; body?: unknown }> = {}) {
  return {
    "GET /v1.0/me": () => ({
      status: 200,
      body: { userPrincipalName: "ingrid.halvorsen@contoso.example", userType: "Member" },
    }),
    "GET /api/entitlements/v2/groups": () => ({ status: 200, body: { groups: [] } }),
    "GET /api/entitlements/v2/groups/all": () => ({ status: 400, body: { message: "bad" } }),
    "GET /v1.0/policies/authorizationPolicy": () => ({
      status: 200,
      body: { allowInvitesFrom: "everyone" },
    }),
    "GET /v1.0/directory/deletedItems": () => ({ status: 200, body: { value: [] } }),
    "GET /seistore-svc/api/v3/subproject/tenant/opendes": () => ({ status: 200, body: [] }),
    "GET /api/partition/v1/partitions": () => ({ status: 403, body: { message: "Forbidden" } }),
    "POST /api/search/v2/query": () => ({ status: 200, body: { totalCount: 1 } }),
    "GET /api/legal/v1/legaltags": () => ({ status: 200, body: { legalTags: [] } }),
    "GET /api/legal/v1/info": () => ({ status: 200, body: { version: "0.28.0" } }),
    ...overrides,
  };
}

function runtime(
  opts: {
    dir?: string;
    exec?: ReturnType<typeof azExec>;
    routes?: ReturnType<typeof sampleRoutes>;
    now?: () => Date;
  } = {},
) {
  const recomposed: string[][] = [];
  const { transport, sent } = routeTransport(opts.routes ?? sampleRoutes());
  const rt = new Runtime({
    exec: opts.exec ?? azExec(),
    store: new Store(opts.dir),
    recompose: (keys) => recomposed.push([...keys]),
    allKeys: ["k"],
    transport,
    sleep: async () => undefined,
    now: opts.now ?? (() => new Date("2026-10-02T14:05:00Z")),
  });
  return { rt, recomposed, sent };
}

describe("first run", () => {
  test("starts with the connect journey and an empty profile form", () => {
    const { rt } = runtime();
    expect(rt.status.phase).toBe("firstrun");
    const view = board(composeFirstRun(rt.status, rt.discovery));
    expect(JSON.stringify(view)).toContain("Step 2: pick the instance");
    board(composeConnection(rt.status));
  });

  test("an invalid profile is refused with a reason and nothing is saved", async () => {
    const { rt } = runtime();
    const res = await rt.saveProfile({ ...SAMPLE_PROFILE, tenantId: "contoso" });
    expect(res).toMatchObject({ ok: false });
    expect(rt.status.phase).toBe("firstrun");
  });
});

const SAMPLE_ID =
  "/subscriptions/7a100000-0000-4000-8000-00000000c0de/resourceGroups/contoso-rg/providers/Microsoft.OpenEnergyPlatform/energyServices/contoso-adme";

// What Resource Graph answers for the sample instance.
function graphRows(partitions = ["opendes"]) {
  return {
    data: {
      data: [
        {
          id: SAMPLE_ID,
          name: "contoso-adme",
          location: "eastus",
          tenantId: SAMPLE_PROFILE.tenantId,
          properties: {
            dnsName: SAMPLE_PROFILE.host,
            authAppId: SAMPLE_PROFILE.admeAppId,
            provisioningState: "Succeeded",
            dataPartitionNames: partitions.map((name) => ({ name })),
          },
        },
        { id: "x", name: "half-made", tenantId: SAMPLE_PROFILE.tenantId, properties: {} },
      ],
    },
  };
}

const withGroups = () =>
  sampleRoutes({
    "GET /api/entitlements/v2/groups": () => ({
      status: 200,
      body: { groups: [{ email: "users@opendes.dataservices.energy" }] },
    }),
    "GET /v1.0/groups": () => ({
      status: 200,
      body: { value: [{ id: SAMPLE_PROFILE.rosterGroupId, displayName: "contoso-adme" }] },
    }),
  });

describe("discovery", () => {
  test("lists the instances the sign-in can see, one Connect per partition", async () => {
    const exec = azExec(undefined, () => graphRows(["opendes", "pilot"]));
    const { rt } = runtime({ exec });
    await rt.discover();
    expect(rt.discovery).toMatchObject({ state: "found", instances: [{ name: "contoso-adme" }] });
    const text = JSON.stringify(board(composeFirstRun(rt.status, rt.discovery)));
    expect(text).toContain("Connect to opendes");
    expect(text).toContain("Connect to pilot");
    expect(exec.calls[0]?.args.slice(0, 3)).toEqual(["rest", "--method", "post"]);
  });

  test("a row without a host or app id is left out", () => {
    expect(parseInstances(graphRows().data).map((i) => i.name)).toEqual(["contoso-adme"]);
  });

  test("a failed lookup says why and opens the manual form", async () => {
    const exec = azExec(undefined, () => ({ error: "ERROR: Please run 'az login'" }));
    const { rt } = runtime({ exec });
    await rt.discover();
    const view = board(composeFirstRun(rt.status, rt.discovery));
    const text = JSON.stringify(view);
    expect(text).toContain("Could not list ADME instances: Please run 'az login'");
    expect(text).toContain('"expanded":true');
  });

  test("an empty list points at the manual form", async () => {
    const { rt } = runtime();
    await rt.discover();
    const text = JSON.stringify(composeFirstRun(rt.status, rt.discovery));
    expect(text).toContain("can see no ADME instance");
    expect(text).toContain('"expanded":true');
  });

  test("connecting from the list reads the domain and suggests the roster group", async () => {
    const exec = azExec(undefined, () => graphRows());
    const { rt, sent } = runtime({ exec, routes: withGroups() });
    await rt.discover();
    expect(await rt.connectInstance(SAMPLE_ID, "opendes")).toEqual({ ok: true });
    const lookup = sent.find((r) => r.url.includes("/v1.0/groups?"));
    expect(decodeURIComponent(lookup?.url ?? "")).toContain(
      "$filter=displayName eq 'contoso-adme'",
    );
    expect(rt.status.phase).toBe("connected");
    const { rosterGroupId, ...withoutRoster } = SAMPLE_PROFILE;
    expect(rt.profile).toEqual(withoutRoster);
    const details = JSON.stringify(board(composeConnection(rt.status)));
    expect(details).toContain("Use this group");
    expect(rt.useSuggestedRosterGroup("stale")).toMatchObject({ ok: false });
    expect(rt.useSuggestedRosterGroup(SAMPLE_PROFILE.rosterGroupId)).toEqual({ ok: true });
    expect(rt.profile).toEqual(SAMPLE_PROFILE);
    expect(JSON.stringify(composeConnection(rt.status))).not.toContain("Use this group");
    expect(await rt.connectInstance(SAMPLE_ID, "opendes")).toEqual({ ok: true });
    expect(rt.profile?.rosterGroupId).toBe(SAMPLE_PROFILE.rosterGroupId);
  });

  test("a lookup that throws reads as failed and can be retried", async () => {
    let broken = true;
    const exec = azExec(undefined, () => {
      if (broken) throw new Error("spawn failed");
      return graphRows();
    });
    const { rt } = runtime({ exec });
    await rt.discover();
    expect(rt.discovery).toEqual({ state: "failed", error: "spawn failed" });
    broken = false;
    await rt.discover();
    expect(rt.discovery.state).toBe("found");
  });

  test("a changed partition re-reads the entitlements domain", async () => {
    let domain = "opendes.dataservices.energy";
    const routes = sampleRoutes({
      "GET /api/entitlements/v2/groups": () => ({
        status: 200,
        body: { groups: [{ email: `users@${domain}` }] },
      }),
    });
    const { rt } = runtime({ routes });
    await rt.saveProfile(SAMPLE_PROFILE);
    domain = "pilot.dataservices.energy";
    await rt.saveProfile({ ...rt.profile, partition: "pilot" });
    expect(rt.profile?.entitlementsDomain).toBe("pilot.dataservices.energy");
  });

  test("a suggested id that is not a GUID is never saved", async () => {
    const routes = sampleRoutes({
      "GET /v1.0/groups": () => ({
        status: 200,
        body: { value: [{ id: "not-a-guid", displayName: "contoso-adme" }] },
      }),
    });
    const { rt } = runtime({ routes });
    const { rosterGroupId, ...withoutRoster } = SAMPLE_PROFILE;
    await rt.saveProfile(withoutRoster);
    expect(rt.useSuggestedRosterGroup("not-a-guid")).toMatchObject({ ok: false });
    expect(rt.profile?.rosterGroupId).toBeUndefined();
  });

  test("an instance that is not in the list is refused", async () => {
    const exec = azExec(undefined, () => graphRows());
    const { rt } = runtime({ exec });
    await rt.discover();
    expect(await rt.connectInstance(SAMPLE_ID, "other")).toMatchObject({ ok: false });
    expect(await rt.connectInstance("nope", "opendes")).toMatchObject({ ok: false });
    expect(rt.status.phase).toBe("firstrun");
  });

  test("two groups with the instance's name suggest nothing", async () => {
    const routes = sampleRoutes({
      "GET /v1.0/groups": () => ({
        status: 200,
        body: { value: [{ id: "a", displayName: "contoso-adme" }, { id: "b" }] },
      }),
    });
    const { rt } = runtime({ routes });
    const { rosterGroupId, ...withoutRoster } = SAMPLE_PROFILE;
    await rt.saveProfile(withoutRoster);
    expect(rt.status.phase).toBe("connected");
    expect(rt.status.test?.rosterSuggestion).toBeUndefined();
  });
});

describe("test connection", () => {
  test("a working sign-in connects and records the capability matrix", async () => {
    const { rt } = runtime();
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.status.phase).toBe("connected");
    const caps = Object.fromEntries(rt.status.test!.capabilities.map((c) => [c.id, c.result]));
    expect(caps).toEqual({
      "own-groups": "yes",
      "all-groups": "?",
      invite: "yes",
      "deleted-users": "yes",
      "seismic-list": "yes",
      partition: "403",
      "kind-counts": "yes",
    });
    expect(rt.status.test?.signedInAs).toBe("ingrid.halvorsen@contoso.example");
    expect(connectionLine(rt.status)).toMatchObject({
      kind: "rows",
      items: [
        {
          glyph: "ok",
          text: "Connected to contoso-adme · opendes as ingrid.halvorsen@contoso.example · no role group",
          action: { type: CONNECTION_DETAILS_ACTION },
        },
      ],
    });
  });

  test("a lapsed az sign-in reads as sign-in needed, never as a token problem", async () => {
    const exec = azExec(() => ({ error: "ERROR: AADSTS700082: The refresh token has expired" }));
    const { rt } = runtime({ exec });
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.status.phase).toBe("signin");
    const text = JSON.stringify(board(composeConnection(rt.status)));
    expect(text).toContain(`az login --tenant ${SAMPLE_PROFILE.tenantId}`);
    expect(text).not.toMatch(/token/i);
    expect(connectionLine(rt.status)).toMatchObject({
      items: [{ glyph: "error", text: "Sign-in needed for contoso-adme · opendes" }],
    });
  });

  test("a wrong ADME app id is a profile problem, not a sign-in problem", async () => {
    const exec = azExec((r) =>
      r === SAMPLE_PROFILE.admeAppId
        ? { error: "ERROR: AADSTS500011: The resource principal named x was not found" }
        : { token: "t" },
    );
    const { rt } = runtime({ exec });
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.status.phase).toBe("profile-error");
    expect(rt.status.error).toContain("AADSTS500011");
  });

  test("ADME refusing the sign-in explains where to look", async () => {
    const { rt } = runtime({
      routes: sampleRoutes({
        "GET /api/entitlements/v2/groups": () => ({
          status: 401,
          body: { message: "Unauthorized" },
        }),
      }),
    });
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.status.phase).toBe("profile-error");
    expect(rt.status.error).toContain("users@");
  });

  test("the probes are read-only", async () => {
    const { rt, sent } = runtime();
    await rt.saveProfile(SAMPLE_PROFILE);
    const writes = sent.filter(
      (r) => r.method !== "GET" && !r.url.endsWith("/api/search/v2/query"),
    );
    expect(writes).toEqual([]);
  });

  test("the operator's own groups give their role and seismic tenant admin", async () => {
    const domain = "opendes.dataservices.energy";
    const { rt } = runtime({
      routes: sampleRoutes({
        "GET /api/entitlements/v2/groups": () => ({
          status: 200,
          body: {
            groups: [
              "users",
              "users.datalake.editors",
              "users.datalake.admins",
              "data.default.viewers",
            ].map((n) => ({ email: `${n}@${domain}` })),
          },
        }),
      }),
    });
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.status.test?.roleGroups).toEqual([
      "users",
      "users.datalake.admins",
      "users.datalake.editors",
    ]);
    expect(connectionLine(rt.status)).toMatchObject({
      items: [
        { text: "Connected to contoso-adme · opendes as ingrid.halvorsen@contoso.example · Admin" },
      ],
    });
    const access = composeConnection(rt.status).sections.find((s) => s.title === "Your access");
    expect(access).toMatchObject({
      items: [
        { text: "Role", trailing: "Admin" },
        { text: "Seismic tenant admin", trailing: "yes" },
        { text: "From groups", trailing: "users, users.datalake.admins, users.datalake.editors" },
      ],
    });
  });

  test("a test recorded before roles were read shows the role as unknown", () => {
    const line = connectionLine({
      phase: "connected",
      profile: SAMPLE_PROFILE,
      test: {
        testedAt: "2026-10-02T14:05:00Z",
        signedInAs: "ingrid.halvorsen@contoso.example",
        capabilities: [],
      },
    });
    expect(line).toMatchObject({ items: [{ text: expect.stringContaining("· role ?") }] });
  });
});

describe("sweep", () => {
  test("areas land in the cache and recompose their keys", async () => {
    const { rt, recomposed } = runtime({
      routes: sampleRoutes({
        "GET /api/legal/v1/legaltags": () => ({
          status: 200,
          body: { legalTags: [{ name: "a" }] },
        }),
      }),
    });
    rt.addArea({
      name: "legal",
      keys: ["rib:adme:legal"],
      read: (b) => b.adme("legal", "/legaltags?valid=true"),
    });
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.cache.get("legal").data).toEqual({ legalTags: [{ name: "a" }] });
    expect(rt.freshness("legal")).toBe("measured 14:05Z");
    expect(recomposed.at(-1)).toEqual(["rib:adme:legal"]);
  });

  test("a sign-in lapse mid-sweep keeps the last sweep and says cached", async () => {
    let expired = false;
    const exec = azExec(() =>
      expired ? { error: "ERROR: AADSTS50173: grant expired" } : { token: "t" },
    );
    const { rt } = runtime({ exec });
    rt.addArea({ name: "legal", keys: [], read: (b) => b.adme("legal", "/legaltags") });
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.cache.get("legal").at).toBeDefined();
    expired = true;
    await rt.sweep();
    expect(rt.status.phase).toBe("signin");
    expect(rt.freshness("legal")).toBe("cached from 14:05Z");
  });

  test("a failed area keeps its last good data", async () => {
    let fail = false;
    const { rt } = runtime({
      routes: sampleRoutes({
        "GET /api/legal/v1/legaltags": () =>
          fail ? { status: 403, body: { message: "Forbidden" } } : { status: 200, body: { n: 1 } },
      }),
    });
    rt.addArea({ name: "legal", keys: [], read: (b) => b.adme("legal", "/legaltags") });
    await rt.saveProfile(SAMPLE_PROFILE);
    fail = true;
    await rt.sweep();
    expect(rt.cache.get("legal")).toMatchObject({ data: { n: 1 }, error: "Forbidden" });
    expect(rt.status.phase).toBe("connected");
  });
});

describe("timers", () => {
  test("tick only within the idle window after an action, and never while signed out", async () => {
    let now = new Date("2026-10-02T14:05:00Z").getTime();
    const { rt } = runtime({ now: () => new Date(now) });
    await rt.saveProfile(SAMPLE_PROFILE);
    expect(rt.shouldTick()).toBe(false);
    rt.touch();
    expect(rt.shouldTick()).toBe(true);
    now += IDLE_WINDOW_MS + 1;
    expect(rt.shouldTick()).toBe(false);
    rt.touch();
    rt.status = { ...rt.status, phase: "signin" };
    expect(rt.shouldTick()).toBe(false);
  });
});

describe("persistence", () => {
  test("a restart resumes connected from the data dir, with the cached sweep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rib-adme-"));
    const first = runtime({ dir });
    first.rt.addArea({ name: "legal", keys: [], read: (b) => b.adme("legal", "/info") });
    await first.rt.saveProfile(SAMPLE_PROFILE);
    const second = runtime({ dir });
    expect(second.rt.status.phase).toBe("connected");
    expect(second.rt.profile).toEqual(SAMPLE_PROFILE);
    expect(second.rt.cache.get("legal").at).toBeDefined();
  });
});

describe("headers", () => {
  test("other sections point at the connect steps before connecting", () => {
    const { rt } = runtime();
    const text = JSON.stringify(composeRestingHeader(rt.status, { connectedText: "x" }));
    expect(text).toContain("Finish the connect steps in the header");
  });
});

describe("on-demand reads", () => {
  test("run refuses before connecting and flips to sign-in needed on a lapsed sign-in", async () => {
    const { rt } = runtime();
    expect((await rt.run((b) => b.adme("search", "/info"))).ok).toBe(false);
    let expired = false;
    const exec = azExec(() =>
      expired ? { error: "ERROR: AADSTS50173: expired" } : { token: "t" },
    );
    const second = runtime({ exec });
    await second.rt.saveProfile(SAMPLE_PROFILE);
    expired = true;
    const res = await second.rt.run((b) => b.adme("legal", "/info"));
    expect(res.ok).toBe(false);
    expect(second.rt.status.phase).toBe("signin");
  });
});
