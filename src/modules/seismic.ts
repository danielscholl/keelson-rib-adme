// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult } from "@keelson/shared";
import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import { RETEST_ACTION, SIGNIN_REASON } from "../boards/connection.ts";
import {
  composeSeismicPulse,
  composeSeismicSelected,
  composeSeismicSubprojects,
  measuredSeismic,
  SEIS_READ_ACTION,
  SEIS_REFRESH_ACTION,
  SEIS_SELECT_ACTION,
  seismicState,
} from "../boards/seismic.ts";
import { PEOPLE_KEY, SEIS_PULSE_KEY, SEIS_SELECTED_KEY, SEIS_SUBPROJECTS_KEY } from "../keys.ts";
import type { ActionHandler, RegionModule } from "../region.ts";
import type { Runtime } from "../runtime.ts";
import { readSeismic, SEISMIC_AREA, SEISMIC_KEYS } from "../seismic/read.ts";
import { connectionModule } from "./connection.ts";

const inflight = new WeakMap<Runtime, Promise<RibActionResult>>();

function knownIds(read: AccessRead | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(read?.directory ?? {})) {
    ids.add(id);
    if (entry.appId) ids.add(entry.appId);
  }
  return ids;
}

// Tier 2: runs on Seismic tab actions and after Re-test, never on the sweep.
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

function used(rt: Runtime): boolean {
  const m = rt.cache.get(SEISMIC_AREA);
  return m.at !== undefined || m.errorAt !== undefined;
}

const retest = connectionModule.actions?.[RETEST_ACTION] as ActionHandler;

export const seismicModule: RegionModule = {
  composers: {
    [SEIS_PULSE_KEY]: composeSeismicPulse,
    [SEIS_SUBPROJECTS_KEY]: composeSeismicSubprojects,
    [SEIS_SELECTED_KEY]: composeSeismicSelected,
  },
  actions: {
    [SEIS_READ_ACTION]: (rt) => measureSeismic(rt),
    [SEIS_REFRESH_ACTION]: async (rt) => {
      const [, res] = await Promise.all([rt.sweep(), measureSeismic(rt)]);
      return res;
    },
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
      rt.recompose([SEIS_SUBPROJECTS_KEY, SEIS_SELECTED_KEY]);
      return { ok: true };
    },
    // Re-test sweeps tier 1; seismic follows only once the tab has been used.
    [RETEST_ACTION]: async (rt, payload) => {
      const res = await retest(rt, payload);
      if (res.ok && rt.status.phase === "connected" && used(rt)) await measureSeismic(rt);
      return res;
    },
  },
};
