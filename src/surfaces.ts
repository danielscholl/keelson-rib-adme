// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibSurfaceDescriptor, RibSurfaceRegion } from "@keelson/shared";
import {
  ACCESS_BADGE_KEY,
  ACCESS_SURFACE_ID,
  ATTENTION_KEY,
  CHANGE_KEY,
  COHORTS_KEY,
  CONNECTION_KEY,
  DATA_BADGE_KEY,
  DATA_PULSE_KEY,
  DATA_SURFACE_ID,
  LEGAL_KEY,
  OPERATION_KEY,
  PEOPLE_KEY,
  PRINCIPALS_KEY,
  PULSE_KEY,
  RECENT_KEY,
  RECORDS_KEY,
  SEIS_CHANGE_KEY,
  SEIS_PULSE_KEY,
  SEIS_REACH_KEY,
  SEIS_SELECTED_KEY,
  SEIS_SUBPROJECTS_KEY,
  SEISMIC_SURFACE_ID,
  SERVICES_KEY,
} from "./keys.ts";

export const REFRESH_ACTION = "refresh";
export const RETEST_ACTION = "retest-connection";

const connectionFooter: RibSurfaceRegion = {
  key: CONNECTION_KEY,
  title: "Connection",
  glyph: { char: "⌁", tone: "neutral" },
  collapsible: true,
  collapsed: true,
};

const headMenu: RibSurfaceRegion["headActions"] = [
  { type: REFRESH_ACTION, label: "Refresh now" },
  { type: RETEST_ACTION, label: "Re-test connection" },
];

// The rib drives refresh in-process, so no region declares a workflow or cadence.
export const SURFACES: readonly RibSurfaceDescriptor[] = [
  {
    id: ACCESS_SURFACE_ID,
    title: "ADME Access",
    heading: "ADME access",
    subtitle: "Who can reach the instance, and what each person can touch.",
    badgeKey: ACCESS_BADGE_KEY,
    layout: {
      header: {
        key: PULSE_KEY,
        title: "Access",
        glyph: { char: "◉", tone: "accent" },
        live: true,
        headActions: headMenu,
      },
      rows: [
        {
          zoneTitle: "Now",
          columns: [
            { key: ATTENTION_KEY, title: "Needs you", glyph: { char: "!", tone: "caution" } },
            [
              { key: CHANGE_KEY, title: "Change access", glyph: { char: "+", tone: "brand" } },
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
                collapsible: true,
              },
            ],
          ],
        },
        {
          zoneTitle: "People",
          columns: [{ key: PEOPLE_KEY, title: "People", glyph: { char: "☰", tone: "info" } }],
        },
        {
          zoneTitle: "Cohorts",
          columns: [
            { key: COHORTS_KEY, title: "Cohorts", glyph: { char: "▦", tone: "info" } },
            { key: PRINCIPALS_KEY, title: "Applications", glyph: { char: "⚙", tone: "neutral" } },
          ],
        },
      ],
      footer: connectionFooter,
    },
  },
  {
    id: DATA_SURFACE_ID,
    title: "ADME Data",
    heading: "Data and governance",
    subtitle:
      "Which services answer, which legal tags hold, how much data is in the partition, and a record search. Read only.",
    badgeKey: DATA_BADGE_KEY,
    layout: {
      header: {
        key: DATA_PULSE_KEY,
        title: "Data",
        glyph: { char: "◉", tone: "accent" },
        live: true,
        headActions: headMenu,
      },
      rows: [
        {
          zoneTitle: "Records",
          columns: [{ key: RECORDS_KEY, title: "Records", glyph: { char: "⌕", tone: "info" } }],
        },
        {
          zoneTitle: "Governance",
          columns: [
            { key: LEGAL_KEY, title: "Legal tags", glyph: { char: "§", tone: "caution" } },
            {
              key: SERVICES_KEY,
              title: "Services",
              glyph: { char: "⇄", tone: "neutral" },
              collapsible: true,
            },
          ],
        },
      ],
      footer: connectionFooter,
    },
  },
  {
    id: SEISMIC_SURFACE_ID,
    title: "ADME Seismic",
    heading: "Seismic store",
    subtitle: "Subprojects in the tenant, and who is in each, by name.",
    layout: {
      header: {
        key: SEIS_PULSE_KEY,
        title: "Seismic store",
        glyph: { char: "◉", tone: "accent" },
        live: true,
        headActions: headMenu,
      },
      rows: [
        {
          columns: [
            {
              key: SEIS_SUBPROJECTS_KEY,
              title: "Subprojects",
              glyph: { char: "▦", tone: "info" },
            },
          ],
        },
        {
          columns: [
            { key: SEIS_SELECTED_KEY, title: "Selected subproject", glyph: { char: "◎" } },
            [
              {
                key: SEIS_CHANGE_KEY,
                title: "Grant or revoke",
                glyph: { char: "+", tone: "brand" },
              },
              {
                key: SEIS_REACH_KEY,
                title: "What a partner can reach",
                glyph: { char: "→", tone: "info" },
              },
            ],
          ],
        },
      ],
      footer: connectionFooter,
    },
  },
];
