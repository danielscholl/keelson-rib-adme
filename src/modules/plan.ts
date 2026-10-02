// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult } from "@keelson/shared";
import { measuredAccess } from "../boards/access.ts";
import {
  composeChange,
  PREVIEW_ADD_APP_ACTION,
  PREVIEW_ADD_PEOPLE_ACTION,
  PREVIEW_CLEANUP_ACTION,
  PREVIEW_FIX_ACTION,
  PREVIEW_REMOVE_ACTION,
  PREVIEW_RESEND_ACTION,
} from "../boards/change.ts";
import {
  CANCEL_OPERATION_ACTION,
  composeOperation,
  composeRecent,
  DISMISS_OPERATION_ACTION,
  RESUME_OPERATION_ACTION,
} from "../boards/operation.ts";
import {
  APPLY_PLAN_ACTION,
  composePlan,
  DISCARD_PLAN_ACTION,
  EXPORT_PLAN_ACTION,
  RECHECK_PLAN_ACTION,
} from "../boards/plan.ts";
import {
  measuredSeismic,
  PREVIEW_SEIS_COPY_ACTION,
  PREVIEW_SEIS_GRANT_ACTION,
  PREVIEW_SEIS_REVOKE_ACTION,
  PREVIEW_SEIS_SELF_ACTION,
} from "../boards/seismic.ts";
import { CHANGE_KEY, OPERATION_KEY, PLAN_KEY, RECENT_KEY } from "../keys.ts";
import { cancelApply, dismissOperation, resumeApply, startApply } from "../plan/apply.ts";
import { type PlanInputs, ROLE_KEYS } from "../plan/build.ts";
import { bindingOf, dryRunCsv, sameBinding } from "../plan/model.ts";
import { discardPlan, inputsOf, planState, startPlan } from "../plan/state.ts";
import type { RegionModule } from "../region.ts";
import type { Runtime } from "../runtime.ts";

type Payload = Record<string, unknown>;

