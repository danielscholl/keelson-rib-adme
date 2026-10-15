// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export const RIB_ID = "adme";

// The connect journey and a lapsed sign-in; hidden once connected.
export const HEADER_KEY = "rib:adme:header";

// The console is html, not a board: one banner drawn from the brief.
export const CONSOLE_KEY = "rib:adme:console";
// The side inspector for console selections; an inspect action opens it in the drawer.
export const INSPECT_KEY = "rib:adme:inspect";

// Regions below the console.
export const OPERATION_KEY = "rib:adme:operation";
export const RECENT_KEY = "rib:adme:recent";
export const MAP_KEY = "rib:adme:map";

// Drawer inspectors: no region, opened in the canvas drawer.
export const CONNECTION_KEY = "rib:adme:connection";
export const PERSON_KEY = "rib:adme:person";
export const PLAN_KEY = "rib:adme:plan";
export const EXPLAIN_KEY = "rib:adme:explain";
export const RECORD_KEY = "rib:adme:record";
export const RECORDS_KEY = "rib:adme:records";
export const COHORTS_KEY = "rib:adme:cohorts";

export const BOARD_KEYS = [
  HEADER_KEY,
  OPERATION_KEY,
  RECENT_KEY,
  MAP_KEY,
  CONNECTION_KEY,
  PERSON_KEY,
  PLAN_KEY,
  EXPLAIN_KEY,
  RECORD_KEY,
  RECORDS_KEY,
  COHORTS_KEY,
  INSPECT_KEY,
] as const;

export const SURFACE_ID = "adme";
