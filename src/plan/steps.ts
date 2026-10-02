// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { groupCount, type Identity } from "../access/model.ts";
import { GROUP_NAMES, type GroupKey } from "../access/read.ts";
import { shortId } from "../profile.ts";
import { REPLICATION_WAIT_MS, type Step } from "./model.ts";

export type RoleKey = "viewers" | "editors" | "admins";

export interface StepContext {
  domain: string;
  rosterGroupId?: string | undefined;
  closures?: Record<GroupKey, string[]> | undefined;
}

// Steps are numbered across the whole plan once every subject is built.
type Draft = Omit<Step, "n">;

const OID = "{oid}";
const INVITE_REDIRECT = "https://myapplications.microsoft.com";

export function groupEmail(key: GroupKey, domain: string): string {
  return `${GROUP_NAMES[key]}@${domain}`;
}

function shortGroup(key: GroupKey): string {
  return key === "users" ? "users@…" : `${GROUP_NAMES[key]}@…`;
}

function memberAdd(
  ctx: StepContext,
  subject: string,
  key: GroupKey,
  id: string,
  held: boolean,
): Draft {
  const path = `/groups/${encodeURIComponent(groupEmail(key, ctx.domain))}/members`;
  return {
    subject,
    kind: "member-add",
    text: `POST entitlements /groups/${shortGroup(key)}/members {email: ${id === OID ? "<oid>" : shortId(id)}, role: MEMBER}`,
    call: { service: "entitlements", method: "POST", path, body: { email: id, role: "MEMBER" } },
    change: true,
    ...(held ? { already: true } : {}),
  };
}

function memberRemove(ctx: StepContext, subject: string, key: GroupKey, member: string): Draft {
  const group = encodeURIComponent(groupEmail(key, ctx.domain));
  return {
    subject,
    kind: "member-remove",
    text: `DELETE entitlements /groups/${shortGroup(key)}/members/${member.includes("@") ? member : shortId(member)}`,
    call: {
      service: "entitlements",
      method: "DELETE",
      path: `/groups/${group}/members/${encodeURIComponent(member)}`,
    },
    change: true,
  };
}

function verify(
  ctx: StepContext,
  subject: string,
  id: string,
  held: Identity["memberships"],
): Draft {
  const expect = groupCount(held, ctx.closures)?.expected;
  return {
    subject,
    kind: "verify",
    text: `GET entitlements /members/${id === OID ? "<oid>" : shortId(id)}/groups${expect !== undefined ? `, expect ${expect}` : ""}`,
    call: {
      service: "entitlements",
      method: "GET",
      path: `/members/${encodeURIComponent(id)}/groups?type=NONE`,
    },
    change: false,
    ...(expect !== undefined ? { expect } : {}),
  };
}

function rosterAdd(ctx: StepContext, subject: string, id: string, already: boolean): Draft[] {
  if (!ctx.rosterGroupId) return [];
  return [
    {
      subject,
      kind: "roster-add",
      text: `POST graph /groups/${shortId(ctx.rosterGroupId)}/members/$ref`,
      call: {
        service: "graph",
        method: "POST",
        path: `/v1.0/groups/${ctx.rosterGroupId}/members/$ref`,
        body: { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${id}` },
      },
      change: true,
      ...(already ? { already: true } : {}),
    },
  ];
}

const wait = (subject: string): Draft => ({
  subject,
  kind: "wait",
  text: "wait 10 s for directory replication",
  change: false,
  waitMs: REPLICATION_WAIT_MS,
});

export interface AddTarget {
  address: string;
  // "invite" sends an invitation, "restore" restores a deleted account, "reuse" uses an existing one.
  via: "invite" | "restore" | "reuse";
  oid?: string;
  identity?: Identity;
}

export function addPersonSteps(ctx: StepContext, target: AddTarget, role: RoleKey): Draft[] {
  const { address, identity } = target;
  const id = target.oid ?? OID;
  const steps: Draft[] = [];
  if (target.via === "invite") {
    steps.push({
      subject: address,
      kind: "invite",
      text: "POST graph /v1.0/invitations (sends an email)",
      call: {
        service: "graph",
        method: "POST",
        path: "/v1.0/invitations",
        body: {
          invitedUserEmailAddress: address,
          inviteRedirectUrl: INVITE_REDIRECT,
          sendInvitationMessage: true,
        },
      },
      change: true,
    });
    steps.push(wait(address));
  } else if (target.via === "restore" && target.oid) {
    steps.push({
      subject: address,
      kind: "restore",
      text: `POST graph /directory/deletedItems/${shortId(target.oid)}/restore`,
      call: {
        service: "graph",
        method: "POST",
        path: `/v1.0/directory/deletedItems/${target.oid}/restore`,
      },
      change: true,
    });
    steps.push(wait(address));
  }
  const held = identity?.memberships ?? {};
  steps.push(...rosterAdd(ctx, address, id, identity?.inRoster === true));
  steps.push(memberAdd(ctx, address, "users", id, Boolean(held.users)));
  steps.push(memberAdd(ctx, address, role, id, Boolean(held[role])));
  steps.push(verify(ctx, address, id, { ...held, users: "M", [role]: held[role] ?? "M" }));
  return steps;
}

export function addAppSteps(
  ctx: StepContext,
  appId: string,
  role: RoleKey,
  existing?: Identity,
): Draft[] {
  const held = existing?.memberships ?? {};
  return [
    memberAdd(ctx, appId, "users", appId, Boolean(held.users)),
    memberAdd(ctx, appId, role, appId, Boolean(held[role])),
    verify(ctx, appId, appId, { ...held, users: "M", [role]: held[role] ?? "M" }),
  ];
}

export function fixUsersSteps(ctx: StepContext, person: Identity): Draft[] {
  const subject = person.email ?? person.id;
  return [
    memberAdd(ctx, subject, "users", person.id, Boolean(person.memberships.users)),
    verify(ctx, subject, person.id, { ...person.memberships, users: "M" }),
  ];
}

// Removes the second entry by email and keeps the one by object id.
export function cleanupDuplicateSteps(
  ctx: StepContext,
  person: Identity,
  emailForm: string,
): Draft[] {
  const subject = person.email ?? person.id;
  const group = person.duplicateIn;
  if (!group) return [];
  return [
    memberRemove(ctx, subject, group, emailForm),
    verify(ctx, subject, person.id, person.memberships),
  ];
}

// Role groups go first and users@ last; the Entra guest is kept.
export function removePersonSteps(ctx: StepContext, person: Identity): Draft[] {
  const subject = person.email ?? person.id;
  const order: GroupKey[] = ["ops", "admins", "editors", "viewers", "users"];
  const steps = order
    .filter((k) => person.memberships[k])
    .map((k) => memberRemove(ctx, subject, k, person.id));
  if (ctx.rosterGroupId && person.inRoster) {
    steps.push({
      subject,
      kind: "roster-remove",
      text: `DELETE graph /groups/${shortId(ctx.rosterGroupId)}/members/${shortId(person.id)}/$ref`,
      call: {
        service: "graph",
        method: "DELETE",
        path: `/v1.0/groups/${ctx.rosterGroupId}/members/${person.id}/$ref`,
      },
      change: true,
    });
  }
  return steps;
}
