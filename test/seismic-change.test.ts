import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { SIGNIN_REASON } from "../src/boards/connection";
import { composePlan } from "../src/boards/plan";
import {
  composeSeismicSelected,
  PREVIEW_SEIS_COPY_ACTION,
  PREVIEW_SEIS_GRANT_ACTION,
  PREVIEW_SEIS_REVOKE_ACTION,
  PREVIEW_SEIS_SELF_ACTION,
  SEIS_REACH_ACTION,
  SEIS_SELECT_ACTION,
} from "../src/boards/seismic";
import { composeSeismicChange, composeSeismicReach } from "../src/boards/seismic-change";
import { SERVICES_AREA } from "../src/data/areas";
import { PLAN_KEY, SEIS_CHANGE_KEY, SEIS_REACH_KEY, SEIS_SELECTED_KEY } from "../src/keys";
import { planModule } from "../src/modules/plan";
import { seismicModule } from "../src/modules/seismic";
import { currentOperation, operationPending } from "../src/plan/apply";
import { bindingOf, planStats } from "../src/plan/model";
import { planState } from "../src/plan/state";
import type { Runtime } from "../src/runtime";
import { SEISMIC_AREA, type SeismicRead } from "../src/seismic/read";
import { sampleAccess } from "./fixtures/access";
import { NOW, SAMPLE_SERVICES } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { groupEmail, sampleGroupMembers, sampleSeismic } from "./fixtures/seismic";
import { routeTransport, type SentRequest, seededRuntime } from "./harness";

const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const INGRID = oid(1);
const MARCUS = oid(4);
const LENA = oid(5);
const HIRO = oid(6);
const RACHEL = oid(11);
const BASE = 33;
const binding = bindingOf(SAMPLE_PROFILE);

const changeBoard = expectView(SEIS_CHANGE_KEY, "board");
const reachBoard = expectView(SEIS_REACH_KEY, "board");
const selectedBoard = expectView(SEIS_SELECTED_KEY, "board");
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
      [SERVICES_AREA]: SAMPLE_SERVICES,
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

