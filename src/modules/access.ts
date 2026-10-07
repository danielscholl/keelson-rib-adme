// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { ACTIVITY_AREAS } from "../access/activity.ts";
import type { Identity } from "../access/model.ts";
import { groupByOrg, ORG_FILTER } from "../access/orgs.ts";
import {
  personRead,
  readPersonGroups,
  recordError,
  recordRead,
  selectedId,
  selectPerson,
} from "../access/person.ts";
import { ACCESS_AREAS } from "../access/read.ts";
import {
  composeAccessPulse,
  composeAttention,
  composeCohorts,
  composePrincipals,
  EXPORT_ROSTER_ACTION,
  exportRoster,
  IMPORT_COHORTS_ACTION,
  measuredAccess,
  SELECT_PERSON_ACTION,
} from "../boards/access.ts";
import { composeActivity, composeOrgs } from "../boards/activity.ts";
import { SIGNIN_REASON } from "../boards/connection.ts";
import {
  accessGuideMarkdown,
  composePeople,
  EXPORT_GUIDE_ACTION,
  isPeopleView,
  PEOPLE_FILTER_ACTION,
  PEOPLE_VIEW_ACTION,
  peopleState,
} from "../boards/people.ts";
import {
  ACCEPT_EXTRAS_ACTION,
  composePerson,
  findIdentity,
  inspectorTitle,
  personAudit,
  REFRESH_PERSON_ACTION,
} from "../boards/person.ts";
import {
  ACCESS_BADGE_KEY,
  ACCESS_SURFACE_ID,
  ACTIVITY_KEY,
  ATTENTION_KEY,
  COHORTS_KEY,
  ORGS_KEY,
  PEOPLE_KEY,
  PERSON_KEY,
  PRINCIPALS_KEY,
  PULSE_KEY,
} from "../keys.ts";
import type { ActionHandler, RegionModule } from "../region.ts";
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

