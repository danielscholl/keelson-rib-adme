// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { AccessModel, Identity } from "../access/model.ts";
import type { Batch, CallResult } from "../client.ts";
import type { SeismicModel, SeisRole, SubprojectView } from "../seismic/model.ts";
import { andList, hasDataRole } from "../seismic/reach.ts";
import { isDefaultGroup } from "../seismic/read.ts";
import type { DraftSubject } from "./model.ts";
import { type SeismicChange, seismicGrantSteps, seismicRevokeSteps } from "./steps.ts";

export type SeismicInputs =
  | { kind: "seismic-grant"; id: string; subproject: string; role: SeisRole }
  | { kind: "seismic-revoke"; id: string; subproject: string; role: SeisRole }
  | { kind: "seismic-copy"; from: string; to: string };

export interface SeismicPlanContext {
  model: AccessModel | undefined;
  seismic: SeismicModel | undefined;
  admeAppId: string;
}

export interface SeismicDraft {
  title: string;
  subjects: DraftSubject[];
}

function fail<T>(message: string): CallResult<T> {
  return { ok: false, failure: { kind: "client", status: null, message } };
}

function ok<T>(data: T): CallResult<T> {
  return { ok: true, status: 200, data };
}

function local(email: string): string {
  return email.split("@")[0] ?? email;
}

function groupsOf(s: SubprojectView, role: SeisRole): string[] {
  return role === "admin" ? s.adminGroups : s.viewerGroups;
}

// Subprojects by ACL group email; a group several subprojects share lists all of them.
export function coverage(seismic: SeismicModel): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of seismic.subprojects) {
    for (const g of [...s.adminGroups, ...s.viewerGroups]) {
      if (isDefaultGroup(g)) continue;
      const list = out.get(g) ?? [];
      if (!list.includes(s.name)) list.push(s.name);
      out.set(g, list);
    }
  }
  return out;
}

interface Held {
  emails: Set<string>;
  count: number;
}

async function effectiveGroups(batch: Batch, id: string): Promise<CallResult<Held>> {
  const res = await batch.adme<{ groups?: { email?: string }[] }>(
    "entitlements",
    `/members/${encodeURIComponent(id)}/groups?type=NONE`,
  );
  if (!res.ok) return res;
  const groups = res.data.groups ?? [];
  return ok({
    emails: new Set(groups.flatMap((g) => (g.email ? [g.email.toLowerCase()] : []))),
    count: groups.length,
  });
}

function personOf(ctx: SeismicPlanContext, id: string): Identity | string {
  if (id === ctx.admeAppId.toLowerCase() || id.startsWith("users.data.root@")) {
    return "Every seismic group lists that member by design; it is never changed.";
  }
  const person = ctx.model?.people.find((p) => p.id === id);
  return person ?? "That person is not in the last sweep. Refresh and try again.";
}

function subjectOf(person: Identity): Omit<DraftSubject, "steps" | "blocked"> {
  return {
    address: person.email ?? person.id,
    classification: "has-access",
    oid: person.id,
    name: person.name,
  };
}

function defaultRefusal(
  seismic: SeismicModel,
  person: Identity,
  s: SubprojectView,
  role: SeisRole,
  verb: "grant" | "revoke",
): string {
  const group = local(groupsOf(s, role).find(isDefaultGroup) ?? "data.default");
  const all = seismic.subprojects.filter((x) => groupsOf(x, role).some(isDefaultGroup));
  const names = andList(all.map((x) => x.name));
  const what = verb === "grant" ? `Adding ${person.name} to` : `Removing ${person.name} from`;
  return `${s.name} ${role}s come through ${group}. ${what} ${group} would change every default-ACL subproject at once (${names}), so the rib does not plan it.`;
}

function sharedNote(cover: Map<string, string[]>, groups: readonly string[]): string | undefined {
  const names = [...new Set(groups.flatMap((g) => cover.get(g) ?? []))];
  return names.length > 1
    ? `This group is shared by ${andList(names)}; the change reaches all of them.`
    : undefined;
}

function revokeNote(
  person: Identity,
  s: SubprojectView,
  role: SeisRole,
  held: Held,
  changes: readonly SeismicChange[],
): string {
  if (!changes.some((c) => c.held))
    return `${person.name} is not in this group; nothing to remove.`;
  const other: SeisRole = role === "admin" ? "viewer" : "admin";
  const otherGroups = groupsOf(s, other);
  if (otherGroups.some((g) => !isDefaultGroup(g) && held.emails.has(g))) {
    return `${person.name} stays ${other} on ${s.name}.`;
  }
  if (other === "viewer" && otherGroups.some(isDefaultGroup) && hasDataRole(person)) {
    return `This is ${person.name}'s last grant on ${s.name}, which is fine: they still read it as viewer through ${local(otherGroups.find(isDefaultGroup) as string)}.`;
  }
  return `After this, ${person.name} no longer reaches ${s.name}.`;
}

