// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { composeDataPulse, legalAttention } from "../boards/data-pulse.ts";
import { composeServices } from "../boards/services.ts";
import { DATA_AREAS, LEGAL_AREA, type LegalTags } from "../data/areas.ts";
import { BADGE_KEY, DATA_PULSE_KEY, SERVICES_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";

export const dataPulseModule: RegionModule = {
  areas: DATA_AREAS,
  composers: {
    [DATA_PULSE_KEY]: composeDataPulse,
    [SERVICES_KEY]: composeServices,
  },
  badges: {
    [BADGE_KEY]: (rt) => {
      const legal = rt.cache.get<LegalTags>(LEGAL_AREA).data;
      if (!legal) return 0;
      const { invalid, expiring } = legalAttention(legal, rt.now());
      return invalid + expiring;
    },
  },
};
