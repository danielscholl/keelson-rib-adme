// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { cleanupDuplicateSteps, fixUsersSteps, type StepContext } from "../plan/steps.ts";
import { instanceName, type Profile, shortId } from "../profile.ts";
import type { Runtime } from "../runtime.ts";
import { groupCount, type Identity, type Role } from "./model.ts";
import { GROUP_KEYS, GROUP_NAMES, type GroupKey } from "./read.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skipped" | "unchecked";

export interface Check {
  label: string;
  status: CheckStatus;
  trailing: string;
  detail?: string;
}

export interface Verdict {
  // The HTTP status the person sees, or undefined when nothing in access fails.
  code?: "401" | "403";
  label: string;
  // The reason without the code, for the recent answers list.
  reason: string;
}

export interface ExplainFix {
  kind: "fix-users" | "cleanup-duplicate";
  title: string;
  changes: number;
  lines: string[];
  reason: string;
}

export interface Explanation {
  id: string;
  name: string;
  email?: string;
  at: string;
  // "live" when the effective groups came from a read made for this answer.
  source: "live" | "cached";
  sweptAt?: string;
  sourceNote?: string;
  checks: Check[];
  verdict: Verdict;
  fix?: ExplainFix;
  // Shown when there is no plan to hand off: what changes, and on whose side.
  advice?: string;
  note: string;
}

export interface Evidence {
  source: "live" | "cached";
  // Effective group emails, lowercased; undefined when neither read can tell.
  groups?: string[];
  sweptAt?: string;
  failure?: string;
}

export interface ExplainInput {
  person: Identity;
  profile: Profile;
  domain: string;
  closures: Record<GroupKey, string[]> | undefined;
  evidence: Evidence;
  now: Date;
}

const ROLE_GROUP: Record<Role, GroupKey> = {
  Ops: "ops",
  Admin: "admins",
  Editor: "editors",
  Viewer: "viewers",
};

const NOT_REACHED = "not reached";
const USERS_REASON = "not a member of users@";

