import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { composeChange } from "../src/boards/change";
import { composePlan } from "../src/boards/plan";
import { CHANGE_KEY, PLAN_KEY } from "../src/keys";
import { planModule } from "../src/modules/plan";
import { parseAddresses } from "../src/plan/classify";
import { bindingOf, dryRunCsv, PLAN_TTL_MS, planStats } from "../src/plan/model";
import { planState } from "../src/plan/state";
import { sampleAccess, sampleCohortCsv } from "./fixtures/access";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { routeTransport, seededRuntime } from "./harness";

const NOW = new Date("2026-10-02T14:03:00Z");
const RACHEL = "00000000-0000-4000-8000-000000000011";
const binding = bindingOf(SAMPLE_PROFILE);

interface World {
  users: Record<
    string,
    { id: string; displayName: string; mail: string; otherMails?: string[]; userType?: string }[]
  >;
  deleted?: Record<string, { id: string; displayName: string; mail: string }[]>;
}

// Answers the classification reads by the address in the $filter.
function graph(world: World) {
  const addressOf = (url: string) => decodeURIComponent(url).match(/mail eq '([^']+)'/)?.[1] ?? "";
  return routeTransport({
    "GET /v1.0/users?": (req) => ({
      status: 200,
      body: { value: world.users[addressOf(req.url)] ?? [] },
    }),
    "GET /v1.0/directory/deletedItems/microsoft.graph.user": (req) => ({
      status: 200,
      body: { value: world.deleted?.[addressOf(req.url)] ?? [] },
    }),
    "GET /v1.0/servicePrincipals": () => ({
      status: 200,
      body: {
        value: [
          { appId: "11111111-2222-4333-8444-555555555555", displayName: "contoso-adme-reporting" },
        ],
      },
    }),
  });
}

const RACHEL_ACCOUNT = {
  id: RACHEL,
  displayName: "Rachel Kim",
  mail: "rachel.kim@pacrim-energy.example",
  otherMails: ["rkim@pacrim-energy.example", "r.kim@pacrim.example"],
  userType: "Guest",
};

function runtime(world: World = { users: { "r.kim@pacrim.example": [RACHEL_ACCOUNT] } }) {
  const { transport, sent } = graph(world);
  const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
  rt.tracker.importCsv(sampleCohortCsv(), NOW);
  return { rt, sent };
}

async function act(
  rt: ReturnType<typeof runtime>["rt"],
  type: string,
  payload: Record<string, unknown>,
) {
  const res = await planModule.actions?.[type]?.(rt, { ...binding, ...payload });
  await planState(rt).pending;
  return res;
}

const ADD = {
  emails: "kofi.mensah@volta-subsurface.example\nr.kim@pacrim.example",
  cohort: "Pilot",
  passEnds: "2026-10-28",
  role: "Editor",
};

