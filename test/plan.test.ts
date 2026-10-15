import { describe, expect, test } from "bun:test";
import { composePlan } from "../src/boards/plan";
import { PREVIEW_SEIS_GRANT_ACTION } from "../src/boards/seismic";
import { planModule } from "../src/modules/plan";
import { dryRunCsv, PLAN_TTL_MS } from "../src/plan/model";
import { planState } from "../src/plan/state";
import type { Runtime } from "../src/runtime";
import { NOW } from "./fixtures/data";
import { groupEmail } from "./fixtures/seismic";
import { act, binding, oid, plan, seismicRuntime as runtime } from "./fixtures/seismic-world";
import { seededRuntime } from "./harness";

const LENA = oid(5);

const grantLena = (rt: Runtime, subproject = "alpha") =>
  plan(rt, PREVIEW_SEIS_GRANT_ACTION, { id: LENA, subproject, role: "viewer" });

describe("preview", () => {
  test("a board drawn for another instance is refused", async () => {
    const { rt } = runtime();
    const res = await planModule.actions?.[PREVIEW_SEIS_GRANT_ACTION]?.(rt, {
      ...binding,
      host: "other.example",
      id: LENA,
      subproject: "alpha",
      role: "viewer",
    });
    expect(res).toMatchObject({ ok: false });
    expect(planState(rt).plan).toBeUndefined();
  });

  test("a role other than viewer or admin is refused", async () => {
    const { rt } = runtime();
    expect(
      await act(rt, PREVIEW_SEIS_GRANT_ACTION, { id: LENA, subproject: "alpha", role: "owner" }),
    ).toMatchObject({ ok: false });
  });
});

describe("recheck and expiry", () => {
  test("a recheck that finds the same world keeps the plan id", async () => {
    const { rt } = runtime();
    const first = await grantLena(rt);
    await act(rt, "recheck-plan", { planId: first.id });
    expect(planState(rt).plan?.id).toBe(first.id);
    expect(planState(rt).changedFrom).toBeUndefined();
  });

  test("a recheck that finds a changed world makes a new plan and says so", async () => {
    const { rt, held } = runtime();
    const first = await grantLena(rt);
    held.set(LENA, new Set([groupEmail("alpha", "viewer")]));
    await act(rt, "recheck-plan", { planId: first.id });
    const second = planState(rt).plan!;
    expect(second.hash).not.toBe(first.hash);
    expect(planState(rt).changedFrom?.id).toBe(first.id);
    expect(JSON.stringify(composePlan(rt))).toContain(`The dry run changed since plan ${first.id}`);
  });

  test("an expired plan says so and cannot be applied", async () => {
    const { rt } = runtime();
    await grantLena(rt);
    const later = seededRuntime({}, { now: new Date(NOW.getTime() + PLAN_TTL_MS + 1) });
    Object.assign(planState(later), planState(rt));
    const text = JSON.stringify(composePlan(later));
    expect(text).toContain("expired · nothing changed");
    expect(text).toContain("the plan expired; Recheck to refresh it");
  });
});

describe("dry run export", () => {
  test("the dry run CSV has one line per step", async () => {
    const { rt } = runtime();
    const lines = dryRunCsv(await grantLena(rt))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1 + 2);
    expect(lines[1]).toContain(`POST entitlements /groups/`);
  });

  test("a blocked subject is one line with its reason", async () => {
    const { rt } = runtime();
    const lines = dryRunCsv(await grantLena(rt, "volve"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',yes,"volve viewers come through data.default.viewers.');
  });
});

describe("plan sheet resting", () => {
  test("after a discard the drawer says no plan is open instead of going blank", async () => {
    const { rt } = runtime();
    const p = await grantLena(rt);
    expect(await act(rt, "discard-plan", { planId: p.id })).toMatchObject({ ok: true });
    expect(JSON.stringify(composePlan(rt))).toContain("No plan is open");
  });
});