async function grantOrRevoke(
  batch: Batch,
  inputs: Extract<SeismicInputs, { subproject: string }>,
  ctx: SeismicPlanContext,
  seismic: SeismicModel,
): Promise<CallResult<SeismicDraft>> {
  const person = personOf(ctx, inputs.id);
  if (typeof person === "string") return fail(person);
  const s = seismic.subprojects.find((x) => x.name === inputs.subproject);
  if (!s) return fail("That subproject is no longer listed. Refresh now.");
  const grant = inputs.kind === "seismic-grant";
  const title = grant
    ? `grant ${person.name} ${inputs.role} on ${s.name}`
    : `revoke ${person.name}'s ${inputs.role} on ${s.name}`;
  const groups = groupsOf(s, inputs.role);
  if (groups.some(isDefaultGroup)) {
    const reason = defaultRefusal(seismic, person, s, inputs.role, grant ? "grant" : "revoke");
    return ok({ title, subjects: [{ ...subjectOf(person), blocked: true, reason, steps: [] }] });
  }
  if (groups.length === 0) return fail(`The ${inputs.role} group of ${s.name} is not known.`);
  const held = await effectiveGroups(batch, person.id);
  if (!held.ok) return held;
  const changes = groups.map((group) => ({ group, held: held.data.emails.has(group) }));
  const steps = grant
    ? seismicGrantSteps(subjectOf(person).address, person.id, changes, held.data.count)
    : seismicRevokeSteps(subjectOf(person).address, person.id, changes, held.data.count);
  const notes = [
    sharedNote(coverage(seismic), groups),
    ...(grant ? [] : [revokeNote(person, s, inputs.role, held.data, changes)]),
  ].filter((n): n is string => Boolean(n));
  return ok({
    title,
    subjects: [
      {
        ...subjectOf(person),
        blocked: false,
        ...(notes.length > 0 ? { reason: notes.join(" ") } : {}),
        steps,
      },
    ],
  });
}

async function copy(
  batch: Batch,
  inputs: Extract<SeismicInputs, { kind: "seismic-copy" }>,
  ctx: SeismicPlanContext,
  seismic: SeismicModel,
): Promise<CallResult<SeismicDraft>> {
  if (inputs.from === inputs.to) return fail("Pick two different people.");
  const from = personOf(ctx, inputs.from);
  if (typeof from === "string") return fail(from);
  const to = personOf(ctx, inputs.to);
  if (typeof to === "string") return fail(to);
  const cover = coverage(seismic);
  const source = await effectiveGroups(batch, from.id);
  if (!source.ok) return source;
  const target = await effectiveGroups(batch, to.id);
  if (!target.ok) return target;
  const roleOf = new Map<string, SeisRole>();
  for (const s of seismic.subprojects) {
    for (const g of s.adminGroups) roleOf.set(g, "admin");
    for (const g of s.viewerGroups) if (!roleOf.has(g)) roleOf.set(g, "viewer");
  }
  const groups = [...cover.keys()].filter((g) => source.data.emails.has(g));
  if (groups.length === 0) return fail(`${from.name} holds no seismic grant to copy.`);
  const changes = groups.map((group) => ({ group, held: target.data.emails.has(group) }));
  const label = (g: string) => `${andList(cover.get(g) ?? [])} ${roleOf.get(g)}`;
  const adds = changes.filter((c) => !c.held).map((c) => label(c.group));
  const kept = changes.filter((c) => c.held).map((c) => label(c.group));
  const notes = [
    `Copies ${from.name}'s grants: ${andList(groups.map(label))}.`,
    ...(kept.length > 0 ? [`${to.name} already holds ${andList(kept)}.`] : []),
    ...(adds.length > 0 ? [] : ["Nothing to add."]),
    ...(seismic.subprojects.some((s) => s.acl === "default")
      ? ["Reach through data.default comes with the data role and is not copied."]
      : []),
  ];
  return ok({
    title: `copy ${from.name}'s seismic grants to ${to.name}`,
    subjects: [
      {
        ...subjectOf(to),
        blocked: false,
        reason: notes.join(" "),
        steps: seismicGrantSteps(subjectOf(to).address, to.id, changes, target.data.count),
      },
    ],
  });
}

export function seismicPlan(
  batch: Batch,
  inputs: SeismicInputs,
  ctx: SeismicPlanContext,
): Promise<CallResult<SeismicDraft>> {
  const seismic = ctx.seismic;
  if (!seismic) {
    return Promise.resolve(fail("Seismic subprojects are not read yet. Open the Seismic section."));
  }
  return inputs.kind === "seismic-copy"
    ? copy(batch, inputs, ctx, seismic)
    : grantOrRevoke(batch, inputs, ctx, seismic);
}
