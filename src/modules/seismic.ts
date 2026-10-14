// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult } from "@keelson/shared";
import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import { SIGNIN_REASON } from "../boards/connection.ts";
import {
  measuredSeismic,
  SEIS_READ_ACTION,
  SEIS_SELECT_ACTION,
  seismicState,
} from "../boards/seismic.ts";
import { INSPECT_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import type { Area, Runtime } from "../runtime.ts";
import { readSeismic, SEISMIC_AREA, SEISMIC_EVERY_MS, SEISMIC_KEYS } from "../seismic/read.ts";
import { inspectState } from "./console.ts";

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
  keys: SEISMIC_KEYS,
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
      rt.recompose(SEISMIC_KEYS);
      return { ok: true };
    }
    if (res.failure.kind === "signin" && res.failure.status === null) {
      return { ok: false, error: SIGNIN_REASON };
    }
    rt.cache.fail(SEISMIC_AREA, res.failure.message, rt.now());
    rt.recompose(SEISMIC_KEYS);
    return { ok: false, error: res.failure.message };
  })().finally(() => inflight.delete(rt));
  inflight.set(rt, work);
  return work;
}

export const seismicModule: RegionModule = {
  areas: [SEISMIC_SWEEP],
  actions: {
    [SEIS_READ_ACTION]: (rt) => measureSeismic(rt),
    // Opens a subproject in the inspector, from its member rows and the flow.
    [SEIS_SELECT_ACTION]: async (rt, payload) => {
      const name = (payload as { subproject?: unknown } | undefined)?.subproject;
      if (typeof name !== "string") return { ok: false, error: "Pick a subproject." };
      if (!measuredSeismic(rt)?.model.subprojects.some((s) => s.name === name)) {
        return { ok: false, error: "That subproject is no longer listed. Refresh now." };
      }
      seismicState(rt).selected = name;
      inspectState(rt).selected = `sub:${name}`;
      await rt.recomposeNow(INSPECT_KEY);
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: INSPECT_KEY,
          title: `Subproject · ${name}`,
          placement: "side",
        },
      };
    },
  },
};
