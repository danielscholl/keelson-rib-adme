import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { SELECT_PERSON_ACTION } from "../src/boards/access";
import { composePerson } from "../src/boards/person";
import { composePlan } from "../src/boards/plan";
import {
  composeSeismicSelected,
  PREVIEW_SEIS_COPY_ACTION,
  PREVIEW_SEIS_GRANT_ACTION,
  PREVIEW_SEIS_REVOKE_ACTION,
  PREVIEW_SEIS_SELF_ACTION,
  SEIS_SELECT_ACTION,
} from "../src/boards/seismic";
import { HEALTH_AREA } from "../src/data/health";
import { INSPECT_KEY, PERSON_KEY, PLAN_KEY } from "../src/keys";
import { accessModule } from "../src/modules/access";
import { planModule } from "../src/modules/plan";
import { seismicModule } from "../src/modules/seismic";
import { currentOperation, operationPending } from "../src/plan/apply";
import { bindingOf, planStats } from "../src/plan/model";
import { planState } from "../src/plan/state";
import type { Runtime } from "../src/runtime";
import { SEISMIC_AREA, type SeismicRead } from "../src/seismic/read";
import { sampleAccess } from "./fixtures/access";
import { NOW, SAMPLE_HEALTH } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { groupEmail, sampleGroupMembers, sampleSeismic } from "./fixtures/seismic";
import { routeTransport, type SentRequest, seededRuntime } from "./harness";

const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const INGRID = oid(1);
const MARCUS = oid(4);
const LENA = oid(5);
const HIRO = oid(6);
const _RACHEL = oid(11);
const BASE = 33;
const binding = bindingOf(SAMPLE_PROFILE);

const selectedBoard = expectView(INSPECT_KEY, "board");
const planBoard = expectView(PLAN_KEY, "board");

// Entitlements as a store: each person's seismic groups, read back as effective groups.
function world(extra: Record<string, string[]> = {}) {
  const held = new Map<string, Set<string>>();
  for (const [group, members] of Object.entries(sampleGroupMembers())) {
    for (const m of members) {
      const set = held.get(m.email) ?? new Set<string>();
      set.add(group);
      held.set(m.email, set);
    }
  }
  for (const [id, groups] of Object.entries(extra)) {
    const set = held.get(id) ?? new Set<string>();
    for (const g of groups) set.add(g);
    held.set(id, set);
  }
  const parse = (url: string, re: RegExp) => decodeURIComponent(url.match(re)?.[1] ?? "");
  const routes = routeTransport({
    "GET /api/entitlements/v2/members/": (req) => {
      const id = parse(req.url, /members\/([^/]+)\/groups/);
      const base = Array.from({ length: BASE }, (_, i) => ({ email: `base.${i}@x` }));
      const seis = [...(held.get(id) ?? [])].map((email) => ({ email }));
      return { status: 200, body: { groups: [...base, ...seis] } };
    },
    "POST /api/entitlements/v2/groups/": (req) => {
      const group = parse(req.url, /groups\/([^/]+)\/members/);
      const id = (req.body as { email: string }).email;
      const set = held.get(id) ?? new Set<string>();
      if (set.has(group)) return { status: 409, body: { message: "exists" } };
      set.add(group);
      held.set(id, set);
      return { status: 200, body: {} };
    },
    "DELETE /api/entitlements/v2/groups/": (req) => {
      const group = parse(req.url, /groups\/([^/]+)\/members/);
      const id = parse(req.url, /members\/([^/?]+)$/);
      if (!held.get(id)?.delete(group)) return { status: 404, body: { message: "not found" } };
      return { status: 204 };
    },
  });
  return { ...routes, held };
}

function runtime(
  o: { extra?: Record<string, string[]>; seismic?: SeismicRead; phase?: "signin" } = {},
) {
  const w = world(o.extra);
  const rt = seededRuntime(
    {
      [ACCESS_AREA]: sampleAccess(),
      [HEALTH_AREA]: SAMPLE_HEALTH,
      [SEISMIC_AREA]: o.seismic ?? sampleSeismic(),
    },
    { now: NOW, transport: w.transport, ...(o.phase ? { phase: o.phase } : {}) },
  );
  return { rt, ...w };
}

