// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { columnRegions, type RibSurfaceDescriptor, type RibSurfaceRegion } from "@keelson/shared";
import { CONNECTION_DETAILS_ACTION, RETEST_ACTION } from "./boards/connection.ts";
import { EXPORT_GUIDE_ACTION } from "./boards/people.ts";
import {
  ACTIVITY_KEY,
  ATTENTION_KEY,
  BADGE_KEY,
  HEADER_KEY,
  LEGAL_KEY,
  OPERATION_KEY,
  ORGS_KEY,
  PEOPLE_KEY,
  PRINCIPALS_KEY,
  RECENT_KEY,
  RECORDS_KEY,
  SEIS_CHANGE_KEY,
  SEIS_REACH_KEY,
  SEIS_SELECTED_KEY,
  SEIS_SUBPROJECTS_KEY,
  SERVICES_KEY,
  SURFACE_ID,
} from "./keys.ts";
import type { SectionId } from "./section.ts";

export const REFRESH_ACTION = "refresh";

type Row = RibSurfaceDescriptor["layout"]["rows"][number];

// Zone titles stay on screen when their regions hide, so sections set none.
const ACCESS_ROWS: Row[] = [
  {
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
    columns: [
      {
        key: ORGS_KEY,
        title: "Organizations",
        byline: "who has access, one card per email domain · select one to filter People",
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
        collapsible: true,
        collapsed: true,
        headActions: [{ type: EXPORT_GUIDE_ACTION, label: "Export who has access" }],
      },
    ],
  },
  {
    columns: [
      {
        key: PRINCIPALS_KEY,
        title: "Applications",
        glyph: { char: "⚙", tone: "neutral" },
        hideWhenEmpty: true,
        collapsible: true,
        collapsed: true,
      },
    ],
  },
];

const DATA_ROWS: Row[] = [
  {
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
];

const SEISMIC_ROWS: Row[] = [
  {
    columns: [
      {
        key: SEIS_SUBPROJECTS_KEY,
        title: "Subprojects",
        byline: "select one to see its members · datasets are not measured until one is opened",
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
  // The only write path left, so a running plan and its history show here.
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
];

const SECTION_ROWS: Record<SectionId, Row[]> = {
  access: ACCESS_ROWS,
  data: DATA_ROWS,
  seismic: SEISMIC_ROWS,
};

const SECTION_OF = new Map<string, SectionId>(
  Object.entries(SECTION_ROWS).flatMap(([section, rows]) =>
    rows.flatMap((r) =>
      r.columns.flatMap((c) => columnRegions(c).map((x) => [x.key, section as SectionId] as const)),
    ),
  ),
);

// The section a region belongs to; header and inspectors belong to none.
export function sectionOf(key: string): SectionId | undefined {
  return SECTION_OF.get(key);
}

const header: RibSurfaceRegion = {
  key: HEADER_KEY,
  title: "ADME",
  glyph: { char: "◉", tone: "accent" },
  live: true,
  headActions: [
    { type: REFRESH_ACTION, label: "Refresh now" },
    { type: RETEST_ACTION, label: "Re-test connection" },
    { type: CONNECTION_DETAILS_ACTION, label: "Connection details" },
  ],
};

// One nav tab; the header's switcher shows one section's regions at a time.
// The rib drives refresh in-process, so no region declares a workflow or cadence.
export const SURFACES: readonly RibSurfaceDescriptor[] = [
  {
    id: SURFACE_ID,
    title: "ADME",
    heading: "ADME",
    subtitle:
      "Who has access to the instance, what data is in it, and who can reach each seismic subproject.",
    badgeKey: BADGE_KEY,
    layout: {
      header,
      rows: [...ACCESS_ROWS, ...DATA_ROWS, ...SEISMIC_ROWS],
    },
  },
];
