// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult, RibSurfaceDescriptor, RibSurfaceRegion } from "@keelson/shared";
import { EXPORT_GUIDE_ACTION } from "./access/guide.ts";
import { CONNECTION_DETAILS_ACTION, RETEST_ACTION } from "./boards/connection.ts";
import {
  CONSOLE_KEY,
  HEADER_KEY,
  MAP_KEY,
  OPERATION_KEY,
  RECENT_KEY,
  SURFACE_ID,
  surfaceTab,
} from "./keys.ts";

export const REFRESH_ACTION = "refresh";
export const INSPECT_ACTION = "inspect";

// Scrolls the tab to a region below the console.
export function openRegion(regionKey: string): RibActionResult {
  return {
    ok: true,
    data: { effect: "open-surface", surfaceId: surfaceTab(SURFACE_ID), regionKey },
  };
}

// The connect journey and a lapsed sign-in; empty, and so hidden, once connected.
const header: RibSurfaceRegion = {
  key: HEADER_KEY,
  title: "Connection",
  glyph: { char: "⌁", tone: "accent" },
  hideWhenEmpty: true,
  headActions: [
    { type: RETEST_ACTION, label: "Re-test connection" },
    { type: CONNECTION_DETAILS_ACTION, label: "Connection details" },
  ],
};

// The console is the tab: it says what needs a decision and why, and every selection
// opens the side inspector. The rib drives refresh in-process, so no region names a
// workflow or cadence.
export const SURFACES: readonly RibSurfaceDescriptor[] = [
  {
    id: SURFACE_ID,
    title: "ADME",
    heading: "ADME",
    subtitle:
      "Who has access to the instance, what data is in it, and who can reach each seismic subproject.",
    layout: {
      header,
      banner: {
        key: CONSOLE_KEY,
        title: "Console",
        glyph: { char: "◉", tone: "accent" },
        live: true,
        headActions: [
          { type: REFRESH_ACTION, label: "Refresh now" },
          { type: RETEST_ACTION, label: "Re-test connection" },
          { type: CONNECTION_DETAILS_ACTION, label: "Connection details" },
          { type: EXPORT_GUIDE_ACTION, label: "Export who has access" },
        ],
      },
      rows: [
        // A running plan and its history; the plan is the only write path.
        {
          columns: [
            {
              key: OPERATION_KEY,
              title: "Operation",
              glyph: { char: "▶", tone: "info" },
              hideWhenEmpty: true,
            },
            {
              key: RECENT_KEY,
              title: "Recent changes",
              glyph: { char: "↺", tone: "neutral" },
              hideWhenEmpty: true,
              collapsible: true,
              collapsed: true,
            },
          ],
        },
        {
          columns: [
            {
              key: MAP_KEY,
              title: "Explore the partition",
              byline:
                "what is in the partition, who can reach it and which legal tag governs it · select a row",
              glyph: { char: "◈", tone: "info" },
              hideWhenEmpty: true,
              collapsible: true,
              collapsed: true,
            },
          ],
        },
      ],
    },
  },
];
