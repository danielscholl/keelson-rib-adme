// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { shortId } from "../profile.ts";
import type { Step } from "./model.ts";

// Steps are numbered across the whole plan once every subject is built.
type Draft = Omit<Step, "n">;

function addTo(subject: string, email: string, label: string, id: string, held: boolean): Draft {
  return {
    subject,
    kind: "member-add",
    text: `POST entitlements /groups/${label}/members {email: ${shortId(id)}, role: MEMBER}`,
    call: {
      service: "entitlements",
      method: "POST",
      path: `/groups/${encodeURIComponent(email)}/members`,
      body: { email: id, role: "MEMBER" },
    },
    change: true,
    ...(held ? { already: true } : {}),
  };
}

function removeFrom(subject: string, email: string, label: string, member: string): Draft {
  return {
    subject,
    kind: "member-remove",
    text: `DELETE entitlements /groups/${label}/members/${shortId(member)}`,
    call: {
      service: "entitlements",
      method: "DELETE",
      path: `/groups/${encodeURIComponent(email)}/members/${encodeURIComponent(member)}`,
    },
    change: true,
  };
}

function readGroups(subject: string, id: string, expect: number): Draft {
  return {
    subject,
    kind: "verify",
    text: `GET entitlements /members/${shortId(id)}/groups, expect ${expect}`,
    call: {
      service: "entitlements",
      method: "GET",
      path: `/members/${encodeURIComponent(id)}/groups?type=NONE`,
    },
    change: false,
    expect,
  };
}

// data.sdms.<tenant>.<name>.<uuid>.<role>@domain, drawn with the uuid and domain cut.
export function shortSeismicGroup(email: string): string {
  const local = email.split("@")[0] ?? email;
  return `${local.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, (u) => `${u.slice(0, 4)}…${u.slice(-2)}`)}@…`;
}

export interface SeismicChange {
  group: string;
  held: boolean;
}

// `count` is the person's effective group count before the change, read at dry run.
export function seismicGrantSteps(
  subject: string,
  id: string,
  changes: readonly SeismicChange[],
  count: number,
): Draft[] {
  const adds = changes.filter((c) => !c.held).length;
  return [
    ...changes.map((c) => addTo(subject, c.group, shortSeismicGroup(c.group), id, c.held)),
    readGroups(subject, id, count + adds),
  ];
}

export function seismicRevokeSteps(
  subject: string,
  id: string,
  changes: readonly SeismicChange[],
  count: number,
): Draft[] {
  const removes = changes.filter((c) => c.held).length;
  return [
    ...changes.map((c) => ({
      ...removeFrom(subject, c.group, shortSeismicGroup(c.group), id),
      ...(c.held ? {} : { already: true }),
    })),
    readGroups(subject, id, count - removes),
  ];
}
