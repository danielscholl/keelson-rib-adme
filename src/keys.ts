// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export const RIB_ID = "adme";

// ADME Access
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

// ADME Data
export const DATA_PULSE_KEY = "rib:adme:data-pulse";
export const RECORDS_KEY = "rib:adme:records";
export const LEGAL_KEY = "rib:adme:legal";
export const SERVICES_KEY = "rib:adme:services";

// ADME Seismic
export const SEIS_PULSE_KEY = "rib:adme:seis-pulse";
export const SEIS_SUBPROJECTS_KEY = "rib:adme:seis-subprojects";
export const SEIS_SELECTED_KEY = "rib:adme:seis-selected";
export const SEIS_CHANGE_KEY = "rib:adme:seis-change";
export const SEIS_REACH_KEY = "rib:adme:seis-reach";

// The footer of all three surfaces, under one key.
export const CONNECTION_KEY = "rib:adme:connection";

// Drawer inspectors: no region, opened in the canvas drawer.
export const PERSON_KEY = "rib:adme:person";
export const PLAN_KEY = "rib:adme:plan";
export const EXPLAIN_KEY = "rib:adme:explain";

// Tab badges carry a RibSurfaceBadge, not a board.
export const ACCESS_BADGE_KEY = "rib:adme:access-badge";
export const DATA_BADGE_KEY = "rib:adme:data-badge";

export const BOARD_KEYS = [
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
  RECORDS_KEY,
  LEGAL_KEY,
  SERVICES_KEY,
  SEIS_PULSE_KEY,
  SEIS_SUBPROJECTS_KEY,
  SEIS_SELECTED_KEY,
  SEIS_CHANGE_KEY,
  SEIS_REACH_KEY,
  CONNECTION_KEY,
  PERSON_KEY,
  PLAN_KEY,
  EXPLAIN_KEY,
] as const;

export const BADGE_KEYS = [ACCESS_BADGE_KEY, DATA_BADGE_KEY] as const;

export const ACCESS_SURFACE_ID = "adme-access";
export const DATA_SURFACE_ID = "adme-data";
export const SEISMIC_SURFACE_ID = "adme-seismic";

// The host names a surface tab "surface:<rib id>:<surface id>"; open-surface takes that form.
export function surfaceTab(surfaceId: string): string {
  return `surface:${RIB_ID}:${surfaceId}`;
}