async function act(rt: Runtime, type: string, payload: Record<string, unknown> = {}) {
  const handler = planModule.actions?.[type] ?? seismicModule.actions?.[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  const res = await handler(rt, { ...binding, ...payload });
  await planState(rt).pending;
  await operationPending(rt);
  return res;
}

async function plan(rt: Runtime, type: string, payload: Record<string, unknown>) {
  const res = await act(rt, type, payload);
  expect(res).toMatchObject({ ok: true });
  const p = planState(rt).plan;
  if (!p) throw new Error(`no plan: ${planState(rt).error}`);
  return p;
}

const writes = (sent: SentRequest[]) => sent.filter((r) => r.method !== "GET");

type Section = CanvasBoardView["sections"][number];

function actionsOf(view: CanvasBoardView) {
  return view.sections
    .filter((s): s is Extract<Section, { kind: "actions" }> => s.kind === "actions")
    .flatMap((s) => s.items);
}

describe("seismic plans", () => {
  test("grant adds one ACL group by object id, then verifies one more group", async () => {
    const { rt, sent } = runtime();
    const p = await plan(rt, PREVIEW_SEIS_GRANT_ACTION, {
      id: LENA,
      subproject: "alpha",
      role: "viewer",
    });
    expect(p.kind).toBe("seismic-grant");
    expect(p.title).toBe("grant Lena Fischer viewer on alpha");
    expect(planStats(p)).toEqual({ willChange: 1, alreadyTrue: 0, blocked: 0, subjects: 1 });
    const [add, verify] = p.subjects[0]?.steps ?? [];
    expect(add?.call).toEqual({
      service: "entitlements",
      method: "POST",
      path: `/groups/${encodeURIComponent(groupEmail("alpha", "viewer"))}/members`,
      body: { email: LENA, role: "MEMBER" },
    });
    expect(add?.text).toBe(
      "POST entitlements /groups/data.sdms.opendes.alpha.b001…01.viewer@…/members {email: 0000…0005, role: MEMBER}",
    );
    expect(verify).toMatchObject({ kind: "verify", change: false, expect: BASE + 1 });
    expect(p.subjects[0]?.reason).toBeUndefined();
    expect(writes(sent)).toEqual([]);
    const text = JSON.stringify(planBoard(composePlan(rt)));
    expect(text).toContain('"title":"Apply 1 change?"');
    expect(text).not.toContain('"irreversible":true');
  });

  test("granting a role already held is already true and changes nothing", async () => {
    const { rt } = runtime();
    const p = await plan(rt, PREVIEW_SEIS_GRANT_ACTION, {
      id: MARCUS,
      subproject: "alpha",
      role: "viewer",
    });
    expect(planStats(p)).toMatchObject({ willChange: 0, alreadyTrue: 1 });
    expect(p.subjects[0]?.steps.at(-1)?.expect).toBe(BASE + 2);
  });

  test("revoke removes the membership, says what is left, and needs a typed confirm", async () => {
    const { rt } = runtime();
    const p = await plan(rt, PREVIEW_SEIS_REVOKE_ACTION, {
      id: MARCUS,
      subproject: "alpha",
      role: "viewer",
    });
    expect(p.title).toBe("revoke Marcus Oyelaran's viewer on alpha");
    expect(p.subjects[0]?.steps.map((t) => [t.kind, t.call?.method])).toEqual([
      ["member-remove", "DELETE"],
      ["verify", "GET"],
    ]);
    expect(p.subjects[0]?.steps[0]?.call?.path).toBe(
      `/groups/${encodeURIComponent(groupEmail("alpha", "viewer"))}/members/${MARCUS}`,
    );
    expect(p.subjects[0]?.steps[1]?.expect).toBe(BASE + 1);
    expect(p.subjects[0]?.reason).toBe("After this, Marcus Oyelaran no longer reaches alpha.");
    const text = JSON.stringify(planBoard(composePlan(rt)));
    expect(text).toContain('"irreversible":true,"subject":"Marcus Oyelaran"');
    expect(text).toContain('"title":"Revoke Marcus Oyelaran"');
    expect(text).toContain('"destructive":true');
  });

  test("revoking the last grant on a subproject still reached through data.default says so", async () => {
    const { rt } = runtime({ extra: { [LENA]: [groupEmail("drogon", "admin")] } });
    const p = await plan(rt, PREVIEW_SEIS_REVOKE_ACTION, {
      id: LENA,
      subproject: "drogon",
      role: "admin",
    });
    expect(planStats(p).willChange).toBe(1);
    expect(p.subjects[0]?.reason).toBe(
      "This is Lena Fischer's last grant on drogon, which is fine: they still read it as viewer through data.default.viewers.",
    );
  });

  test("revoking a role not held is already true", async () => {
    const { rt } = runtime();
    const p = await plan(rt, PREVIEW_SEIS_REVOKE_ACTION, {
      id: LENA,
      subproject: "alpha",
      role: "viewer",
    });
    expect(planStats(p)).toMatchObject({ willChange: 0, alreadyTrue: 1 });
    expect(p.subjects[0]?.reason).toBe("Lena Fischer is not in this group; nothing to remove.");
  });

  test("a grant through data.default is refused with a reason, not planned", async () => {
    const { rt, sent } = runtime();
    const p = await plan(rt, PREVIEW_SEIS_GRANT_ACTION, {
      id: LENA,
      subproject: "volve",
      role: "viewer",
    });
    expect(planStats(p)).toEqual({ willChange: 0, alreadyTrue: 0, blocked: 1, subjects: 1 });
    expect(p.subjects[0]?.steps).toEqual([]);
    expect(p.subjects[0]?.reason).toBe(
      "volve viewers come through data.default.viewers. Adding Lena Fischer to data.default.viewers would change every default-ACL subproject at once (volve and drogon), so the rib does not plan it.",
    );
    expect(sent).toEqual([]);
    const text = JSON.stringify(planBoard(composePlan(rt)));
    expect(text).toContain("Protected or excluded · 1");
    expect(text).toContain('"reason":"nothing to change"');
  });

  test("a grant through a shared group names every subproject it covers", async () => {
    const seismic = sampleSeismic();
    const golf = seismic.subprojects.find((s) => s.name === "golf");
    for (const s of seismic.subprojects) {
      if (s.name === "golf2" || s.name === "golf3") s.viewers = [...(golf?.viewers ?? [])];
    }
    const { rt } = runtime({ seismic });
    const p = await plan(rt, PREVIEW_SEIS_GRANT_ACTION, {
      id: LENA,
      subproject: "golf2",
      role: "viewer",
    });
    expect(p.subjects[0]?.steps[0]?.call?.path).toContain(
      encodeURIComponent(groupEmail("golf", "viewer")),
    );
    expect(p.subjects[0]?.reason).toBe(
      "This group is shared by golf, golf2 and golf3; the change reaches all of them.",
    );
    expect(JSON.stringify(planBoard(composePlan(rt)))).toContain("shared by golf, golf2 and golf3");
  });

  test("copy grants adds what the source holds and marks what the target already has", async () => {
    const { rt } = runtime({ extra: { [HIRO]: [groupEmail("delta", "viewer")] } });
    const p = await plan(rt, PREVIEW_SEIS_COPY_ACTION, { from: MARCUS, to: HIRO });
    expect(p.kind).toBe("seismic-copy");
    expect(p.title).toBe("copy Marcus Oyelaran's seismic grants to Hiro Tanaka");
    expect(p.subjects).toHaveLength(1);
    expect(p.subjects[0]?.name).toBe("Hiro Tanaka");
    const steps = p.subjects[0]?.steps ?? [];
    expect(steps.map((t) => [t.kind, t.already ?? false])).toEqual([
      ["member-add", false],
      ["member-add", true],
      ["verify", false],
    ]);
    expect(steps[0]?.call?.path).toContain(encodeURIComponent(groupEmail("alpha", "viewer")));
    expect(steps[1]?.call?.path).toContain(encodeURIComponent(groupEmail("delta", "viewer")));
    expect(steps[2]?.expect).toBe(BASE + 2 + 1);
    expect(planStats(p)).toEqual({ willChange: 1, alreadyTrue: 1, blocked: 0, subjects: 1 });
    expect(p.subjects[0]?.reason).toContain(
      "Copies Marcus Oyelaran's grants: alpha viewer and delta viewer. Hiro Tanaka already holds delta viewer.",
    );
  });

  test("copy refuses the same person and a source with no grants", async () => {
    const { rt } = runtime();
    expect(await act(rt, PREVIEW_SEIS_COPY_ACTION, { from: LENA, to: LENA })).toMatchObject({
      ok: false,
    });
    await act(rt, PREVIEW_SEIS_COPY_ACTION, { from: LENA, to: HIRO });
    expect(planState(rt).error).toBe("Lena Fischer holds no seismic grant to copy.");
  });

  test("Apply over the transport writes the grant and verifies the new count", async () => {
    const { rt, sent, held } = runtime();
    const p = await plan(rt, PREVIEW_SEIS_GRANT_ACTION, {
      id: LENA,
      subproject: "alpha",
      role: "viewer",
    });
    expect(await act(rt, "apply-plan", { planId: p.id })).toMatchObject({ ok: true });
    const op = currentOperation(rt);
    expect(op?.status).toBe("done");
    expect(op?.steps.map((t) => t.state)).toEqual(["done", "done", "done"]);
    expect(op?.steps.at(-1)?.note).toBe(`${BASE + 1} groups`);
    const w = writes(sent);
    expect(w).toHaveLength(1);
    expect(w[0]?.url).toContain(
      `/api/entitlements/v2/groups/${encodeURIComponent(groupEmail("alpha", "viewer"))}/members`,
    );
    expect(w[0]?.body).toEqual({ email: LENA, role: "MEMBER" });
    expect(w[0]?.headers["correlation-id"]).toBe(`keelson-adme-${p.id}-1`);
    expect(held.get(LENA)?.has(groupEmail("alpha", "viewer"))).toBe(true);
  });

  test("Apply aborts when the membership changed since the dry run", async () => {
    const { rt, sent, held } = runtime();
    const p = await plan(rt, PREVIEW_SEIS_GRANT_ACTION, {
      id: LENA,
      subproject: "alpha",
      role: "viewer",
    });
    held.set(LENA, new Set([groupEmail("alpha", "viewer")]));
    await act(rt, "apply-plan", { planId: p.id });
    expect(currentOperation(rt)?.status).toBe("aborted");
    expect(writes(sent)).toEqual([]);
  });
});

describe("the selected subproject", () => {
  test("Grant access… and Add myself as admin, disabled when you are already one", () => {
    const { rt } = runtime();
    const view = selectedBoard(composeSeismicSelected(rt)) as CanvasBoardView;
    const [grant, self] = actionsOf(view);
    expect(grant).toMatchObject({
      type: PREVIEW_SEIS_GRANT_ACTION,
      label: "Grant access…",
      binding: { ...binding, subproject: "alpha" },
    });
    expect(grant?.disabled).toBeUndefined();
    expect(self).toMatchObject({
      type: PREVIEW_SEIS_SELF_ACTION,
      label: "Add myself as admin",
      disabled: true,
      reason: "you are already an admin",
    });
  });

  test("Add myself as admin previews a grant for the signed-in operator", async () => {
    const { rt } = runtime();
    await act(rt, SEIS_SELECT_ACTION, { subproject: "sleipner" });
    const [, self] = actionsOf(selectedBoard(composeSeismicSelected(rt)) as CanvasBoardView);
    expect(self?.disabled).toBeUndefined();
    const p = await plan(rt, PREVIEW_SEIS_SELF_ACTION, { subproject: "sleipner" });
    expect(p.title).toBe("grant Ingrid Halvorsen admin on sleipner");
    expect(p.subjects[0]?.oid).toBe(INGRID);
    expect(p.subjects[0]?.steps[0]?.call?.path).toContain(
      encodeURIComponent(groupEmail("sleipner", "admin")),
    );
  });

  test("a subproject on the default ACL offers no grant", async () => {
    const { rt } = runtime();
    await act(rt, SEIS_SELECT_ACTION, { subproject: "volve" });
    const [grant, self] = actionsOf(selectedBoard(composeSeismicSelected(rt)) as CanvasBoardView);
    expect(grant).toMatchObject({
      disabled: true,
      reason: "this subproject is on the default ACL",
    });
    expect(self).toMatchObject({
      disabled: true,
      reason: "admins come through data.default.owners",
    });
  });
});

describe("every seismic change frame passes its validator", () => {
  const states: [string, () => Promise<Runtime>][] = [
    ["measured", async () => runtime().rt],
    ["signin", async () => runtime({ phase: "signin" }).rt],
    [
      "revoke planned",
      async () => {
        const { rt } = runtime();
        await act(rt, PREVIEW_SEIS_REVOKE_ACTION, {
          id: MARCUS,
          subproject: "delta",
          role: "viewer",
        });
        return rt;
      },
    ],
  ];
  for (const [name, make] of states) {
    test(name, async () => {
      const rt = await make();
      planBoard(composePlan(rt));
      for (const s of sampleSeismic().subprojects) {
        if (rt.status.phase === "connected") {
          await act(rt, SEIS_SELECT_ACTION, { subproject: s.name });
        }
        selectedBoard(composeSeismicSelected(rt));
      }
    });
  }
});

describe("what a partner can reach", () => {
  test("the person inspector carries the access note with every path", async () => {
    const { rt } = runtime();
    await accessModule.actions?.[SELECT_PERSON_ACTION]?.(rt, { id: MARCUS });
    const view = expectView(PERSON_KEY, "board")(composePerson(rt));
    const text = JSON.stringify(view);
    expect(text).toContain("What Marcus Oyelaran can reach · 4 paths");
    expect(text).toContain("sd://opendes/alpha");
    expect(text).toContain("Copy only. The rib does not send mail.");
  });
});

describe("grant seismic from the access tab", () => {
  test("Change access offers own-ACL subprojects once the store is read", async () => {
    const { composeChange } = await import("../src/boards/change");
    const { composePerson } = await import("../src/boards/person");
    const { selectPerson } = await import("../src/access/person");
    const { rt } = runtime();
    const change = JSON.stringify(composeChange(rt));
    expect(change).toContain('"type":"preview-seismic-grant"');
    expect(change).toContain('"value":"alpha"');
    expect(change).not.toContain('"value":"volve"');
    selectPerson(rt, LENA);
    expect(JSON.stringify(composePerson(rt))).not.toContain('"type":"preview-seismic-grant"');
    const unread = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW });
    expect(JSON.stringify(composeChange(unread))).toContain(
      "read the subprojects in the Seismic section first",
    );
  });
});

