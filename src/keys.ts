// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export const RIB_ID = "adme";

// The one surface's header: section switcher, connection and the section's pulse.
export const HEADER_KEY = "rib:adme:header";

// Access section
export const PULSE_KEY = "rib:adme:pulse";
export const ATTENTION_KEY = "rib:adme:attention";
export const ACTIVITY_KEY = "rib:adme:activity";
export const ORGS_KEY = "rib:adme:orgs";
export const CHANGE_KEY = "rib:adme:change";
export const OPERATION_KEY = "rib:adme:operation";
export const RECENT_KEY = "rib:adme:recent";
export const PEOPLE_KEY = "rib:adme:people";
export const COHORTS_KEY = "rib:adme:cohorts";
export const PRINCIPALS_KEY = "rib:adme:principals";

// Data section
export const DATA_PULSE_KEY = "rib:adme:data-pulse";
export const MAP_KEY = "rib:adme:map";
export const RECORDS_KEY = "rib:adme:records";

// Seismic section
export const SEIS_PULSE_KEY = "rib:adme:seis-pulse";
export const SEIS_SUBPROJECTS_KEY = "rib:adme:seis-subprojects";
export const SEIS_SELECTED_KEY = "rib:adme:seis-selected";
export const SEIS_CHANGE_KEY = "rib:adme:seis-change";
export const SEIS_REACH_KEY = "rib:adme:seis-reach";

// Drawer inspectors: no region, opened in the canvas drawer.
export const CONNECTION_KEY = "rib:adme:connection";
export const PERSON_KEY = "rib:adme:person";
export const PLAN_KEY = "rib:adme:plan";
export const EXPLAIN_KEY = "rib:adme:explain";
export const RECORD_KEY = "rib:adme:record";

export const BOARD_KEYS = [
  HEADER_KEY,
  PULSE_KEY,
  ATTENTION_KEY,
  ACTIVITY_KEY,
  ORGS_KEY,
  CHANGE_KEY,
  OPERATION_KEY,
  RECENT_KEY,
  PEOPLE_KEY,
  COHORTS_KEY,
  PRINCIPALS_KEY,
  DATA_PULSE_KEY,
  MAP_KEY,
  RECORDS_KEY,
  SEIS_PULSE_KEY,
  SEIS_SUBPROJECTS_KEY,
  SEIS_SELECTED_KEY,
  SEIS_CHANGE_KEY,
  SEIS_REACH_KEY,
  CONNECTION_KEY,
  PERSON_KEY,
  PLAN_KEY,
  EXPLAIN_KEY,
  RECORD_KEY,
] as const;

export const SURFACE_ID = "adme";

// The host names a surface tab "surface:<rib id>:<surface id>"; open-surface takes that form.
export function surfaceTab(surfaceId: string): string {
  return `surface:${RIB_ID}:${surfaceId}`;
}
