// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { HEADER_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import { composeRestingHeader, EMPTY_BOARD } from "../resting.ts";

// The connect journey before the rib connects and the sign-in card when it lapses;
// once connected the console says everything, so the header hides.
export const headerModule: RegionModule = {
  composers: {
    [HEADER_KEY]: (rt) =>
      rt.status.phase === "connected"
        ? EMPTY_BOARD
        : composeRestingHeader(rt.status, {
            firstRunHere: true,
            discovery: rt.discovery,
            connectedText: "Connected.",
          }),
  },
};
