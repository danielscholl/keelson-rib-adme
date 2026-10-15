import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_AREA,
  type ActivityRead,
  activityQuery,
  NO_WORKSPACE,
  readActivity,
} from "../src/access/activity";
import { accessGuideMarkdown } from "../src/access/guide";
import { orgOf, registrableDomain } from "../src/access/orgs";
import { selectPerson } from "../src/access/person";
import { ACCESS_AREA } from "../src/access/read";
import { daysAgo, measuredAccess } from "../src/boards/access";
import { composePerson } from "../src/boards/person";
import { briefOf } from "../src/brief/inputs";
import { Batch } from "../src/client";
import { findAuditWorkspace } from "../src/discover";
import { sampleAccess } from "./fixtures/access";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { azExec, routeTransport, seededRuntime } from "./harness";

const WORKSPACE = "7a1b0000-0000-4000-8000-00000000c0de";
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

// Ingrid (you), Priya and Dmitri called this week; Tomas last called 12 days ago.
function sampleActivity(): ActivityRead {
  return {
    windowDays: 90,
    rows: [
      { id: id(1), day: "2026-10-01", calls: 140 },
      { id: id(1), day: "2026-10-02", calls: 60 },
      { id: id(3), day: "2026-09-30", calls: 25 },
      { id: id(12), day: "2026-10-02", calls: 12 },
      { id: id(2), day: "2026-09-20", calls: 8 },
    ],
  };
}

function rt(activity: ActivityRead | undefined = sampleActivity()) {
  const runtime = seededRuntime({
    [ACCESS_AREA]: sampleAccess(),
    ...(activity ? { [ACTIVITY_AREA]: activity } : {}),
  });
  runtime.status = {
    ...runtime.status,
    profile: { ...SAMPLE_PROFILE, logWorkspaceId: WORKSPACE },
  };
  return runtime;
}

describe("audit log read", () => {
  test("queries OEPAuditLogs for the partition by day and caller, quoting the partition", () => {
    const q = activityQuery('op"en\\des');
    expect(q).toContain("OEPAuditLogs");
    expect(q).toContain('DataPartitionId =~ "op\\"en\\\\des"');
    expect(q).toContain("by id = tolower(Puid)");
  });

  test("posts to the workspace with a Log Analytics token and parses the rows", async () => {
    const exec = azExec();
    const { transport, sent } = routeTransport({
      [`POST api.loganalytics.io/v1/workspaces/${WORKSPACE}/query`]: () => ({
        status: 200,
        body: {
          tables: [
            {
              name: "PrimaryResult",
              columns: [{ name: "id" }, { name: "day" }, { name: "calls" }],
              rows: [[id(1).toUpperCase(), "2026-10-01", 3]],
            },
          ],
        },
      }),
    });
    const batch = new Batch(
      exec,
      { ...SAMPLE_PROFILE, logWorkspaceId: WORKSPACE },
      transport,
      async () => undefined,
    );
    const res = await readActivity(batch);
    expect(res).toMatchObject({
      ok: true,
      data: { windowDays: 90, rows: [{ id: id(1), day: "2026-10-01", calls: 3 }] },
    });
    expect(sent[0]?.headers.Authorization).toBe("Bearer tok-https://api.loganalytics.io");
    expect(sent[0]?.body).toMatchObject({ timespan: "P90D" });
  });

  test("a workspace this sign-in cannot read fails this read only, never the sign-in", async () => {
    const { transport } = routeTransport({
      "POST api.loganalytics.io": () => ({ status: 403, body: { error: { message: "nope" } } }),
    });
    const batch = new Batch(
      azExec(),
      { ...SAMPLE_PROFILE, logWorkspaceId: WORKSPACE },
      transport,
      async () => undefined,
    );
    expect(await readActivity(batch)).toMatchObject({
      ok: false,
      failure: { kind: "client", message: "Audit log: nope" },
    });
  });

  test("without a workspace nothing is called", async () => {
    const { transport, sent } = routeTransport({});
    const batch = new Batch(azExec(), SAMPLE_PROFILE, transport, async () => undefined);
    expect(await readActivity(batch)).toMatchObject({
      ok: false,
      failure: { message: NO_WORKSPACE },
    });
    expect(sent).toHaveLength(0);
  });
});

describe("usage", () => {
  test("Invited, Not used, Idle and Active follow the guide's definitions", () => {
    const m = measuredAccess(rt());
    if (!m) throw new Error("measured expected");
    const usage = (n: number) => m.usage.get(id(n));
    expect([usage(1), usage(3), usage(12), usage(2), usage(5), usage(8)]).toEqual([
      "active",
      "active",
      "active",
      "idle",
      "not-used",
      "invited",
    ]);
  });

  test("a log with no call from you is not trusted, so use stays unmeasured", () => {
    const read = sampleActivity();
    read.rows = read.rows.filter((r) => r.id !== id(1));
    const m = measuredAccess(rt(read));
    expect(m?.activity).toMatchObject({ kind: "unread" });
    expect(m?.usage.get(id(3))).toBeUndefined();
    expect(briefOf(rt(read)).adoption).toBe(
      "Observed use is not measured: the audit log holds no call from you, so it is not read as this instance's log.",
    );
  });
});