function asPayload(payload: unknown): Payload {
  return payload && typeof payload === "object" ? (payload as Payload) : {};
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Every action that leads to a write carries the instance it was drawn for.
function bindingError(rt: Runtime, p: Payload): string | undefined {
  const profile = rt.profile;
  if (!profile) return "Not connected.";
  if (rt.status.phase !== "connected") return "Sign-in needed: run az login, then Re-test.";
  const drawn = {
    host: str(p, "host") ?? "",
    partition: str(p, "partition") ?? "",
    tenantId: str(p, "tenantId") ?? "",
  };
  if (!sameBinding(drawn, bindingOf(profile))) {
    return "This board was drawn for another instance. Refresh and try again.";
  }
  return undefined;
}

function openPlan(title: string): RibActionResult {
  return {
    ok: true,
    data: { effect: "open-canvas", key: PLAN_KEY, title: `Plan · ${title}`, placement: "side" },
  };
}

function preview(
  rt: Runtime,
  payload: unknown,
  toInputs: (p: Payload) => PlanInputs | string,
  title: (i: PlanInputs) => string,
) {
  const p = asPayload(payload);
  const refused = bindingError(rt, p);
  if (refused) return Promise.resolve<RibActionResult>({ ok: false, error: refused });
  const inputs = toInputs(p);
  if (typeof inputs === "string")
    return Promise.resolve<RibActionResult>({ ok: false, error: inputs });
  startPlan(rt, inputs, title(inputs));
  return Promise.resolve(openPlan(title(inputs)));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function personName(rt: Runtime, id: string): string {
  return measuredAccess(rt)?.model.people.find((x) => x.id === id)?.name ?? id;
}

function seismicInputs(
  rt: Runtime,
  p: Payload,
  kind: "seismic-grant" | "seismic-revoke",
): PlanInputs | string {
  if (!measuredSeismic(rt)) return "Read the seismic subprojects first.";
  const id = str(p, "id");
  const subproject = str(p, "subproject");
  const role = str(p, "role") ?? "viewer";
  if (!id) return "Pick a person.";
  if (!subproject) return "Pick a subproject.";
  if (role !== "viewer" && role !== "admin") return "Pick Viewer or Admin.";
  return { kind, id, subproject, role };
}

function seismicTitle(rt: Runtime, i: PlanInputs): string {
  if (i.kind === "seismic-copy") return `copy ${personName(rt, i.from)}'s grants`;
  if (i.kind === "seismic-grant" || i.kind === "seismic-revoke") {
    const verb = i.kind === "seismic-grant" ? "grant" : "revoke";
    return `${verb} ${personName(rt, i.id)} ${i.role} on ${i.subproject}`;
  }
  return i.kind;
}

function currentPlan(rt: Runtime, p: Payload) {
  const plan = planState(rt).plan;
  if (!plan || str(p, "planId") !== plan.id) return undefined;
  return plan;
}

export const planModule: RegionModule = {
  composers: {
    [CHANGE_KEY]: composeChange,
    [PLAN_KEY]: composePlan,
    [OPERATION_KEY]: composeOperation,
    [RECENT_KEY]: composeRecent,
  },
  actions: {
    [PREVIEW_ADD_PEOPLE_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          const emails = str(p, "emails");
          const role = str(p, "role") ?? "Editor";
          const cohort = str(p, "cohort");
          const passEnds = str(p, "passEnds");
          if (!emails) return "Enter at least one email address.";
          if (!ROLE_KEYS[role]) return "Pick Viewer, Editor or Admin.";
          if (passEnds && !DAY.test(passEnds)) return "Write the pass end as YYYY-MM-DD.";
          if (cohort && !rt.tracker.cohorts.some((c) => c.name === cohort))
            return "That cohort is not tracked.";
          return {
            kind: "add-people",
            emails,
            role,
            ...(cohort ? { cohort } : {}),
            ...(passEnds ? { passEnds } : {}),
          };
        },
        (i) =>
          i.kind === "add-people" ? `add people${i.cohort ? ` to ${i.cohort}` : ""}` : "add people",
      ),
    [PREVIEW_ADD_APP_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          const appId = str(p, "appId");
          const role = str(p, "role") ?? "Viewer";
          if (!appId || !/^[0-9a-f-]{36}$/i.test(appId))
            return "Enter the application (client) id, a GUID.";
          if (!ROLE_KEYS[role]) return "Pick Viewer, Editor or Admin.";
          return { kind: "add-app", appId, role };
        },
        () => "add an application",
      ),
    [PREVIEW_REMOVE_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          const id = str(p, "id");
          return id ? { kind: "remove-person", id } : "Pick a person.";
        },
        (i) => `remove ${personName(rt, (i as { id: string }).id)}`,
      ),
    [PREVIEW_FIX_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          const id = str(p, "id");
          return id ? { kind: "fix-users", id } : "Pick a person.";
        },
        (i) => `fix ${personName(rt, (i as { id: string }).id)}`,
      ),
    [PREVIEW_CLEANUP_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          const id = str(p, "id");
          return id ? { kind: "cleanup-duplicate", id } : "Pick a person.";
        },
        (i) => `clean up ${personName(rt, (i as { id: string }).id)}`,
      ),
    [PREVIEW_RESEND_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          const id = str(p, "id");
          return id ? { kind: "resend-invite", id } : "Pick a person.";
        },
        (i) => `resend ${personName(rt, (i as { id: string }).id)}'s invitation`,
      ),
    [PREVIEW_SEIS_GRANT_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => seismicInputs(rt, p, "seismic-grant"),
        (i) => seismicTitle(rt, i),
      ),
    [PREVIEW_SEIS_REVOKE_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => seismicInputs(rt, p, "seismic-revoke"),
        (i) => seismicTitle(rt, i),
      ),
    [PREVIEW_SEIS_SELF_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          const you = measuredAccess(rt)?.model.people.find((x) => x.you);
          if (!you) return "You are not in the last sweep. Refresh and try again.";
          return seismicInputs(rt, { ...p, id: you.id, role: "admin" }, "seismic-grant");
        },
        (i) => seismicTitle(rt, i),
      ),
    [PREVIEW_SEIS_COPY_ACTION]: (rt, payload) =>
      preview(
        rt,
        payload,
        (p) => {
          if (!measuredSeismic(rt)) return "Read the seismic subprojects first.";
          const from = str(p, "from");
          const to = str(p, "to");
          if (!from || !to) return "Pick both people.";
          if (from === to) return "Pick two different people.";
          return { kind: "seismic-copy", from, to };
        },
        (i) => seismicTitle(rt, i),
      ),
    [APPLY_PLAN_ACTION]: async (rt, payload) => {
      const p = asPayload(payload);
      const refused = bindingError(rt, p);
      if (refused) return { ok: false, error: refused };
      const plan = currentPlan(rt, p);
      if (!plan) return { ok: false, error: "That plan is no longer open." };
      const res = startApply(rt, plan);
      return res.ok ? { ok: true, data: { message: res.message } } : res;
    },
    [RESUME_OPERATION_ACTION]: async (rt) => {
      const res = resumeApply(rt);
      return res.ok ? { ok: true, data: { message: res.message } } : res;
    },
    [CANCEL_OPERATION_ACTION]: async (rt) => {
      const res = cancelApply(rt);
      return res.ok ? { ok: true, data: { message: res.message } } : res;
    },
    [DISMISS_OPERATION_ACTION]: async (rt) => {
      const res = dismissOperation(rt);
      return res.ok ? { ok: true, data: { message: res.message } } : res;
    },
    [RECHECK_PLAN_ACTION]: async (rt, payload) => {
      const p = asPayload(payload);
      const refused = bindingError(rt, p);
      if (refused) return { ok: false, error: refused };
      const plan = currentPlan(rt, p);
      if (!plan) return { ok: false, error: "That plan is no longer open." };
      startPlan(rt, inputsOf(plan), plan.title, plan);
      return { ok: true, data: { message: `Rechecking plan ${plan.id}` } };
    },
    [EXPORT_PLAN_ACTION]: async (rt, payload) => {
      const plan = currentPlan(rt, asPayload(payload));
      if (!plan) return { ok: false, error: "That plan is no longer open." };
      const path = rt.writeExport(`plan-${plan.id}-dry-run.csv`, dryRunCsv(plan));
      if (!path) return { ok: false, error: "The rib has no data directory to write to." };
      return { ok: true, data: { message: `Wrote ${path}` } };
    },
    [DISCARD_PLAN_ACTION]: async (rt, payload) => {
      const plan = currentPlan(rt, asPayload(payload));
      if (!plan) return { ok: false, error: "That plan is no longer open." };
      discardPlan(rt);
      return { ok: true, data: { message: `Discarded plan ${plan.id}` } };
    },
  },
};