describe("add people", () => {
  test("reproduces the worked example: 4 changes, 1 address blocked as the same home identity", async () => {
    const { rt, sent } = runtime();
    const res = await act(rt, "preview-add-people", ADD);
    expect(res).toMatchObject({ ok: true, data: { effect: "open-canvas", key: PLAN_KEY } });
    const plan = planState(rt).plan;
    if (!plan) throw new Error("no plan");
    expect(plan.title).toBe("add 2 people to Pilot");
    expect(planStats(plan)).toEqual({ willChange: 4, alreadyTrue: 0, blocked: 1, subjects: 2 });
    const [kofi, rkim] = plan.subjects;
    expect(kofi?.classification).toBe("will-invite");
    expect(kofi?.steps.map((t) => t.kind)).toEqual([
      "invite",
      "wait",
      "roster-add",
      "member-add",
      "member-add",
      "verify",
    ]);
    expect(kofi?.steps.at(-1)?.expect).toBe(33);
    expect(kofi?.footnote).toBe("first-seen domain volta-subsurface.example");
    expect(rkim).toMatchObject({ classification: "same-identity", blocked: true, oid: RACHEL });
    expect(rkim?.reason).toContain("Same home identity as Rachel Kim");
    expect(sent.every((r) => r.method === "GET")).toBe(true);
  });

  test("the plan sheet draws the dry run and never offers Apply yet", async () => {
    const { rt } = runtime();
    await act(rt, "preview-add-people", ADD);
    const view = expectView(PLAN_KEY, "board")(composePlan(rt));
    const text = JSON.stringify(view);
    expect(text).toContain('"label":"dry run · nothing changed"');
    expect(text).toMatch(/plan [0-9a-f]{4} · expires in 30 min/);
    expect(text).toContain('"label":"Will change","value":4,"sub":"all for kofi.mensah"');
    expect(text).toContain("Protected or excluded · 1");
    expect(text).toContain("POST graph /v1.0/invitations (sends an email)");
    expect(text).toContain('"label":"Apply 4 changes"');
    expect(text).toContain('"disabled":true');
  });

  test("an address already in entitlements by its own mail reads as already true", async () => {
    const { rt } = runtime({
      users: {
        "rachel.kim@pacrim-energy.example": [RACHEL_ACCOUNT],
      },
    });
    await act(rt, "preview-add-people", {
      emails: "rachel.kim@pacrim-energy.example",
      role: "Editor",
    });
    const plan = planState(rt).plan;
    expect(plan?.subjects[0]?.classification).toBe("has-access");
    expect(planStats(plan!)).toMatchObject({ willChange: 1, alreadyTrue: 2 });
    expect(
      plan?.subjects[0]?.steps.find((t) => t.kind === "member-add" && !t.already)?.text,
    ).toContain("users@");
  });

  test("a deleted account is restored, not invited again", async () => {
    const { rt } = runtime({
      users: {},
      deleted: {
        "back@again.example": [
          {
            id: "dddd0000-0000-4000-8000-000000000001",
            displayName: "Back Again",
            mail: "back@again.example",
          },
        ],
      },
    });
    await act(rt, "preview-add-people", { emails: "back@again.example", role: "Viewer" });
    const s = planState(rt).plan?.subjects[0];
    expect(s?.classification).toBe("restorable");
    expect(s?.steps[0]?.kind).toBe("restore");
    expect(s?.steps.some((t) => t.kind === "invite")).toBe(false);
  });

  test("two accounts answering to one address block it as ambiguous", async () => {
    const { rt } = runtime({
      users: {
        "twice@x.example": [
          { id: "aaaa0000-0000-4000-8000-000000000001", displayName: "A", mail: "twice@x.example" },
          {
            id: "aaaa0000-0000-4000-8000-000000000002",
            displayName: "B",
            mail: "other@x.example",
            otherMails: ["twice@x.example"],
          },
        ],
      },
    });
    await act(rt, "preview-add-people", { emails: "twice@x.example", role: "Editor" });
    expect(planState(rt).plan?.subjects[0]).toMatchObject({
      classification: "ambiguous",
      blocked: true,
    });
  });

  test("bad and repeated addresses are excluded, not planned", () => {
    expect(parseAddresses("a@x.example\nnot-an-email\nA@x.example")).toEqual({
      addresses: ["a@x.example"],
      excluded: [
        { address: "not-an-email", reason: "not an email address" },
        { address: "a@x.example", reason: "listed twice" },
      ],
    });
  });

  test("a board drawn for another instance is refused", async () => {
    const { rt } = runtime();
    const res = await planModule.actions?.["preview-add-people"]?.(rt, {
      ...ADD,
      ...binding,
      host: "other.example",
    });
    expect(res).toMatchObject({ ok: false });
    expect(planState(rt).plan).toBeUndefined();
  });

  test("an untracked cohort and a bad date are refused", async () => {
    const { rt } = runtime();
    expect(await act(rt, "preview-add-people", { ...ADD, cohort: "Nope" })).toMatchObject({
      ok: false,
    });
    expect(await act(rt, "preview-add-people", { ...ADD, passEnds: "28/10/2026" })).toMatchObject({
      ok: false,
    });
  });
});

