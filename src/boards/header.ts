// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { HEALTH_AREA, type Health, verdict } from "../data/health.ts";
import type { Runtime } from "../runtime.ts";
import {
  activeSection,
  SECTION_ACTION,
  SECTION_IDS,
  SECTION_LABELS,
  type SectionId,
} from "../section.ts";
import { connectionLine } from "./connection.ts";
import { healthChip } from "./health.ts";

type Section = CanvasBoardView["sections"][number];

export interface HeaderParts {
  pulses: Record<SectionId, (rt: Runtime) => CanvasBoardView>;
  counts: Partial<Record<SectionId, (rt: Runtime) => number>>;
}

function switcher(rt: Runtime, counts: HeaderParts["counts"]): Section {
  const active = activeSection(rt);
  const connected = rt.status.phase === "connected";
  return {
    kind: "actions",
    wrap: true,
    items: SECTION_IDS.map((id) => {
      const n = connected ? (counts[id]?.(rt) ?? 0) : 0;
      return {
        type: SECTION_ACTION,
        label: n > 0 ? `${SECTION_LABELS[id]} · ${n}` : SECTION_LABELS[id],
        payload: { section: id },
        selected: id === active,
      };
    }),
  };
}

// The section switcher, the connection line, then the active section's pulse.
// Before the rib connects, the connect journey stands in for every section's pulse.
export function composeHeader(rt: Runtime, parts: HeaderParts): CanvasBoardView {
  const phase = rt.status.phase;
  const unconnected = phase === "firstrun" || phase === "profile-error";
  const pulse = parts.pulses[unconnected ? "access" : activeSection(rt)](rt);
  const health = healthChip(verdict(rt.cache.get<Health>(HEALTH_AREA).data));
  const line = connectionLine(rt.status, health);
  return {
    ...pulse,
    sections: [switcher(rt, parts.counts), ...(line ? [line] : []), ...pulse.sections],
  };
}