describe("plans from the console", () => {
  const KARI = "00000000-0000-4000-8000-0000000000ff";

  function withFormer() {
    const seismic = sampleSeismic();
    seismic.groups[groupEmail("delta", "viewer")]?.members?.push(KARI);
    seismic.directory = {
      [KARI]: { kind: "user", name: "Kari Solberg", mail: "kari@halden-geo.example" },
    };
    return runtime({ seismic, extra: { [KARI]: [groupEmail("delta", "viewer")] } });
  }

  test("a grant held without instance access can be revoked", async () => {
    const { rt, sent } = withFormer();
    const p = await plan(rt, PREVIEW_SEIS_REVOKE_ACTION, {
      id: KARI,
      subproject: "delta",
      role: "viewer",
    });
    expect(p.title).toBe("revoke Kari Solberg's viewer on delta");
    expect(planStats(p)).toMatchObject({ willChange: 1, blocked: 0 });
    expect(writes(sent)).toEqual([]);
  });

  test("a grant to someone without instance access is planned as blocked", async () => {
    const { rt } = withFormer();
    const p = await plan(rt, PREVIEW_SEIS_GRANT_ACTION, {
      id: KARI,
      subproject: "alpha",
      role: "viewer",
    });
    expect(p.subjects[0]).toMatchObject({
      blocked: true,
      reason:
        "Kari Solberg holds no users@ or role group, so a seismic grant could not be used. Restore instance access first.",
    });
  });

  test("the plan sheet leads with who, then current against proposed and each group's reach", async () => {
    const { rt } = runtime();
    await plan(rt, PREVIEW_SEIS_GRANT_ACTION, { id: LENA, subproject: "alpha", role: "viewer" });
    const view = planBoard(composePlan(rt));
    if (view.view !== "board") throw new Error("board expected");
    const titles = view.sections.map((s) => ("title" in s ? s.title : undefined));
    expect(titles.slice(0, 3)).toEqual([
      "Who · Lena Fischer",
      "Current and proposed · 1 subproject touched",
      "Reach · every subproject each touched group backs",
    ]);
    const change = view.sections[1];
    if (change?.kind !== "rows") throw new Error("rows expected");
    expect(change.items[0]).toMatchObject({ text: "alpha · selected", trailing: "none → Viewer" });
  });
});
