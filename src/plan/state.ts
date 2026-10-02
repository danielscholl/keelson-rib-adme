// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import { measuredAccess } from "../boards/access.ts";
import { measuredSeismic } from "../boards/seismic.ts";
import { PLAN_KEY, RECENT_KEY } from "../keys.ts";
import type { Runtime } from "../runtime.ts";
import { type BuildContext, buildPlan, type PlanInputs } from "./build.ts";
import type { Plan } from "./model.ts";

export interface PlanState {
  plan?: Plan;
  // Set while a dry run is being built; Preview returns before it finishes.
  building?: { title: string; startedAt: string };
  error?: string;
  // Set by Recheck when the new dry run differs from the plan it replaced.
  changedFrom?: { id: string; at: string };
  pending?: Promise<void>;
  // The plan id handed to the executor; the sheet stops offering Apply for it.
  appliedAs?: string;
}

const states = new WeakMap<Runtime, PlanState>();

export function planState(rt: Runtime): PlanState {
  let s = states.get(rt);
  if (!s) {
    s = {};
    states.set(rt, s);
  }
  return s;
}

export function buildContext(rt: Runtime): BuildContext | undefined {
  const profile = rt.profile;
  if (!profile) return undefined;
  return {
    profile,
    model: measuredAccess(rt)?.model,
    closures: rt.cache.get<AccessRead>(ACCESS_AREA).data?.closures,
    seismic: measuredSeismic(rt)?.model,
    now: rt.now(),
  };
}

export function inputsOf(plan: Plan): PlanInputs {
  return plan.inputs as unknown as PlanInputs;
}

// Starts the dry run and returns; the plan key recomposes when it lands.
export function startPlan(rt: Runtime, inputs: PlanInputs, title: string, replacing?: Plan): void {
  const s = planState(rt);
  s.building = { title, startedAt: rt.now().toISOString() };
  delete s.error;
  if (!replacing) {
    delete s.plan;
    delete s.changedFrom;
  }
  rt.recompose([PLAN_KEY]);
  s.pending = (async () => {
    const ctx = buildContext(rt);
    const res = ctx
      ? await rt.run((b) => buildPlan(b, inputs, ctx))
      : ({ ok: false, failure: { message: "not connected" } } as const);
    if (planState(rt) !== s) return;
    delete s.building;
    if (!res.ok) {
      s.error = res.failure.message;
    } else if (replacing && res.data.hash === replacing.hash) {
      s.plan = { ...replacing, expiresAt: res.data.expiresAt };
      delete s.changedFrom;
    } else {
      if (replacing) s.changedFrom = { id: replacing.id, at: replacing.createdAt };
      s.plan = res.data;
      const title = res.data.title;
      rt.tracker.record(
        [
          {
            kind: "dry run",
            plan: res.data.id,
            text: `${title.charAt(0).toUpperCase()}${title.slice(1)}`,
          },
        ],
        rt.now(),
      );
    }
    rt.recompose([PLAN_KEY, RECENT_KEY]);
  })();
}

export function discardPlan(rt: Runtime): void {
  states.set(rt, {});
  rt.recompose([PLAN_KEY]);
}