describe("recheck and expiry", () => {
  test("a recheck that finds the same world keeps the plan id", async () => {
    const { rt } = runtime();
    await act(rt, "preview-add-people", ADD);
    const first = planState(rt).plan!;
    await act(rt, "recheck-plan", { planId: first.id });
    expect(planState(rt).plan?.id).toBe(first.id);
    expect(planState(rt).changedFrom).toBeUndefined();
  });

  test("a recheck that finds a changed world makes a new plan and says so", async () => {
    const world: World = { users: { "r.kim@pacrim.example": [RACHEL_ACCOUNT] } };
    const { transport } = graph(world);
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW, transport });
    rt.tracker.importCsv(sampleCohortCsv(), NOW);
    await act(rt, "preview-add-people", ADD);
    const first = planState(rt).plan!;
    world.users["kofi.mensah@volta-subsurface.example"] = [
      {
        id: "kkkk0000-0000-4000-8000-000000000001",
        displayName: "Kofi Mensah",
        mail: "kofi.mensah@volta-subsurface.example",
        userType: "Guest",
      },
    ];
    await act(rt, "recheck-plan", { planId: first.id });
    const second = planState(rt).plan!;
    expect(second.hash).not.toBe(first.hash);
    expect(planState(rt).changedFrom?.id).toBe(first.id);
    expect(JSON.stringify(composePlan(rt))).toContain(`The dry run changed since plan ${first.id}`);
  });

  test("an expired plan says so and cannot be applied", async () => {
    const { rt } = runtime();
    await act(rt, "preview-add-people", ADD);
    const later = seededRuntime({}, { now: new Date(NOW.getTime() + PLAN_TTL_MS + 1) });
    Object.assign(planState(later), planState(rt));
    const text = JSON.stringify(composePlan(later));
    expect(text).toContain("expired · nothing changed");
    expect(text).toContain("the plan expired; Recheck to refresh it");
  });
});

describe("person plans", () => {
  test("fixing a missing users@ adds that one membership and verifies 33", async () => {
    const { rt } = runtime();
    await act(rt, "preview-fix-users", { id: RACHEL });
    const plan = planState(rt).plan!;
    expect(planStats(plan)).toMatchObject({ willChange: 1, alreadyTrue: 0 });
    expect(plan.subjects[0]?.steps.map((t) => [t.kind, t.expect])).toEqual([
      ["member-add", undefined],
      ["verify", 33],
    ]);
  });

  test("cleaning up a duplicate removes the entry by email and keeps the one by object id", async () => {
    const { rt } = runtime();
    const dmitri = "00000000-0000-4000-8000-000000000012";
    await act(rt, "preview-cleanup-duplicate", { id: dmitri });
    const step = planState(rt).plan?.subjects[0]?.steps[0];
    expect(step?.call?.method).toBe("DELETE");
    expect(decodeURIComponent(step?.call?.path ?? "")).toContain(
      "users.datalake.editors@opendes.dataservices.energy/members/d.volkov@baltica.example",
    );
  });

  test("removing a person drops role groups, then users@, then the roster group", async () => {
    const { rt } = runtime();
    const lena = "00000000-0000-4000-8000-000000000005";
    await act(rt, "preview-remove-person", { id: lena });
    const steps = planState(rt).plan?.subjects[0]?.steps ?? [];
    expect(steps.map((t) => t.kind)).toEqual(["member-remove", "member-remove", "roster-remove"]);
    expect(steps[0]?.text).toContain("users.datalake.editors");
    expect(steps[1]?.text).toContain("users@");
  });

  test("an application is added by app id", async () => {
    const { rt } = runtime();
    await act(rt, "preview-add-app", {
      appId: "11111111-2222-4333-8444-555555555555",
      role: "Viewer",
    });
    const plan = planState(rt).plan!;
    expect(plan.title).toBe("add contoso-adme-reporting as Viewer");
    expect(plan.subjects[0]?.steps[0]?.call?.body).toEqual({
      email: "11111111-2222-4333-8444-555555555555",
      role: "MEMBER",
    });
  });
});

describe("dry run export and the change region", () => {
  test("the dry run CSV has one line per step and one per blocked address", async () => {
    const { rt } = runtime();
    await act(rt, "preview-add-people", ADD);
    const lines = dryRunCsv(planState(rt).plan!).trim().split("\n");
    expect(lines).toHaveLength(1 + 6 + 1);
    expect(lines.at(-1)).toContain("r.kim@pacrim.example,same-identity");
  });

  test("the change region offers the forms, and sign-in needed disables them", () => {
    const { rt } = runtime();
    const text = JSON.stringify(expectView(CHANGE_KEY, "board")(composeChange(rt)));
    expect(text).toContain('"label":"Add people"');
    expect(text).toContain('"submitLabel":"Preview plan"');
    expect(text).toContain('"value":"Pilot"');
    const signedOut = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { phase: "signin" });
    expect(JSON.stringify(composeChange(signedOut))).toContain(
      "sign-in needed: run az login, then Re-test",
    );
    expect(composeChange(seededRuntime({}, { phase: "firstrun" })).sections).toEqual([]);
  });
});
