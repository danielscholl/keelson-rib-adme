// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult } from "@keelson/shared";
import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import { measuredAccess } from "../boards/access.ts";
import { SIGNIN_REASON } from "../boards/connection.ts";
import {
  composeSeismicPulse,
  composeSeismicSelected,
  composeSeismicSubprojects,
  measuredSeismic,
  SEIS_REACH_ACTION,
  SEIS_READ_ACTION,
  SEIS_SELECT_ACTION,
  seismicState,
} from "../boards/seismic.ts";
import { composeSeismicChange, composeSeismicReach } from "../boards/seismic-change.ts";
import {
  PEOPLE_KEY,
  SEIS_CHANGE_KEY,
  SEIS_PULSE_KEY,
  SEIS_REACH_KEY,
  SEIS_SELECTED_KEY,
  SEIS_SUBPROJECTS_KEY,
} from "../keys.ts";
import type { RegionModule } from "../region.ts";
import type { Area, Runtime } from "../runtime.ts";
import { focusRegion } from "../section.ts";
import { readSeismic, SEISMIC_AREA, SEISMIC_EVERY_MS, SEISMIC_KEYS } from "../seismic/read.ts";

const inflight = new WeakMap<Runtime, Promise<RibActionResult>>();

function knownIds(read: AccessRead | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(read?.directory ?? {})) {
    ids.add(id);
    if (entry.appId) ids.add(entry.appId);
  }
  return ids;
}

// Membership is a sweep area of its own, read at most every 30 minutes; the
// subproject actions and Re-test read it again on demand.
const SEISMIC_SWEEP: Area = {
  name: SEISMIC_AREA,
  keys: [...SEISMIC_KEYS, PEOPLE_KEY],
  everyMs: SEISMIC_EVERY_MS,
  read: (batch, rt) => readSeismic(batch, knownIds(rt.cache.get<AccessRead>(ACCESS_AREA).data)),
};

export function measureSeismic(rt: Runtime): Promise<RibActionResult> {
  const pending = inflight.get(rt);
  if (pending) return pending;
  const work = (async (): Promise<RibActionResult> => {
    const known = knownIds(rt.cache.get<AccessRead>(ACCESS_AREA).data);
    const res = await rt.run((b) => readSeismic(b, known));
    if (res.ok) {
      rt.cache.succeed(SEISMIC_AREA, res.data, rt.now());
      rt.recompose([...SEISMIC_KEYS, PEOPLE_KEY]);
      return { ok: true };
    }
    if (res.failure.kind === "signin" && res.failure.status === null) {
      return { ok: false, error: SIGNIN_REASON };
    }
    rt.cache.fail(SEISMIC_AREA, res.failure.message, rt.now());
    rt.recompose([...SEISMIC_KEYS, PEOPLE_KEY]);
    return { ok: false, error: res.failure.message };
  })().finally(() => inflight.delete(rt));
  inflight.set(rt, work);
  return work;
}

// A handled effect suppresses the success toast a plain selection would raise.
function focus(rt: Runtime, regionKey: string): RibActionResult {
  return focusRegion(rt, "seismic", regionKey);
}

export const seismicModule: RegionModule = {
  areas: [SEISMIC_SWEEP],
  composers: {
    [SEIS_PULSE_KEY]: composeSeismicPulse,
    [SEIS_SUBPROJECTS_KEY]: composeSeismicSubprojects,
    [SEIS_SELECTED_KEY]: composeSeismicSelected,
    [SEIS_CHANGE_KEY]: composeSeismicChange,
    [SEIS_REACH_KEY]: composeSeismicReach,
  },
  actions: {
    [SEIS_READ_ACTION]: (rt) => measureSeismic(rt),
    [SEIS_SELECT_ACTION]: async (rt, payload) => {
      const name = (payload as { subproject?: unknown } | undefined)?.subproject;
      if (typeof name !== "string") return { ok: false, error: "Pick a subproject." };
      if (!measuredSeismic(rt)) {
        const res = await measureSeismic(rt);
        if (!res.ok) return res;
      }
      const measured = measuredSeismic(rt);
      if (!measured?.model.subprojects.some((s) => s.name === name)) {
        return { ok: false, error: "That subproject is no longer listed. Refresh now." };
      }
      seismicState(rt).selected = name;
      rt.recompose([SEIS_SUBPROJECTS_KEY, SEIS_SELECTED_KEY, SEIS_CHANGE_KEY]);
      return focus(rt, SEIS_SELECTED_KEY);
    },
    [SEIS_REACH_ACTION]: async (rt, payload) => {
      const id = (payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id) return { ok: false, error: "Pick a person." };
      if (!measuredAccess(rt)?.model.people.some((p) => p.id === id)) {
        return { ok: false, error: "That person is not in the last sweep. Refresh and try again." };
      }
      seismicState(rt).reach = id;
      rt.recompose([SEIS_REACH_KEY]);
      return focus(rt, SEIS_REACH_KEY);
    },
  },
};
