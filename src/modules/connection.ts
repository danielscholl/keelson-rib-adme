// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  CONNECT_ACTION,
  composeConnection,
  DISCOVER_ACTION,
  RETEST_ACTION,
  SAVE_PROFILE_ACTION,
  USE_ROSTER_ACTION,
} from "../boards/connection.ts";
import { CONNECTION_KEY, DATA_PULSE_KEY, SEIS_PULSE_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import { composeRestingHeader } from "../resting.ts";
import { REFRESH_ACTION } from "../surfaces.ts";

export const connectionModule: RegionModule = {
  composers: {
    [CONNECTION_KEY]: (rt) => composeConnection(rt.status),
    [DATA_PULSE_KEY]: (rt) => composeRestingHeader(rt.status, { connectedText: "Connected." }),
    [SEIS_PULSE_KEY]: (rt) => composeRestingHeader(rt.status, { connectedText: "Connected." }),
  },
  actions: {
    [SAVE_PROFILE_ACTION]: async (rt, payload) => {
      const res = await rt.saveProfile(payload ?? {});
      if (!res.ok) return res;
      const message =
        rt.status.phase === "connected" ? "Connection works" : "Tested; see the Connection footer";
      return { ok: true, data: { message } };
    },
    [DISCOVER_ACTION]: async (rt) => {
      await rt.discover();
      return { ok: true };
    },
    [CONNECT_ACTION]: async (rt, payload) => {
      const { instance, partition } = (payload ?? {}) as {
        instance?: unknown;
        partition?: unknown;
      };
      if (typeof instance !== "string" || typeof partition !== "string") {
        return { ok: false, error: "Pick an instance from the list." };
      }
      const res = await rt.connectInstance(instance, partition);
      if (!res.ok) return res;
      const message =
        rt.status.phase === "connected" ? "Connection works" : "Tested; see the Connection footer";
      return { ok: true, data: { message } };
    },
    [USE_ROSTER_ACTION]: async (rt, payload) =>
      rt.useSuggestedRosterGroup((payload as { id?: unknown } | undefined)?.id),
    [RETEST_ACTION]: async (rt) => {
      await rt.testConnection();
      return { ok: true };
    },
    [REFRESH_ACTION]: async (rt) => {
      await rt.sweep();
      return { ok: true };
    },
  },
};
