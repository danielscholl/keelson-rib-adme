// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { AccessModel } from "../access/model.ts";
import type { Batch, CallResult } from "../client.ts";
import type { Profile } from "../profile.ts";
import type { SeismicModel } from "../seismic/model.ts";
import { bindingOf, finishPlan, numberSteps, type Plan } from "./model.ts";
import { type SeismicInputs, seismicPlan } from "./seismic.ts";

export interface BuildContext {
  profile: Profile;
  model: AccessModel | undefined;
  seismic?: SeismicModel | undefined;
  now: Date;
}

export type PlanInputs = SeismicInputs;

export async function buildPlan(
  batch: Batch,
  inputs: PlanInputs,
  ctx: BuildContext,
): Promise<CallResult<Plan>> {
  const draft = await seismicPlan(batch, inputs, {
    model: ctx.model,
    seismic: ctx.seismic,
    admeAppId: ctx.profile.admeAppId,
  });
  if (!draft.ok) return draft;
  const plan = finishPlan(
    {
      kind: inputs.kind,
      title: draft.data.title,
      binding: bindingOf(ctx.profile),
      inputs: { ...inputs },
      subjects: numberSteps(draft.data.subjects),
    },
    ctx.now,
  );
  return { ok: true, status: 200, data: plan };
}
