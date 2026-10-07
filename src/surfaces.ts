// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibSurfaceDescriptor, RibSurfaceRegion } from "@keelson/shared";
import { RETEST_ACTION } from "./boards/connection.ts";
import { EXPORT_GUIDE_ACTION } from "./boards/people.ts";
import { SEIS_REFRESH_ACTION } from "./boards/seismic.ts";
import {
  ACCESS_BADGE_KEY,
  ACCESS_SURFACE_ID,
  ACTIVITY_KEY,
  ATTENTION_KEY,
  CHANGE_KEY,
  COHORTS_KEY,
  CONNECTION_KEY,
  DATA_BADGE_KEY,
  DATA_PULSE_KEY,
  DATA_SURFACE_ID,
  LEGAL_KEY,
  OPERATION_KEY,
  ORGS_KEY,
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

// Not statically collapsed: the board's defaultCollapsed folds it while connected
// and leaves it open when sign-in is needed.
const connectionFooter: RibSurfaceRegion = {
  key: CONNECTION_KEY,
  title: "Connection",
  glyph: { char: "⌁", tone: "neutral" },
  collapsible: true,
};

const headMenu: RibSurfaceRegion["headActions"] = [
  { type: REFRESH_ACTION, label: "Refresh now" },
  { type: RETEST_ACTION, label: "Re-test connection" },
];

// Refresh here also reads the seismic store, which the plain sweep skips.
const seismicHeadMenu: RibSurfaceRegion["headActions"] = [
  { type: SEIS_REFRESH_ACTION, label: "Refresh now" },
  { type: RETEST_ACTION, label: "Re-test connection" },
];

// The rib drives refresh in-process, so no region declares a workflow or cadence.
export const SURFACES: readonly RibSurfaceDescriptor[] = [
  {
    id: ACCESS_SURFACE_ID,
    title: "ADME Access",
    heading: "ADME access",
    subtitle: "Who has access to the instance, and are they using it?",
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
            {
              key: ATTENTION_KEY,
              title: "Follow up",
              byline: "people who have access but cannot or do not use it yet",
              glyph: { char: "!", tone: "caution" },
              hideWhenEmpty: true,
            },
            {
              key: ACTIVITY_KEY,
              title: "Activity",
              byline: "data calls from the instance audit log",
              glyph: { char: "≋", tone: "info" },
              hideWhenEmpty: true,
            },
          ],
        },
        {
          zoneTitle: "Who has access",
          columns: [
            {
              key: ORGS_KEY,
              title: "Organizations",
              byline: "one card per email domain · select one to filter People",
              glyph: { char: "▦", tone: "info" },
              hideWhenEmpty: true,
            },
          ],
        },
        {
          columns: [
            {
              key: PEOPLE_KEY,
              title: "People",
              glyph: { char: "☰", tone: "info" },
              hideWhenEmpty: true,
              headActions: [{ type: EXPORT_GUIDE_ACTION, label: "Export who has access" }],
            },
          ],
        },
        {
          zoneTitle: "Changes",
          columns: [
            {
              key: CHANGE_KEY,
              title: "Change access",
              byline: "nothing changes until you apply the plan",
              glyph: { char: "+", tone: "brand" },
              hideWhenEmpty: true,
              collapsible: true,
              collapsed: true,
            },
            [
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
          ],
        },
        {
          zoneTitle: "Cohorts and applications",
          columns: [
            {
              key: COHORTS_KEY,
              title: "Cohorts",
              glyph: { char: "▦", tone: "neutral" },
              hideWhenEmpty: true,
              collapsible: true,
            },
            {
              key: PRINCIPALS_KEY,
              title: "Applications",
              glyph: { char: "⚙", tone: "neutral" },
              hideWhenEmpty: true,
              collapsible: true,
            },
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
          columns: [
            {
              key: RECORDS_KEY,
              title: "Records",
              glyph: { char: "⌕", tone: "info" },
              hideWhenEmpty: true,
            },
          ],
        },
        {
          zoneTitle: "Governance",
          columns: [
            {
              key: LEGAL_KEY,
              title: "Legal tags",
              glyph: { char: "§", tone: "caution" },
              hideWhenEmpty: true,
            },
            {
              key: SERVICES_KEY,
              title: "Services",
              glyph: { char: "⇄", tone: "neutral" },
              hideWhenEmpty: true,
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
        byline: "subprojects in the partition's seismic tenant",
        glyph: { char: "◉", tone: "accent" },
        live: true,
        headActions: seismicHeadMenu,
      },
      rows: [
        {
          columns: [
            {
              key: SEIS_SUBPROJECTS_KEY,
              title: "Subprojects",
              byline:
                "select one to see its members · datasets are not measured until one is opened",
              glyph: { char: "▦", tone: "info" },
              hideWhenEmpty: true,
            },
          ],
        },
        {
          columns: [
            {
              key: SEIS_SELECTED_KEY,
              title: "Selected subproject",
              byline: "identifiers and members by name",
              glyph: { char: "◎" },
              hideWhenEmpty: true,
            },
            [
              {
                key: SEIS_CHANGE_KEY,
                title: "Grant or revoke",
                byline: "one plan, previewed before anything changes",
                glyph: { char: "+", tone: "brand" },
                hideWhenEmpty: true,
              },
              {
                key: SEIS_REACH_KEY,
                title: "What a partner can reach",
                byline: "listing subprojects is admin only, so partners need the paths",
                glyph: { char: "→", tone: "info" },
                hideWhenEmpty: true,
              },
            ],
          ],
        },
      ],
      footer: connectionFooter,
    },
  },
];
