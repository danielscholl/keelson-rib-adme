// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { DATA_AREAS } from "../data/areas.ts";
import { FACETS_AREA, readFacets } from "../data/facets.ts";
import { CONSOLE_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";

export const dataModule: RegionModule = {
  areas: [...DATA_AREAS, { name: FACETS_AREA, keys: [CONSOLE_KEY], read: readFacets }],
};