function idOf(payload: unknown): string | undefined {
  const id = (payload as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id.trim() !== "" ? id.trim().toLowerCase() : undefined;
}

// Tier 3 for one identity. A lapsed sign-in is not recorded: the runtime flips the phase.
async function readGroups(rt: Runtime, id: string): Promise<string | undefined> {
  const res = await rt.run((batch) => readPersonGroups(batch, id));
  if (res.ok) {
    recordRead(rt, id, res.data);
    return undefined;
  }
  if (res.failure.kind === "signin" && res.failure.status === null) return SIGNIN_REASON;
  recordError(rt, id, res.failure.message);
  return res.failure.message;
}

const selectPersonAction: ActionHandler = async (rt, payload) => {
  const id = idOf(payload);
  if (!id) return { ok: false, error: "Pick a person to open." };
  const measured = measuredAccess(rt);
  if (!measured) return { ok: false, error: "People are not measured yet." };
  const who = findIdentity(measured.model, id);
  if (!who) {
    return {
      ok: false,
      error: "That person is not in the last read of entitlements. Refresh and pick again.",
    };
  }
  selectPerson(rt, who.id);
  if (rt.status.phase === "connected") await readGroups(rt, who.id);
  rt.recompose([PERSON_KEY]);
  rt.recompose([PEOPLE_KEY, ATTENTION_KEY, PRINCIPALS_KEY]);
  return {
    ok: true,
    data: { effect: "open-canvas", key: PERSON_KEY, title: inspectorTitle(who), placement: "side" },
  };
};

function selectedIdentity(rt: Runtime, payload: unknown): Identity | string {
  const id = idOf(payload);
  const measured = measuredAccess(rt);
  if (!id || !measured || id !== selectedId(rt)) return "That person is no longer open.";
  return findIdentity(measured.model, id) ?? "That person is not in the last read of entitlements.";
}

// A handled effect suppresses the success toast a plain view switch would raise.
function stayOnPeople() {
  return {
    ok: true as const,
    data: { effect: "open-surface" as const, surfaceId: ACCESS_SURFACE_ID, regionKey: PEOPLE_KEY },
  };
}

export const accessModule: RegionModule = {
  areas: [...ACCESS_AREAS, ...ACTIVITY_AREAS],
  composers: {
    [PULSE_KEY]: composeAccessPulse,
    [ATTENTION_KEY]: composeAttention,
    [ACTIVITY_KEY]: composeActivity,
    [ORGS_KEY]: composeOrgs,
    [PEOPLE_KEY]: composePeople,
    [PRINCIPALS_KEY]: composePrincipals,
    [COHORTS_KEY]: composeCohorts,
    [PERSON_KEY]: composePerson,
  },
  actions: {
    [SELECT_PERSON_ACTION]: selectPersonAction,
    [REFRESH_PERSON_ACTION]: async (rt, payload) => {
      const who = selectedIdentity(rt, payload);
      if (typeof who === "string") return { ok: false, error: who };
      if (rt.status.phase === "signin") return { ok: false, error: SIGNIN_REASON };
      if (rt.status.phase !== "connected") return { ok: false, error: "Not connected." };
      const error = await readGroups(rt, who.id);
      rt.recompose([PERSON_KEY]);
      return error ? { ok: false, error } : { ok: true };
    },
    [ACCEPT_EXTRAS_ACTION]: async (rt, payload) => {
      const who = selectedIdentity(rt, payload);
      if (typeof who === "string") return { ok: false, error: who };
      if (!personRead(rt, who.id)) return { ok: false, error: "Read this person's groups first." };
      const audit = personAudit(rt, who);
      if (!audit) return { ok: false, error: "The expected groups are not read yet." };
      const beyond = [...audit.extras, ...audit.baseline];
      if (audit.extras.length === 0) {
        return { ok: false, error: "No group beyond the expected set is left to accept." };
      }
      const n = audit.extras.length;
      const res = rt.tracker.setBaseline(
        who.id,
        beyond,
        rt.now(),
        `Accepted ${n} extra ${n === 1 ? "group" : "groups"} as baseline`,
      );
      if (!res.ok) return res;
      rt.recompose([PERSON_KEY]);
      const total = `${beyond.length} ${beyond.length === 1 ? "group" : "groups"}`;
      return { ok: true, data: { message: `${who.name}: ${total} in the baseline` } };
    },
    [PEOPLE_VIEW_ACTION]: async (rt, payload) => {
      const view = (payload as { view?: unknown } | undefined)?.view;
      if (!isPeopleView(view))
        return { ok: false, error: "Pick Roster, Roles matrix or Seismic grants." };
      peopleState(rt).view = view;
      rt.recompose([PEOPLE_KEY]);
      return stayOnPeople();
    },
    [PEOPLE_FILTER_ACTION]: async (rt, payload) => {
      const filter = (payload as { filter?: unknown } | undefined)?.filter;
      const cohorts = rt.tracker.cohorts.map((c) => `cohort:${c.name}`);
      const orgs = groupByOrg(measuredAccess(rt)?.model.people ?? []).map(
        (g) => `${ORG_FILTER}${g.org.domain}`,
      );
      const known = ["all", "apps", "pending", "gaps", "cohort:Untracked", ...cohorts, ...orgs];
      if (typeof filter !== "string" || !known.includes(filter)) {
        return { ok: false, error: "That filter is no longer available." };
      }
      // Picking the selected organization again clears it.
      const s = peopleState(rt);
      s.filter = filter.startsWith(ORG_FILTER) && s.filter === filter ? "all" : filter;
      rt.recompose([PEOPLE_KEY, ORGS_KEY]);
      return stayOnPeople();
    },
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
    [EXPORT_GUIDE_ACTION]: async (rt) => {
      const measured = measuredAccess(rt);
      if (!measured) return { ok: false, error: "People are not measured yet." };
      const day = rt.now().toISOString().slice(0, 10);
      const path = rt.writeExport(`who-has-access-${day}.md`, accessGuideMarkdown(measured));
      if (!path) return { ok: false, error: "The rib has no data directory to write to." };
      return { ok: true, data: { message: `Wrote ${path}` } };
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