describe("Grant or revoke", () => {
  test("three tabs that preview a plan, Grant open on the selected subproject", async () => {
    const { rt } = runtime();
    await act(rt, SEIS_SELECT_ACTION, { subproject: "delta" });
    const view = changeBoard(composeSeismicChange(rt)) as CanvasBoardView;
    const section = view.sections[0] as Extract<Section, { kind: "actions" }>;
    expect(section.tabs).toBe(true);
    expect(section.items.map((i) => [i.type, i.label])).toEqual([
      [PREVIEW_SEIS_GRANT_ACTION, "Grant"],
      [PREVIEW_SEIS_REVOKE_ACTION, "Revoke"],
      [PREVIEW_SEIS_COPY_ACTION, "Copy grants from person"],
    ]);
    const grant = section.items[0];
    expect(grant?.submitLabel).toBe("Preview plan");
    expect(grant?.binding).toEqual({ ...binding });
    expect(grant?.fields?.map((f) => f.name)).toEqual(["id", "subproject", "role"]);
    expect(grant?.fields?.[1]?.defaultValue).toBe("delta");
    expect(grant?.fields?.[2]).toMatchObject({ segmented: true, defaultValue: "viewer" });
    expect(section.items.every((i) => !i.disabled)).toBe(true);
  });

  test("hidden until the seismic store has been read", () => {
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW });
    expect(composeSeismicChange(rt).sections).toEqual([]);
    expect(composeSeismicReach(rt).sections).toEqual([]);
  });

  test("sign-in needed disables every form and the selected-subproject actions", async () => {
    const { rt } = runtime({ phase: "signin" });
    const view = changeBoard(composeSeismicChange(rt)) as CanvasBoardView;
    expect(view.header?.status).toEqual({ label: "sign-in needed", tone: "error" });
    expect(actionsOf(view).every((i) => i.disabled && i.reason === SIGNIN_REASON)).toBe(true);
    const selected = selectedBoard(composeSeismicSelected(rt)) as CanvasBoardView;
    expect(actionsOf(selected).every((i) => i.disabled && i.reason === SIGNIN_REASON)).toBe(true);
    expect(
      await act(rt, PREVIEW_SEIS_GRANT_ACTION, { id: LENA, subproject: "alpha", role: "viewer" }),
    ).toMatchObject({ ok: false });
  });

  test("a binding for another instance is refused", async () => {
    const { rt } = runtime();
    const res = await planModule.actions?.[PREVIEW_SEIS_GRANT_ACTION]?.(rt, {
      ...binding,
      host: "other.energy.azure.com",
      id: LENA,
      subproject: "alpha",
      role: "viewer",
    });
    expect(res).toMatchObject({ ok: false });
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

describe("What a partner can reach", () => {
  test("a viewer of alpha and delta reaches four paths, and the note says so", async () => {
    const { rt } = runtime();
    expect(await act(rt, SEIS_REACH_ACTION, { id: MARCUS })).toEqual({ ok: true });
    const view = reachBoard(composeSeismicReach(rt)) as CanvasBoardView;
    expect(view.header?.chip).toBe("Marcus Oyelaran · 4 paths");
    const rows = view.sections.find(
      (s): s is Extract<Section, { kind: "rows" }> => s.kind === "rows",
    );
    expect(rows?.title).toBe("Reachable paths · 4");
    expect(rows?.items.map((r) => [r.chip?.label, r.text, r.trailing])).toEqual([
      ["viewer", "sd://opendes/volve", "via data.default.viewers"],
      ["viewer", "sd://opendes/drogon", "via data.default.viewers"],
      ["viewer", "sd://opendes/alpha", "direct grant"],
      ["viewer", "sd://opendes/delta", "direct grant"],
    ]);
    const card = view.sections.find(
      (s): s is Extract<Section, { kind: "cards" }> => s.kind === "cards",
    )?.items[0];
    expect(card?.title).toBe("Send to Marcus Oyelaran");
    expect(card?.fields?.[0]).toMatchObject({ label: "Access note", copyable: true });
    expect(card?.fields?.[0]?.value).toBe(
      "You can read four seismic subprojects in tenant opendes on contoso-adme.energy.azure.com: sd://opendes/volve, sd://opendes/drogon, sd://opendes/alpha and sd://opendes/delta. Your role in each is viewer. Listing subprojects is admin only, so open them by path.",
    );
    const form = actionsOf(view)[0];
    expect(form).toMatchObject({ type: SEIS_REACH_ACTION, label: "Show reach", expanded: true });
    expect(form?.fields?.[0]?.defaultValue).toBe(MARCUS);
  });

  test("a person missing users@ is flagged, and an unknown person is refused", async () => {
    const { rt } = runtime();
    await act(rt, SEIS_REACH_ACTION, { id: RACHEL });
    const text = JSON.stringify(reachBoard(composeSeismicReach(rt)));
    expect(text).toContain("Rachel Kim is not in users@, so every call returns 401");
    expect(await act(rt, SEIS_REACH_ACTION, { id: "nobody" })).toMatchObject({ ok: false });
  });
});

describe("every seismic change frame passes its validator", () => {
  const states: [string, () => Promise<Runtime>][] = [
    ["measured", async () => runtime().rt],
    ["signin", async () => runtime({ phase: "signin" }).rt],
    [
      "reach shown",
      async () => {
        const { rt } = runtime();
        await act(rt, SEIS_REACH_ACTION, { id: INGRID });
        return rt;
      },
    ],
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
      changeBoard(composeSeismicChange(rt));
      reachBoard(composeSeismicReach(rt));
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

describe("grant seismic from the access tab", () => {
  test("the inspector and Change access offer own-ACL subprojects once the store is read", async () => {
    const { composeChange } = await import("../src/boards/change");
    const { composePerson } = await import("../src/boards/person");
    const { selectPerson } = await import("../src/access/person");
    const { rt } = runtime();
    const change = JSON.stringify(composeChange(rt));
    expect(change).toContain('"type":"preview-seismic-grant"');
    expect(change).toContain('"value":"alpha"');
    expect(change).not.toContain('"value":"volve"');
    selectPerson(rt, LENA);
    const person = JSON.stringify(composePerson(rt));
    expect(person).toContain('"type":"preview-seismic-grant"');
    const unread = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { now: NOW });
    expect(JSON.stringify(composeChange(unread))).toContain(
      "read the subprojects on the ADME Seismic tab first",
    );
  });
});
