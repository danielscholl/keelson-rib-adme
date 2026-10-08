// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult } from "@keelson/shared";
import { SURFACE_ID, surfaceTab } from "./keys.ts";
import type { Runtime } from "./runtime.ts";

export const SECTION_IDS = ["access", "data", "seismic"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_LABELS: Record<SectionId, string> = {
  access: "Access",
  data: "Data",
  seismic: "Seismic",
};

export const SECTION_ACTION = "open-section";

// In memory only: the rib opens on Access after a restart.
const state = new WeakMap<Runtime, SectionId>();

export function activeSection(rt: Runtime): SectionId {
  return state.get(rt) ?? "access";
}

export function setSection(rt: Runtime, section: SectionId): void {
  state.set(rt, section);
}

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);
}

// Shows the section first, so a jump never lands on a hidden region.
export function focusRegion(rt: Runtime, section: SectionId, regionKey: string): RibActionResult {
  if (activeSection(rt) !== section) {
    setSection(rt, section);
    rt.recomposeAll();
  }
  return {
    ok: true,
    data: { effect: "open-surface", surfaceId: surfaceTab(SURFACE_ID), regionKey },
  };
}
