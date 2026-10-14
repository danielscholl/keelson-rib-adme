// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import type { ActivityState } from "../access/activity.ts";
import { type Measured, measuredAccess, usageCount } from "../access/measured.ts";
import type { Identity } from "../access/model.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { type Cohort, csvCell, daysUntil, UNTRACKED } from "../tracker.ts";

export { type Measured, measuredAccess, usageCount };

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];

export const IMPORT_COHORTS_ACTION = "import-cohorts";
export const EXPORT_ROSTER_ACTION = "export-roster";
export const SELECT_PERSON_ACTION = "select-person";

export function inCohort(people: Identity[], name: string): Identity[] {
  return people.filter((p) => (p.cohort ?? UNTRACKED) === name);
}

// Tracked cohorts in the order they were created, then Untracked when anyone is.
export function cohortNames(rt: Runtime, people: Identity[]): string[] {
  const names = rt.tracker.cohorts.map((c) => c.name);
  return people.some((p) => !p.cohort) ? [...names, UNTRACKED] : names;
}

export function passText(cohort: Cohort | undefined, now: Date): string {
  if (!cohort?.passEnds) return "none";
  const days = daysUntil(cohort.passEnds, now);
  return days < 0 ? `ended ${-days} d ago · ${cohort.passEnds}` : `${days} d · ${cohort.passEnds}`;
}

const DAY_MS = 86_400_000;
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function day(iso: string | undefined): string | undefined {
  return iso?.slice(0, 10);
}

export function daysAgo(iso: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS));
  if (days >= 365) return `${(days / 365).toFixed(1)} y ago`;
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} d ago`;
}

export function activityReason(state: ActivityState): string {
  if (state.kind === "unset") return "set the audit log workspace in Connection";
  if (state.kind === "unread") return state.error ?? "the audit log is not read yet";
  return "";
}

// Clicking a person or application opens the inspector in the drawer.
export function openAction(who: Identity, selected: string | undefined) {
  return {
    action: { type: SELECT_PERSON_ACTION, payload: { id: who.id } },
    ...(who.id === selected ? { selected: true } : {}),
  };
}

function rosterCsv(people: Identity[], cohort: Cohort | undefined, name: string): string {
  const rows = people.map((p) =>
    [p.name, p.email ?? "", p.role ?? "", p.state, name, cohort?.passEnds ?? ""]
      .map(csvCell)
      .join(","),
  );
  return `${["name,email,role,state,cohort,pass_end", ...rows].join("\n")}\n`;
}

// The roster of one cohort as CSV, or undefined when nobody is in it.
export function exportRoster(rt: Runtime, name: string): string | undefined {
  const measured = measuredAccess(rt);
  if (!measured) return undefined;
  const people = inCohort(measured.model.people, name);
  if (people.length === 0) return undefined;
  return rosterCsv(
    people,
    rt.tracker.cohorts.find((c) => c.name === name),
    name,
  );
}

function cohortCard(rt: Runtime, name: string, people: Identity[]): Card {
  const cohort = rt.tracker.cohorts.find((c) => c.name === name);
  const n = (state: Identity["state"]) => people.filter((p) => p.state === state).length;
  const segments = [
    { label: "broken", n: n("broken"), tone: "error" as const },
    { label: "pending", n: n("pending"), tone: "warn" as const },
    { label: "healthy", n: n("healthy"), tone: "ok" as const },
  ].filter((s) => s.n > 0);
  return {
    title: name,
    pill: { label: plural(people.length, "person", "people") },
    ...(segments.length > 0 ? { bar: { segments } } : {}),
    fields: [
      { label: "Pass ends", value: name === UNTRACKED ? "?" : passText(cohort, rt.now()) },
      ...(cohort ? [{ label: "Created", value: cohort.created }] : []),
    ],
    ...(people.length > 0
      ? {
          actions: [
            { type: EXPORT_ROSTER_ACTION, label: "Export roster", payload: { cohort: name } },
          ],
        }
      : {}),
    ...(name === UNTRACKED ? { footnote: "In entitlements, in no tracked cohort." } : {}),
  };
}

export function composeCohorts(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const people = measured.model.people;
  const tracked = rt.tracker.cohorts.length;
  const names = cohortNames(rt, people);
  const untracked = people.filter((p) => !p.cohort).length;
  const sections: Section[] = [];
  if (rt.tracker.unreadable) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "error",
          text: "The cohort tracker in the data directory could not be read, so cohorts are not shown. Fix or remove the file, then restart.",
        },
      ],
    });
  } else if (tracked === 0) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "No cohort is tracked. Import a list to group people and track when each pass ends.",
        },
      ],
    });
  }
  if (names.length > 0) {
    sections.push({
      kind: "cards",
      grid: true,
      items: names.map((name) => cohortCard(rt, name, inCohort(people, name))),
    });
  }
  sections.push({
    kind: "actions",
    items: [
      {
        type: IMPORT_COHORTS_ACTION,
        label: "Import cohorts",
        submitLabel: "Import",
        fields: [
          {
            name: "csv",
            label: "One person per line: email, cohort, pass end (optional)",
            placeholder: "kofi.mensah@volta-subsurface.example, Pilot, 2026-10-28",
            multiline: true,
            required: true,
          },
        ],
      },
    ],
  });
  return {
    view: "board",
    header: {
      chip: [
        plural(people.length, "person", "people"),
        plural(tracked, "cohort", "cohorts"),
        ...(untracked > 0 ? [`${untracked} untracked`] : []),
      ].join(" · "),
    },
    sections,
  };
}