describe("boards with the audit log read", () => {
  test("ages past a year read in years", () => {
    const now = new Date("2026-10-02T00:00:00Z");
    expect(daysAgo("2019-12-01T00:00:00Z", now)).toBe("6.8 y ago");
    expect(daysAgo("2026-09-20T00:00:00Z", now)).toBe("12 d ago");
  });

  test("the person inspector shows use and calls per day", () => {
    const runtime = rt();
    selectPerson(runtime, id(1));
    const text = JSON.stringify(composePerson(runtime));
    expect(text).toContain('{"label":"Status","value":"Active","tone":"ok"}');
    expect(text).toContain('{"label":"Last data call","value":"2026-10-02 · today"}');
    expect(text).toContain('"title":"Data calls per day"');
  });

  test("the guide table uses the guide's columns and words", () => {
    const m = measuredAccess(rt());
    if (!m) throw new Error("measured expected");
    const md = accessGuideMarkdown(m);
    expect(md.split("\n")[0]).toBe("| Name | Email | Status | Granted | Last active |");
    expect(md).toContain("| Ingrid Halvorsen (ops) | ingrid.halvorsen@contoso.example | Active |");
    expect(md).toContain("| Ben Whitaker | ben.whitaker@northfield.example | Invited |");
  });

  test("the guide table escapes cell text", () => {
    const m = measuredAccess(rt());
    if (!m) throw new Error("measured expected");
    const p = m.model.people.find((x) => x.name === "Ben Whitaker");
    if (!p) throw new Error("Ben expected");
    p.name = "Ben\\|Whit\naker";
    expect(accessGuideMarkdown(m)).toContain("| Ben\\\\\\|Whit aker | ben.whitaker@");
  });
});

describe("organizations", () => {
  test("names come from the registrable domain", () => {
    expect(registrableDomain("alumni.northwind.ac.uk")).toBe("northwind.ac.uk");
    expect(orgOf({ email: "a@alumni.northwind.ac.uk" }).name).toBe("Northwind");
    expect(orgOf({ email: "a@k2-consulting.example" }).name).toBe("K2 Consulting");
    expect(orgOf({ email: "a@halden-geo.example" }).name).toBe("Halden Geo");
    expect(orgOf({ email: "a@xyz.example" }).name).toBe("XYZ");
    expect(orgOf({}).name).toBe("No email");
  });
});

describe("finding the audit log", () => {
  test("follows the instance's diagnostic setting to the workspace id", async () => {
    const calls: string[][] = [];
    const exec = {
      runJSON: async <T>(_cmd: string, args: string[]) => {
        calls.push(args);
        const url = args[args.indexOf("--url") + 1] ?? "";
        const data = url.includes("ResourceGraph")
          ? { data: [{ id: "/subscriptions/s/resourceGroups/g/providers/x/energyServices/a" }] }
          : url.includes("diagnosticSettings")
            ? { value: [{ properties: { workspaceId: "/subscriptions/s/workspaces/adme-logs" } }] }
            : { name: "adme-logs", properties: { customerId: WORKSPACE } };
        return { ok: true as const, data: data as T };
      },
      runText: async () => ({ ok: false as const, error: "no", code: null }),
    };
    expect(await findAuditWorkspace(exec, SAMPLE_PROFILE.host)).toEqual({
      ok: true,
      workspaceId: WORKSPACE,
      name: "adme-logs",
    });
    const body = calls[0]?.[calls[0].indexOf("--body") + 1] ?? "";
    expect(JSON.parse(body).query).toContain(`properties.dnsName =~ "${SAMPLE_PROFILE.host}"`);
  });

  test("an instance with no diagnostic setting says so", async () => {
    const exec = {
      runJSON: async <T>(_cmd: string, args: string[]) => {
        const url = args[args.indexOf("--url") + 1] ?? "";
        const data = url.includes("ResourceGraph") ? { data: [{ id: "/x" }] } : { value: [] };
        return { ok: true as const, data: data as T };
      },
      runText: async () => ({ ok: false as const, error: "no", code: null }),
    };
    expect(await findAuditWorkspace(exec, SAMPLE_PROFILE.host)).toEqual({
      ok: false,
      error: "The instance sends no diagnostic logs to a Log Analytics workspace.",
    });
  });
});

describe("freshness", () => {
  test("a reading from an earlier day carries its date", () => {
    const runtime = rt();
    runtime.cache.succeed("probe", {}, new Date("2026-09-27T22:13:00Z"));
    expect(runtime.freshness("probe")).toBe("measured 2026-09-27 22:13Z");
    runtime.cache.succeed("probe", {}, new Date("2026-10-02T13:50:00Z"));
    expect(runtime.freshness("probe")).toBe("measured 13:50Z");
  });
});
