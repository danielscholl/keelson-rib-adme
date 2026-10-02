// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { ACCESS_AREAS } from "../access/read.ts";
import {
  composeAccessPulse,
  composeAttention,
  composePeople,
  composePrincipals,
  measuredAccess,
} from "../boards/access.ts";
import { ACCESS_BADGE_KEY, ATTENTION_KEY, PEOPLE_KEY, PRINCIPALS_KEY, PULSE_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";

export const accessModule: RegionModule = {
  areas: ACCESS_AREAS,
  composers: {
    [PULSE_KEY]: composeAccessPulse,
    [ATTENTION_KEY]: composeAttention,
    [PEOPLE_KEY]: composePeople,
    [PRINCIPALS_KEY]: composePrincipals,
  },
  badges: {
    [ACCESS_BADGE_KEY]: (rt) => measuredAccess(rt)?.counts.needsYou ?? 0,
  },
};
