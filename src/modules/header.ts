// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { composeAccessPulse } from "../boards/access.ts";
import { composeDataPulse } from "../boards/data-pulse.ts";
import { composeHeader, type HeaderParts } from "../boards/header.ts";
import { composeSeismicPulse } from "../boards/seismic.ts";
import { HEADER_KEY, SURFACE_ID, surfaceTab } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import { activeSection, isSectionId, SECTION_ACTION, setSection } from "../section.ts";
import { accessModule } from "./access.ts";
import { dataPulseModule } from "./data.ts";

const PARTS: HeaderParts = {
  pulses: { access: composeAccessPulse, data: composeDataPulse, seismic: composeSeismicPulse },
  counts: { ...accessModule.counts, ...dataPulseModule.counts },
};

export const headerModule: RegionModule = {
  composers: {
    [HEADER_KEY]: (rt) => composeHeader(rt, PARTS),
  },
  actions: {
    [SECTION_ACTION]: async (rt, payload) => {
      const section = (payload as { section?: unknown } | undefined)?.section;
      if (!isSectionId(section)) return { ok: false, error: "Pick Access, Data or Seismic." };
      if (activeSection(rt) !== section) {
        setSection(rt, section);
        rt.recomposeAll();
      }
      // A handled effect suppresses the success toast a plain switch would raise.
      return { ok: true, data: { effect: "open-surface", surfaceId: surfaceTab(SURFACE_ID) } };
    },
  },
};