export function cachedGroups(
  person: Identity,
  closures: Record<GroupKey, string[]> | undefined,
): string[] | undefined {
  if (!closures) return undefined;
  const held = GROUP_KEYS.filter((k) => person.memberships[k]);
  return [...new Set(held.flatMap((k) => closures[k]))];
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

function day(iso: string | undefined): string | undefined {
  return iso?.slice(0, 10);
}

function groupsPhrase(evidence: Evidence, held: number): string {
  return evidence.source === "live"
    ? `The effective groups read returned ${held} groups`
    : `The last sweep gives ${held} effective groups`;
}

function signInCheck(input: ExplainInput): Check {
  const { person, profile } = input;
  const who = person.email ?? person.name;
  const label = `Can sign in to the tenant as ${who}`;
  if (person.invitedAt) {
    return {
      label,
      status: "fail",
      trailing: "this is the cause",
      detail: `The invitation sent ${day(person.invitedAt)} is not accepted. Until ${firstName(person.name)} accepts it, Entra does not let this guest sign in to the tenant, so every call returns 401 before ADME looks at any group.`,
    };
  }
  return { label, status: "pass", trailing: `tenant ${shortId(profile.tenantId)}` };
}

function usersCheck(input: ExplainInput, users: string, effective: Set<string> | undefined) {
  const { person, closures, evidence } = input;
  const label = `Member of ${users}`;
  const member = effective ? effective.has(users) : Boolean(person.memberships.users);
  if (member) {
    return {
      label,
      status: "pass" as const,
      trailing: evidence.source === "live" ? "in effective groups" : "in the last sweep",
    };
  }
  const expected = groupCount({ ...person.memberships, users: "M" }, closures)?.expected;
  const count =
    effective && expected !== undefined
      ? `${groupsPhrase(evidence, effective.size)} where ${expected} are expected${person.role ? ` for ${person.role}` : ""}. `
      : "";
  return {
    label,
    status: "fail" as const,
    trailing: "this is the cause",
    detail: `${count}The missing group is ${users}. Entitlements rejects any caller outside users@ with 401 before roles are read.`,
  };
}

function roleCheck(input: ExplainInput, domain: string, effective: Set<string> | undefined) {
  const { person, closures, evidence } = input;
  const label = "Role group grants the service role";
  const roleKey = person.role ? ROLE_GROUP[person.role] : undefined;
  const roleGroup = roleKey ? `${GROUP_NAMES[roleKey]}@${domain}` : undefined;
  const hasRole = roleGroup ? (effective ? effective.has(roleGroup) : true) : false;
  if (!roleKey || !hasRole) {
    return {
      label,
      status: "fail" as const,
      trailing: "this is the cause",
      detail: `${person.name} is in users@ but in no users.datalake role group, so each service refuses the call with 403: users@ only lets a caller in, the role group is what grants a service role.`,
    };
  }
  const expected = groupCount(person.memberships, closures)?.expected;
  const held = effective?.size;
  const counted = held !== undefined && expected !== undefined ? ` · ${held} of ${expected}` : "";
  if (person.duplicateIn) {
    return {
      label,
      status: "warn" as const,
      trailing: "duplicate entry, not the cause",
      detail: `${GROUP_NAMES[person.duplicateIn]} lists ${person.name} twice, once by object id and once by email. Entitlements accepts either form, so this does not cause a 401 or 403. The extra entry is worth cleaning up.`,
    };
  }
  if (held !== undefined && expected !== undefined && held < expected) {
    return {
      label,
      status: "warn" as const,
      trailing: `${GROUP_NAMES[roleKey]}${counted}`,
      detail: `${groupsPhrase(evidence, held)} where ${expected} are expected for ${person.role}. A service whose group is among the missing ones answers 403.`,
    };
  }
  return { label, status: "pass" as const, trailing: `${GROUP_NAMES[roleKey]}${counted}` };
}

const CHECK_SIGN_IN = 0;
const CHECK_USERS = 3;
const CHECK_ROLE = 4;

function verdictOf(failed: number, person: Identity): Verdict {
  const v = (code: "401" | "403", reason: string): Verdict => ({
    code,
    label: `${code}: ${reason}`,
    reason,
  });
  if (failed === CHECK_SIGN_IN) return v("401", "invitation not accepted, cannot sign in yet");
  if (failed === CHECK_USERS) return v("401", USERS_REASON);
  if (failed === CHECK_ROLE) return v("403", "in no role group");
  const reason = person.duplicateIn
    ? "nothing in access fails; a duplicate entry to tidy"
    : "nothing in access fails up to the record ACL";
  return { label: "no cause in access", reason };
}

function stepContext(input: ExplainInput, domain: string): StepContext {
  return {
    domain,
    rosterGroupId: input.profile.rosterGroupId,
    closures: input.closures,
  };
}

function fixOf(
  input: ExplainInput,
  domain: string,
  verdict: Verdict,
): { fix?: ExplainFix; advice?: string } {
  const { person } = input;
  const sc = stepContext(input, domain);
  if (verdict.reason === USERS_REASON) {
    const steps = fixUsersSteps(sc, person);
    const role = person.role ? GROUP_NAMES[ROLE_GROUP[person.role]] : "a role group";
    return {
      fix: {
        kind: "fix-users",
        title: `Add ${person.name} to users@`,
        changes: steps.filter((s) => s.change && !s.already).length,
        lines: steps.map((s) => s.text),
        reason: `member of ${role} but not users@.`,
      },
    };
  }
  if (verdict.code === "401") {
    return {
      advice: `Nothing to change on this side. ${firstName(person.name)} accepts the invitation sent ${day(person.invitedAt)}, then signs in.`,
    };
  }
  if (verdict.code === "403") {
    return { advice: `Add ${person.name} to a role group with Add people.` };
  }
  if (person.duplicateIn && person.email) {
    const steps = cleanupDuplicateSteps(sc, person, person.email.toLowerCase());
    return {
      fix: {
        kind: "cleanup-duplicate",
        title: `Remove ${person.name}'s duplicate entry`,
        changes: steps.filter((s) => s.change && !s.already).length,
        lines: steps.map((s) => s.text),
        reason: "a warning, not the cause of a 401 or 403.",
      },
    };
  }
  return {};
}

function noteFor(input: ExplainInput, verdict: Verdict, expected: number | undefined): string {
  const { person, profile } = input;
  const hi = `Hi ${firstName(person.name)},`;
  const instance = instanceName(profile);
  const base = `the base users group for partition ${profile.partition}`;
  const covers =
    person.role && expected !== undefined
      ? ` Your ${person.role} access then covers ${expected} groups.`
      : "";
  if (verdict.code === "401" && person.invitedAt) {
    return `${hi} your access to ${instance} is set up, but the invitation sent on ${day(person.invitedAt)} has not been accepted yet, so you cannot sign in and every call returns 401. Open the invitation email from Microsoft and accept it, then sign in and retry. If you cannot find the email, tell me and I will send it again.`;
  }
  if (verdict.code === "401") {
    return `${hi} your sign-in to ${instance} works. The 401 you see on every call is on our side: your account is in the ${person.role ?? "role"} role group but is missing from ${base}. You do not need a new invitation or a new account. I am adding you now. When I confirm, sign in again with az login and retry.${covers}`;
  }
  if (verdict.code === "403") {
    return `${hi} you can sign in to ${instance} and you are in ${base}, but no role group gives you a service role yet, so calls return 403. I am adding you to one now. When I confirm, sign in again with az login and retry.`;
  }
  return `${hi} your access to ${instance} checks out: you can sign in and you are in ${base}${person.role ? ` and the ${person.role} role group` : ""}. If a call still returns 403, send me the record id or the seismic subproject and I will check its access list.`;
}

// The checks in the order the platform applies them; the first failure is the verdict.
export function explain(input: ExplainInput): Explanation {
  const { person, profile, evidence, domain } = input;
  const effective = evidence.groups ? new Set(evidence.groups) : undefined;
  const all: Check[] = [
    signInCheck(input),
    {
      label: `Request reaches the ADME app (${shortId(profile.admeAppId)})`,
      status: "pass",
      trailing: "app id matches",
    },
    {
      label: `data-partition-id is ${profile.partition}`,
      status: "pass",
      trailing: "header present",
    },
    usersCheck(input, `users@${domain}`, effective),
    roleCheck(input, domain, effective),
    {
      label: "Record ACL intersects effective groups",
      status: "unchecked",
      trailing: "not checked: needs a record id",
    },
    {
      label: "Seismic subproject ACL",
      status: "unchecked",
      trailing: "not checked: needs a subproject",
    },
  ];
  const failed = all.findIndex((c) => c.status === "fail");
  const checks =
    failed < 0
      ? all
      : all.map(
          (c, i): Check =>
            i > failed ? { label: c.label, status: "skipped", trailing: NOT_REACHED } : c,
        );
  const verdict = verdictOf(failed, person);
  const expected = groupCount({ ...person.memberships, users: "M" }, input.closures)?.expected;
  return {
    id: person.id,
    name: person.name,
    ...(person.email ? { email: person.email } : {}),
    at: input.now.toISOString(),
    source: evidence.source,
    ...(evidence.sweptAt ? { sweptAt: evidence.sweptAt } : {}),
    ...(evidence.failure ? { sourceNote: evidence.failure } : {}),
    checks,
    verdict,
    ...fixOf(input, domain, verdict),
    note: noteFor(input, verdict, expected),
  };
}

const RECENT_LIMIT = 5;
const answers = new WeakMap<Runtime, Explanation[]>();

// Newest first; the head is the answer on screen, the rest are recent answers.
export function explanations(rt: Runtime): readonly Explanation[] {
  return answers.get(rt) ?? [];
}

export function recordExplanation(rt: Runtime, e: Explanation): void {
  const kept = explanations(rt).filter((x) => x.id !== e.id);
  answers.set(rt, [e, ...kept].slice(0, RECENT_LIMIT + 1));
}
