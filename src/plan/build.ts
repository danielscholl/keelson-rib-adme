// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { AccessModel, Identity } from "../access/model.ts";
import type { GroupKey } from "../access/read.ts";
import type { Batch, CallResult } from "../client.ts";
import type { Profile } from "../profile.ts";
import { type Classified, classifyAddress, parseAddresses } from "./classify.ts";
import {
  bindingOf,
  type DraftSubject,
  type Excluded,
  finishPlan,
  numberSteps,
  type Plan,
  type PlanKind,
} from "./model.ts";
import {
  addAppSteps,
  addPersonSteps,
  cleanupDuplicateSteps,
  fixUsersSteps,
  type RoleKey,
  removePersonSteps,
  type StepContext,
} from "./steps.ts";

export const ROLE_KEYS: Record<string, RoleKey> = {
  Viewer: "viewers",
  Editor: "editors",
  Admin: "admins",
};

export interface BuildContext {
  profile: Profile;
  model: AccessModel | undefined;
  closures: Record<GroupKey, string[]> | undefined;
  now: Date;
}

export type PlanInputs =
  | { kind: "add-people"; emails: string; role: string; cohort?: string; passEnds?: string }
  | { kind: "add-app"; appId: string; role: string }
  | { kind: "fix-users"; id: string }
  | { kind: "cleanup-duplicate"; id: string }
  | { kind: "remove-person"; id: string };

function stepContext(ctx: BuildContext): StepContext | string {
  const domain = ctx.profile.entitlementsDomain;
  if (!domain) return "The entitlements domain is not read yet; Re-test the connection.";
  return { domain, rosterGroupId: ctx.profile.rosterGroupId, closures: ctx.closures };
}

function fail<T>(message: string): CallResult<T> {
  return { ok: false, failure: { kind: "client", status: null, message } };
}

function done(
  ctx: BuildContext,
  kind: PlanKind,
  title: string,
  inputs: PlanInputs,
  subjects: DraftSubject[],
  excluded: Excluded[] = [],
): CallResult<Plan> {
  const draft = {
    kind,
    title,
    binding: bindingOf(ctx.profile),
    inputs: { ...inputs },
    subjects: numberSteps(subjects),
    excluded,
  };
  return { ok: true, status: 200, data: finishPlan(draft, ctx.now) };
}

function knownDomains(model: AccessModel | undefined): Set<string> {
  return new Set(
    (model?.people ?? []).flatMap((p) => p.email?.toLowerCase().split("@").slice(1) ?? []),
  );
}

const CLASS_PILL: Record<string, string> = {
  "will-invite": "invite",
  restorable: "restore",
};

function addSubject(
  c: Classified,
  sc: StepContext,
  role: RoleKey,
  domains: Set<string>,
): DraftSubject {
  const domain = c.address.split("@")[1] ?? "";
  const footnote =
    c.classification === "will-invite" && !domains.has(domain)
      ? `first-seen domain ${domain}`
      : undefined;
  if (c.blocked) {
    return {
      address: c.address,
      classification: c.classification,
      ...(c.oid ? { oid: c.oid } : {}),
      ...(c.name ? { name: c.name } : {}),
      blocked: true,
      ...(c.reason ? { reason: c.reason } : {}),
      steps: [],
    };
  }
  const via = (CLASS_PILL[c.classification] ?? "reuse") as "invite" | "restore" | "reuse";
  const steps = addPersonSteps(
    sc,
    {
      address: c.address,
      via,
      ...(c.oid ? { oid: c.oid } : {}),
      ...(c.identity ? { identity: c.identity } : {}),
    },
    role,
  );
  return {
    address: c.address,
    classification: c.classification,
    ...(c.oid ? { oid: c.oid } : {}),
    ...(c.name ? { name: c.name } : {}),
    blocked: false,
    steps,
    ...(footnote ? { footnote } : {}),
  };
}

export async function buildPlan(
  batch: Batch,
  inputs: PlanInputs,
  ctx: BuildContext,
): Promise<CallResult<Plan>> {
  const sc = stepContext(ctx);
  if (typeof sc === "string") return fail(sc);
  switch (inputs.kind) {
    case "add-people": {
      const role = ROLE_KEYS[inputs.role];
      if (!role) return fail("Pick Viewer, Editor or Admin.");
      const { addresses, excluded } = parseAddresses(inputs.emails);
      if (addresses.length === 0) return fail("Enter at least one email address.");
      const subjects: DraftSubject[] = [];
      const domains = knownDomains(ctx.model);
      for (const address of addresses) {
        const c = await classifyAddress(batch, address, ctx.model);
        if (!c.ok) return c;
        subjects.push(addSubject(c.data, sc, role, domains));
      }
      const n = addresses.length;
      const where = inputs.cohort ? ` to ${inputs.cohort}` : ` as ${inputs.role}`;
      return done(
        ctx,
        "add-people",
        `add ${n} ${n === 1 ? "person" : "people"}${where}`,
        inputs,
        subjects,
        excluded,
      );
    }
    case "add-app": {
      const role = ROLE_KEYS[inputs.role];
      if (!role) return fail("Pick Viewer, Editor or Admin.");
      const appId = inputs.appId.trim().toLowerCase();
      const sp = await batch.graph<{ value?: { appId?: string; displayName?: string }[] }>(
        `/v1.0/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${appId.replace(/'/g, "''")}'`)}&$select=appId,displayName`,
      );
      if (!sp.ok) return sp;
      const found = sp.data.value?.[0];
      if (!found)
        return fail("No application with that app id has a service principal in this tenant.");
      const existing = ctx.model?.apps.find((a) => (a.appId ?? a.id) === appId);
      const subject: DraftSubject = {
        address: appId,
        classification: "application",
        ...(found.displayName ? { name: found.displayName } : {}),
        blocked: false,
        steps: addAppSteps(sc, appId, role, existing),
      };
      return done(ctx, "add-app", `add ${found.displayName ?? appId} as ${inputs.role}`, inputs, [
        subject,
      ]);
    }
    default: {
      const person = ctx.model?.people.find((p) => p.id === inputs.id);
      if (!person) return fail("That person is not in the last sweep. Refresh and try again.");
      return personPlan(ctx, sc, inputs, person);
    }
  }
}

function personPlan(
  ctx: BuildContext,
  sc: StepContext,
  inputs: Extract<PlanInputs, { id: string }>,
  person: Identity,
): CallResult<Plan> {
  const base = {
    address: person.email ?? person.id,
    classification: "has-access" as const,
    oid: person.id,
    name: person.name,
    blocked: false,
  };
  if (inputs.kind === "fix-users") {
    const steps = fixUsersSteps(sc, person);
    return done(ctx, "fix-users", `add ${person.name} to users@`, inputs, [{ ...base, steps }]);
  }
  if (inputs.kind === "cleanup-duplicate") {
    if (!person.duplicateIn || !person.email) return fail(`${person.name} has no duplicate entry.`);
    const steps = cleanupDuplicateSteps(sc, person, person.email.toLowerCase()).map((t) => ({
      ...t,
      n: 0,
    }));
    return done(ctx, "cleanup-duplicate", `remove ${person.name}'s duplicate entry`, inputs, [
      { ...base, steps },
    ]);
  }
  const steps = removePersonSteps(sc, person);
  return done(ctx, "remove-person", `remove ${person.name}`, inputs, [{ ...base, steps }]);
}
