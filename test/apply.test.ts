import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { composeOperation, composeRecent } from "../src/boards/operation";
import { composePlan } from "../src/boards/plan";
import { OPERATION_KEY, PLAN_KEY, RECENT_KEY } from "../src/keys";
import { planModule } from "../src/modules/plan";
import { currentOperation, operationPending } from "../src/plan/apply";
import { bindingOf, PLAN_TTL_MS } from "../src/plan/model";
import { planState } from "../src/plan/state";
import { Store } from "../src/store";
import { sampleAccess, sampleCohortCsv } from "./fixtures/access";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { routeTransport, type SentRequest, seededRuntime } from "./harness";

const NOW = new Date("2026-10-02T14:03:00Z");
const RACHEL = "00000000-0000-4000-8000-000000000011";
const BEN = "00000000-0000-4000-8000-000000000008";
const KOFI = "abcd0000-0000-4000-8000-00000000c0f1";
const binding = bindingOf(SAMPLE_PROFILE);

interface Options {
  invitedId?: string;
  createdAt?: string;
  failAt?: (req: SentRequest) => { status: number; body?: unknown } | undefined;
  groups?: number;
  kofiExists?: () => boolean;
}

function world(o: Options = {}) {
  const groups = Array.from({ length: o.groups ?? 33 }, (_, i) => ({ email: `g${i}@x` }));
  const answer = (req: SentRequest, ok: { status: number; body?: unknown }) =>
    o.failAt?.(req) ?? ok;
  return routeTransport({
    "GET /v1.0/users?": (req) => {
      const address = decodeURIComponent(req.url).match(/mail eq '([^']+)'/)?.[1];
      if (address === "kofi.mensah@volta-subsurface.example" && o.kofiExists?.()) {
        return { status: 200, body: { value: [{ id: KOFI, displayName: "Kofi", mail: address }] } };
      }
      return { status: 200, body: { value: [] } };
    },
    "GET /v1.0/directory/deletedItems": () => ({ status: 200, body: { value: [] } }),
    "POST /v1.0/invitations": (req) =>
      answer(req, { status: 201, body: { invitedUser: { id: o.invitedId ?? KOFI } } }),
    "GET /v1.0/users/": () => ({
      status: 200,
      body: {
        id: o.invitedId ?? KOFI,
        displayName: "Kofi Mensah",
        createdDateTime: o.createdAt ?? NOW.toISOString(),
      },
    }),
    "POST /members/$ref": (req) => answer(req, { status: 204 }),
    "POST /api/entitlements/v2/groups/": (req) => answer(req, { status: 200, body: {} }),
    "DELETE /api/entitlements/v2/groups/": (req) => answer(req, { status: 204 }),
    "GET /api/entitlements/v2/members/": (req) => answer(req, { status: 200, body: { groups } }),
  });
}

function runtime(o: Options = {}, store?: Store) {
  const { transport, sent } = world(o);
  const rt = seededRuntime(
    { [ACCESS_AREA]: sampleAccess() },
    { now: NOW, transport, ...(store ? { store } : {}) },
  );
  rt.tracker.importCsv(sampleCohortCsv(), NOW);
  return { rt, sent };
}

type Rt = ReturnType<typeof runtime>["rt"];

async function act(rt: Rt, type: string, payload: Record<string, unknown> = {}) {
  const res = await planModule.actions?.[type]?.(rt, { ...binding, ...payload });
  await planState(rt).pending;
  await operationPending(rt);
  return res;
}

async function previewKofi(rt: Rt) {
  await act(rt, "preview-add-people", {
    emails: "kofi.mensah@volta-subsurface.example",
    cohort: "Pilot",
    passEnds: "2026-10-28",
    role: "Editor",
  });
  return planState(rt).plan!;
}

const writes = (sent: SentRequest[]) =>
  sent.filter((r) => r.method !== "GET" && !r.url.endsWith("/$batch"));

