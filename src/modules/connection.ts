// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { composeConnection, RETEST_ACTION, SAVE_PROFILE_ACTION } from "../boards/connection.ts";
import { CONNECTION_KEY, DATA_PULSE_KEY, PULSE_KEY, SEIS_PULSE_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import { composeRestingHeader } from "../resting.ts";
import { REFRESH_ACTION } from "../surfaces.ts";

export const connectionModule: RegionModule = {
  composers: {
    [CONNECTION_KEY]: (rt) => composeConnection(rt.status),
    [PULSE_KEY]: (rt) =>
      composeRestingHeader(rt.status, {
        firstRunHere: true,
        connectedText: `Connected${rt.status.test?.signedInAs ? ` as ${rt.status.test.signedInAs}` : ""}.`,
      }),
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
