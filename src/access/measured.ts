// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { directoryOf, labelOf } from "../directory/build.ts";
import type { Runtime } from "../runtime.ts";
import { type ActivityState, activityState, type Usage, usageOf } from "./activity.ts";
import { type AccessCounts, type AccessModel, buildAccess, countAccess } from "./model.ts";
import { ACCESS_AREA, type AccessRead } from "./read.ts";

export interface Measured {
  model: AccessModel;
  counts: AccessCounts;
  activity: ActivityState;
  // Each person's usage; undefined while the audit log is not measured.
  usage: Map<string, Usage | undefined>;
}

export function measuredAccess(rt: Runtime): Measured | undefined {
  const read = rt.cache.get<AccessRead>(ACCESS_AREA).data;
  if (!read || rt.status.phase === "firstrun" || rt.status.phase === "profile-error") {
    return undefined;
  }
  const directory = directoryOf(rt);
  const model = buildAccess(read, {
    signedInAs: rt.status.test?.signedInAs,
    admeAppId: rt.profile?.admeAppId,
    cohortOf: (email) => rt.tracker.cohortOf(email),
    labelOf: (id) => labelOf(directory, id),
  });
  const activity = activityState(rt, model);
  const known = activity.kind === "measured" ? activity.model : undefined;
  const now = rt.now();
  const usage = new Map(model.people.map((p) => [p.id, usageOf(p, known, now)] as const));
  return { model, counts: countAccess(model), activity, usage };
}

export function usageCount(m: Measured, u: Usage): number | null {
  if (u !== "invited" && m.activity.kind !== "measured") return null;
  return m.model.people.filter((p) => m.usage.get(p.id) === u).length;
}
