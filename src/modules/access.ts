// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Identity } from "../access/model.ts";
import { ACCESS_AREAS } from "../access/read.ts";
import {
  composeAccessPulse,
  composeAttention,
  composeCohorts,
  composePeople,
  composePrincipals,
  EXPORT_ROSTER_ACTION,
  exportRoster,
  IMPORT_COHORTS_ACTION,
  measuredAccess,
} from "../boards/access.ts";
import {
  ACCESS_BADGE_KEY,
  ATTENTION_KEY,
  COHORTS_KEY,
  PEOPLE_KEY,
  PRINCIPALS_KEY,
  PULSE_KEY,
} from "../keys.ts";
import type { RegionModule } from "../region.ts";
import type { Runtime } from "../runtime.ts";

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Two cohort names can reduce to one slug, or to none; those get a number.
function exportSlug(rt: Runtime, cohort: string): string {
  const names = rt.tracker.cohorts.map((c) => c.name);
  const base = slug(cohort);
  const clash = names.filter((n) => slug(n) === base).length > 1;
  return base && !clash ? base : `${base || "cohort"}-${names.indexOf(cohort) + 1}`;
}

function inImport(person: Identity, email: string): boolean {
  return person.email?.toLowerCase() === email;
}

export const accessModule: RegionModule = {
  areas: ACCESS_AREAS,
  composers: {
    [PULSE_KEY]: composeAccessPulse,
    [ATTENTION_KEY]: composeAttention,
    [PEOPLE_KEY]: composePeople,
    [PRINCIPALS_KEY]: composePrincipals,
    [COHORTS_KEY]: composeCohorts,
  },
  actions: {
    [IMPORT_COHORTS_ACTION]: async (rt, payload) => {
      const csv = (payload as { csv?: unknown } | undefined)?.csv;
      if (typeof csv !== "string") return { ok: false, error: "Paste the list to import." };
      const res = rt.tracker.importCsv(csv, rt.now());
      if (!res.ok) return res;
      rt.recompose([PULSE_KEY, PEOPLE_KEY, COHORTS_KEY]);
      const people = measuredAccess(rt)?.model.people ?? [];
      const absent = res.emails.filter((e) => !people.some((p) => p.cohort && inImport(p, e)));
      const note = absent.length > 0 ? `; ${absent.length} not in entitlements` : "";
      return {
        ok: true,
        data: {
          message: `Imported ${res.emails.length} into ${res.cohorts} cohort(s)${note}`,
        },
      };
    },
    [EXPORT_ROSTER_ACTION]: async (rt, payload) => {
      const cohort = (payload as { cohort?: unknown } | undefined)?.cohort;
      if (typeof cohort !== "string") return { ok: false, error: "Pick a cohort to export." };
      if (!measuredAccess(rt)) return { ok: false, error: "People are not measured yet." };
      const csv = exportRoster(rt, cohort);
      if (!csv) return { ok: false, error: "Nobody is in that cohort." };
      const day = rt.now().toISOString().slice(0, 10);
      const path = rt.writeExport(`roster-${exportSlug(rt, cohort)}-${day}.csv`, csv);
      if (!path) return { ok: false, error: "The rib has no data directory to write to." };
      return { ok: true, data: { message: `Wrote ${path}` } };
    },
  },
  badges: {
    [ACCESS_BADGE_KEY]: (rt) => measuredAccess(rt)?.counts.needsYou ?? 0,
  },
};
