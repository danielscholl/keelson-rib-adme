// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import type { Store } from "./store.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const cohortSchema = z.object({
  name: z.string().min(1),
  created: z.string().regex(DAY),
  passEnds: z.string().regex(DAY).optional(),
});
export type Cohort = z.infer<typeof cohortSchema>;

const trackerSchema = z.object({
  cohorts: z.array(cohortSchema),
  // Lowercased email address to cohort name.
  members: z.record(z.string(), z.string()),
  events: z.array(z.object({ at: z.string(), text: z.string() })),
});
type TrackerFile = z.infer<typeof trackerSchema>;

export const UNTRACKED = "Untracked";
const EVENT_LIMIT = 200;

export type ImportResult =
  | { ok: true; emails: string[]; cohorts: number }
  | { ok: false; error: string };

// Whole days from `now` to the end date, counted on the UTC calendar.
export function daysUntil(day: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${day}T00:00:00Z`) - today) / DAY_MS);
}

function validDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function cellsOf(line: string): string[] {
  const cells = line.split(",").map((c) =>
    c
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim(),
  );
  while (cells.length > 0 && cells.at(-1) === "") cells.pop();
  return cells;
}

// One tracker per instance, so cohorts never follow the operator to another one.
export function trackerFile(profile: { host: string; partition: string } | undefined): string {
  return profile ? `tracker.${profile.host}.${profile.partition}.json` : "tracker.json";
}

// What the instance cannot say: which cohort a person belongs to and when its
// pass ends. Kept in the rib's data dir, so it is a second source of truth.
export class Tracker {
  private file: TrackerFile;
  // A file that is there but does not parse is never overwritten.
  readonly unreadable: boolean;

  constructor(
    private readonly store: Store,
    private readonly name: string,
  ) {
    const read = store.read(name, trackerSchema);
    this.unreadable = read === undefined && store.exists(name);
    this.file = read ?? { cohorts: [], members: {}, events: [] };
  }

  get cohorts(): readonly Cohort[] {
    return this.file.cohorts;
  }

  cohortOf(email: string | undefined): string | undefined {
    return email ? this.file.members[email.toLowerCase()] : undefined;
  }

  // Lines of `email,cohort[,pass end]`. Nothing is saved unless every line is valid.
  importCsv(text: string, now: Date): ImportResult {
    if (this.unreadable) {
      return {
        ok: false,
        error: `${this.name} could not be read. Fix or remove it, then restart.`,
      };
    }
    const members: Record<string, string> = {};
    const passEnds = new Map<string, string>();
    const names = new Map<string, string>();
    const lines = text.split(/\r?\n/);
    for (const [i, raw] of lines.entries()) {
      const cells = cellsOf(raw);
      if (cells.length === 0) continue;
      const [email = "", cohort = "", end = ""] = cells;
      if (i === 0 && email.toLowerCase() === "email") continue;
      const where = `line ${i + 1}`;
      if (!/^[^@\s]+@[^@\s]+$/.test(email))
        return { ok: false, error: `${where}: not an email address` };
      if (!cohort) return { ok: false, error: `${where}: no cohort` };
      if (cohort.toLowerCase() === UNTRACKED.toLowerCase()) {
        return { ok: false, error: `${where}: ${UNTRACKED} is not a cohort name` };
      }
      if (cells.length > 3) return { ok: false, error: `${where}: more than three values` };
      if (end && !validDay(end))
        return { ok: false, error: `${where}: pass end is not YYYY-MM-DD` };
      const key = cohort.toLowerCase();
      const name =
        names.get(key) ??
        this.file.cohorts.find((c) => c.name.toLowerCase() === key)?.name ??
        cohort;
      names.set(key, name);
      const known = passEnds.get(key);
      if (end && known && known !== end) {
        return { ok: false, error: `${where}: ${name} already has pass end ${known}` };
      }
      if (end) passEnds.set(key, end);
      members[email.toLowerCase()] = name;
    }
    const emails = Object.keys(members);
    const assigned = emails.length;
    if (assigned === 0) return { ok: false, error: "no lines to import" };
    // A cohort named only on a line that a later line replaced is not created.
    const used = new Set(Object.values(members).map((n) => n.toLowerCase()));
    for (const key of [...names.keys()]) if (!used.has(key)) names.delete(key);
    const cohorts = this.file.cohorts.map((c) => ({ ...c }));
    for (const [key, name] of names) {
      let cohort = cohorts.find((c) => c.name.toLowerCase() === key);
      if (!cohort) {
        cohort = { name, created: now.toISOString().slice(0, 10) };
        cohorts.push(cohort);
      }
      const end = passEnds.get(key);
      if (end) cohort.passEnds = end;
    }
    const event = {
      at: now.toISOString(),
      text: `Imported ${assigned} ${assigned === 1 ? "person" : "people"} into ${[...names.values()].join(", ")}`,
    };
    this.file = {
      cohorts,
      members: { ...this.file.members, ...members },
      events: [event, ...this.file.events].slice(0, EVENT_LIMIT),
    };
    this.store.write(this.name, this.file);
    return { ok: true, emails, cohorts: names.size };
  }
}

// A leading = + - or @ would run as a formula when the file is opened in a spreadsheet.
export function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