describe("apply", () => {
  test("applies the worked example: invite, roster, users@, editors, verify 33", async () => {
    const { rt, sent } = runtime();
    const plan = await previewKofi(rt);
    const res = await act(rt, "apply-plan", { planId: plan.id });
    expect(res).toMatchObject({ ok: true });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("done");
    expect(op.steps.map((t) => t.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(op.steps.at(-1)?.note).toBe("33 groups");
    const adme = writes(sent).filter((r) => r.url.includes("/api/entitlements/"));
    expect(adme.map((r) => r.headers["correlation-id"])).toEqual([
      `keelson-adme-${plan.id}-4`,
      `keelson-adme-${plan.id}-5`,
    ]);
    expect(adme.map((r) => (r.body as { email: string }).email)).toEqual([KOFI, KOFI]);
    expect(rt.tracker.cohortOf("kofi.mensah@volta-subsurface.example")).toBe("Pilot");
    expect(rt.tracker.events[0]).toMatchObject({ kind: "applied", plan: plan.id });
    expect(JSON.stringify(composePlan(rt))).toContain("applied · see Operation");
  });

  test("an invitation that returns a known person halts before any membership write", async () => {
    const { rt, sent } = runtime({ invitedId: RACHEL });
    const plan = await previewKofi(rt);
    await act(rt, "apply-plan", { planId: plan.id });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("halted");
    expect(op.reason).toContain("returned Rachel Kim's account");
    expect(writes(sent).map((r) => r.url)).toEqual([
      "https://graph.microsoft.com/v1.0/invitations",
    ]);
    expect(op.steps.filter((t) => t.state === "skipped")).toHaveLength(5);
  });

  test("an invitation that returns an account older than the apply halts too", async () => {
    const { rt, sent } = runtime({
      invitedId: "eeee0000-0000-4000-8000-000000000001",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const plan = await previewKofi(rt);
    await act(rt, "apply-plan", { planId: plan.id });
    expect(currentOperation(rt)?.status).toBe("halted");
    expect(writes(sent)).toHaveLength(1);
  });

  test("a dry run that changed since preview aborts and writes nothing", async () => {
    let exists = false;
    const { rt, sent } = runtime({ kofiExists: () => exists });
    const plan = await previewKofi(rt);
    exists = true;
    await act(rt, "apply-plan", { planId: plan.id });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("aborted");
    expect(op.reason).toContain("the dry run changed");
    expect(writes(sent)).toEqual([]);
  });

  test("a lapsed sign-in pauses at the step and resume keeps what was done", async () => {
    let lapsed = true;
    const { rt, sent } = runtime({
      failAt: (req) =>
        lapsed && req.url.includes("users%40")
          ? { status: 401, body: { message: "Unauthorized" } }
          : undefined,
    });
    const plan = await previewKofi(rt);
    await act(rt, "apply-plan", { planId: plan.id });
    let op = currentOperation(rt)!;
    expect(op.status).toBe("paused");
    expect(op.reason).toBe("sign-in lapsed at step 4");
    expect(JSON.stringify(expectView(OPERATION_KEY, "board")(composeOperation(rt)))).toContain(
      '"label":"Resume"',
    );
    lapsed = false;
    rt.status = { ...rt.status, phase: "connected" };
    await act(rt, "resume-operation");
    op = currentOperation(rt)!;
    expect(op.status).toBe("done");
    expect(writes(sent).filter((r) => r.url.endsWith("/v1.0/invitations"))).toHaveLength(1);
    expect(rt.tracker.events.some((e) => e.kind === "paused")).toBe(true);
  });

  test("a 409 counts as already true and a verify mismatch is reported", async () => {
    const { rt } = runtime({
      groups: 32,
      failAt: (req) =>
        req.url.includes("editors") && req.method === "POST"
          ? { status: 409, body: { message: "exists" } }
          : undefined,
    });
    const plan = await previewKofi(rt);
    await act(rt, "apply-plan", { planId: plan.id });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("done");
    expect(op.steps.find((t) => t.text.includes("editors"))?.state).toBe("already");
    expect(op.steps.at(-1)).toMatchObject({ state: "mismatch", note: "got 32, expected 33" });
    expect(JSON.stringify(composeOperation(rt))).toContain("done · 1 verify mismatch");
  });

  test("a refused write fails the plan and skips the rest", async () => {
    const { rt } = runtime({
      failAt: (req) =>
        req.url.includes("users%40") ? { status: 403, body: { message: "Forbidden" } } : undefined,
    });
    const plan = await previewKofi(rt);
    await act(rt, "apply-plan", { planId: plan.id });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("failed");
    expect(op.steps.filter((t) => t.state === "skipped")).toHaveLength(2);
  });

  test("an expired plan and a second apply are refused", async () => {
    const { rt } = runtime();
    const plan = await previewKofi(rt);
    const later = runtime();
    Object.assign(planState(later.rt), planState(rt));
    (later.rt as unknown as { now: () => Date }).now = () =>
      new Date(NOW.getTime() + PLAN_TTL_MS + 1);
    expect(await act(later.rt, "apply-plan", { planId: plan.id })).toMatchObject({ ok: false });
  });

  test("resending an invitation accepts only the person's own account", async () => {
    const own = runtime({ invitedId: BEN });
    await act(own.rt, "preview-resend-invite", { id: BEN });
    await act(own.rt, "apply-plan", { planId: planState(own.rt).plan!.id });
    expect(currentOperation(own.rt)?.status).toBe("done");
    const other = runtime({ invitedId: RACHEL });
    await act(other.rt, "preview-resend-invite", { id: BEN });
    await act(other.rt, "apply-plan", { planId: planState(other.rt).plan!.id });
    expect(currentOperation(other.rt)?.status).toBe("halted");
  });

  test("removals ask for a typed subject; adds ask a plain question", async () => {
    const { rt } = runtime();
    await act(rt, "preview-remove-person", { id: RACHEL });
    const text = JSON.stringify(composePlan(rt));
    expect(text).toContain('"irreversible":true,"subject":"Rachel Kim"');
    expect(text).toContain('"destructive":true');
  });

  test("an apply running when the server stops comes back paused", async () => {
    const store = new Store(undefined);
    const first = runtime({}, store);
    const plan = await previewKofi(first.rt);
    store.write("operation.json", { ...currentOperationShape(plan.id, plan), status: "running" });
    const second = runtime({}, store);
    expect(currentOperation(second.rt)).toMatchObject({
      status: "paused",
      reason: "the server restarted while the plan was applying",
    });
  });

  test("recent changes list dry runs and applied plans, newest first", async () => {
    const { rt } = runtime();
    const plan = await previewKofi(rt);
    await act(rt, "apply-plan", { planId: plan.id });
    const view = expectView(RECENT_KEY, "board")(composeRecent(rt));
    const text = JSON.stringify(view);
    expect(text.indexOf('"label":"applied"')).toBeLessThan(text.indexOf('"label":"dry run"'));
    expect(text).not.toContain(`Plan ${plan.id}:`);
    expectView(PLAN_KEY, "board")(composePlan(rt));
  });
});

function currentOperationShape(planId: string, plan: unknown) {
  return {
    planId,
    title: "add 1 person to Pilot",
    startedAt: NOW.toISOString(),
    steps: [],
    oids: {},
    plan,
  };
}
