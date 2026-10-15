import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { composeOperation, composeRecent } from "../src/boards/operation";
import { composePlan } from "../src/boards/plan";
import { PREVIEW_SEIS_GRANT_ACTION } from "../src/boards/seismic";
import { OPERATION_KEY, PLAN_KEY, RECENT_KEY } from "../src/keys";
import { currentOperation } from "../src/plan/apply";
import { PLAN_TTL_MS } from "../src/plan/model";
import { planState } from "../src/plan/state";
import type { Runtime } from "../src/runtime";
import { Store } from "../src/store";
import { NOW } from "./fixtures/data";
import { groupEmail } from "./fixtures/seismic";
import { act, BASE, oid, plan, seismicRuntime as runtime, writes } from "./fixtures/seismic-world";
import type { SentRequest } from "./harness";

const LENA = oid(5);
const ALPHA_VIEWER = groupEmail("alpha", "viewer");

const grantLena = (rt: Runtime) =>
  plan(rt, PREVIEW_SEIS_GRANT_ACTION, { id: LENA, subproject: "alpha", role: "viewer" });

const onWrite = (answer: { status: number; body?: unknown }) => (req: SentRequest) =>
  req.method === "POST" ? answer : undefined;

describe("apply", () => {
  test("applies a grant, verifies the count and records it", async () => {
    const { rt, held } = runtime();
    const p = await grantLena(rt);
    expect(await act(rt, "apply-plan", { planId: p.id })).toMatchObject({ ok: true });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("done");
    expect(op.steps.map((t) => t.state)).toEqual(["done", "done", "done"]);
    expect(held.get(LENA)?.has(ALPHA_VIEWER)).toBe(true);
    expect(rt.tracker.events[0]).toMatchObject({ kind: "applied", plan: p.id });
    expect(JSON.stringify(composePlan(rt))).toContain("applied · see Operation");
  });

  test("a lapsed sign-in pauses at the step and resume keeps what was done", async () => {
    let lapsed = true;
    const { rt, held } = runtime({
      failAt: (req) =>
        lapsed && req.method === "POST"
          ? { status: 401, body: { message: "Unauthorized" } }
          : undefined,
    });
    const p = await grantLena(rt);
    await act(rt, "apply-plan", { planId: p.id });
    let op = currentOperation(rt)!;
    expect(op.status).toBe("paused");
    expect(op.reason).toBe("sign-in lapsed at step 1");
    expect(op.steps[0]?.state).toBe("done");
    expect(JSON.stringify(expectView(OPERATION_KEY, "board")(composeOperation(rt)))).toContain(
      '"label":"Resume"',
    );
    lapsed = false;
    rt.status = { ...rt.status, phase: "connected" };
    await act(rt, "resume-operation");
    op = currentOperation(rt)!;
    expect(op.status).toBe("done");
    expect(held.get(LENA)?.has(ALPHA_VIEWER)).toBe(true);
    expect(rt.tracker.events.some((e) => e.kind === "paused")).toBe(true);
  });

  test("a 409 counts as already true and a verify mismatch is reported", async () => {
    const { rt } = runtime({ failAt: onWrite({ status: 409, body: { message: "exists" } }) });
    const p = await grantLena(rt);
    await act(rt, "apply-plan", { planId: p.id });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("done");
    expect(op.steps[1]).toMatchObject({ state: "already", note: "409, already true" });
    expect(op.steps.at(-1)).toMatchObject({
      state: "mismatch",
      note: `got ${BASE}, expected ${BASE + 1}`,
    });
    expect(JSON.stringify(composeOperation(rt))).toContain("done · 1 verify mismatch");
  });

  test("a refused write fails the plan and skips the rest", async () => {
    const { rt, sent } = runtime({
      failAt: onWrite({ status: 403, body: { message: "Forbidden" } }),
    });
    const p = await grantLena(rt);
    await act(rt, "apply-plan", { planId: p.id });
    const op = currentOperation(rt)!;
    expect(op.status).toBe("failed");
    expect(op.steps.filter((t) => t.state === "skipped")).toHaveLength(1);
    expect(writes(sent)).toHaveLength(1);
  });

  test("an expired plan is refused", async () => {
    const { rt } = runtime();
    const p = await grantLena(rt);
    const later = runtime();
    Object.assign(planState(later.rt), planState(rt));
    (later.rt as unknown as { now: () => Date }).now = () =>
      new Date(NOW.getTime() + PLAN_TTL_MS + 1);
    expect(await act(later.rt, "apply-plan", { planId: p.id })).toMatchObject({ ok: false });
  });

  test("an apply running when the server stops comes back paused", async () => {
    const store = new Store(undefined);
    const first = runtime({ store });
    const p = await grantLena(first.rt);
    store.write("operation.json", {
      planId: p.id,
      title: p.title,
      status: "running",
      startedAt: NOW.toISOString(),
      steps: [],
      plan: p,
    });
    const second = runtime({ store });
    expect(currentOperation(second.rt)).toMatchObject({
      status: "paused",
      reason: "the server restarted while the plan was applying",
    });
  });

  test("recent changes list dry runs and applied plans, newest first", async () => {
    const { rt } = runtime();
    const p = await grantLena(rt);
    await act(rt, "apply-plan", { planId: p.id });
    const text = JSON.stringify(expectView(RECENT_KEY, "board")(composeRecent(rt)));
    expect(text.indexOf('"label":"applied"')).toBeLessThan(text.indexOf('"label":"dry run"'));
    expect(text).not.toContain(`Plan ${p.id}:`);
    expectView(PLAN_KEY, "board")(composePlan(rt));
  });
});
