// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import {
  type AccessCounts,
  type AccessModel,
  buildAccess,
  countAccess,
  type Identity,
  ROLES,
} from "../access/model.ts";
import { ACCESS_AREA, type AccessRead, GROUP_NAMES } from "../access/read.ts";
import { instanceName } from "../profile.ts";
import { composeRestingHeader, EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { signinCard } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];

const ROSTER_LIMIT = 25;
const ROLE_TONE = { Ops: "info", Admin: "brand", Editor: "accent", Viewer: "neutral" } as const;
const DAY_MS = 86_400_000;

export interface Measured {
  model: AccessModel;
  counts: AccessCounts;
}

export function measuredAccess(rt: Runtime): Measured | undefined {
  const read = rt.cache.get<AccessRead>(ACCESS_AREA).data;
  if (!read || rt.status.phase === "firstrun" || rt.status.phase === "profile-error") {
    return undefined;
  }
  const model = buildAccess(read, {
    signedInAs: rt.status.test?.signedInAs,
    admeAppId: rt.profile?.admeAppId,
  });
  return { model, counts: countAccess(model) };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function day(iso: string | undefined): string | undefined {
  return iso?.slice(0, 10);
}

function daysAgo(iso: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS));
  return days === 0 ? "today" : `${days} d ago`;
}

function needsPill(counts: AccessCounts) {
  return counts.needsYou > 0
    ? { label: `${counts.needsYou} need you`, tone: "caution" as const }
    : { label: "all healthy", tone: "ok" as const };
}

function stateSegments(counts: AccessCounts) {
  return [
    { label: "healthy", n: counts.healthy, tone: "ok" as const },
    { label: "pending", n: counts.pending, tone: "warn" as const },
    { label: "broken", n: counts.broken, tone: "error" as const },
    ...(counts.unknown > 0
      ? [{ label: "unknown", n: counts.unknown, tone: "caution" as const }]
      : []),
  ];
}

export function composeAccessPulse(rt: Runtime): CanvasBoardView {
  const signedInAs = rt.status.test?.signedInAs;
  const resting = () =>
    composeRestingHeader(rt.status, {
      firstRunHere: true,
      discovery: rt.discovery,
      connectedText: `Connected${signedInAs ? ` as ${signedInAs}` : ""}.`,
    });
  const measured = measuredAccess(rt);
  const profile = rt.profile;
  if (!profile) return resting();
  if (!measured) {
    const view = resting();
    const error = rt.cache.get(ACCESS_AREA).error;
    if (rt.status.phase !== "connected") return view;
    return {
      ...view,
      sections: [
        ...view.sections,
        {
          kind: "rows",
          items: [
            error
              ? { glyph: "error", text: `People and applications could not be read: ${error}` }
              : { glyph: "neutral", text: "People and applications are not measured yet." },
          ],
        },
      ],
    };
  }
  const { counts } = measured;
  const gaps = [
    counts.missingUsers > 0 ? `${counts.missingUsers} missing users@` : "",
    counts.duplicates > 0 ? plural(counts.duplicates, "duplicate entry", "duplicate entries") : "",
  ].filter(Boolean);
  const stats: Stat[] = [
    {
      label: "People",
      value: counts.people,
      sub: `${plural(counts.guests, "guest", "guests")} · ${plural(counts.people - counts.guests, "member", "members")}`,
    },
    {
      label: "Pending acceptance",
      value: counts.pending,
      sub: counts.oldestInvite ? `oldest invited ${day(counts.oldestInvite)}` : "none waiting",
      ...(counts.pending > 0 ? { tone: "warn" as const } : {}),
    },
    {
      label: "Access gaps",
      value: counts.broken,
      sub: gaps.join(" · ") || "none found",
      ...(counts.broken > 0 ? { tone: "error" as const } : {}),
    },
    { label: "Next pass ends", value: null, sub: "no cohort is tracked yet" },
    {
      label: "Applications",
      value: counts.apps,
      sub: counts.rootApps > 0 ? `${counts.rootApps} legacy root app` : "with entitlements",
    },
  ];
  const sections: Section[] = [];
  if (rt.status.phase === "signin") sections.push(signinCard(rt.status));
  sections.push({ kind: "stats", items: stats });
  const mix: { label: string; n: number; tone?: "info" | "brand" | "accent" | "neutral" }[] =
    ROLES.filter((r) => counts.roles[r] > 0).map((r) => ({
      label: r,
      n: counts.roles[r],
      tone: ROLE_TONE[r],
    }));
  if (counts.noRole > 0) mix.push({ label: "No role", n: counts.noRole });
  if (mix.length > 0) sections.push({ kind: "segments", title: "Role mix", items: mix });
  const fresh = rt.freshness(ACCESS_AREA);
  const last = rt.cache.get(ACCESS_AREA);
  if (last.error) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "warn",
          text: `Last read failed${last.errorAt ? ` at ${clock(last.errorAt)}` : ""}: ${last.error}`,
          trailing: `showing ${clock(last.at)}`,
        },
      ],
    });
  }
  return {
    view: "board",
    header: {
      status:
        rt.status.phase === "signin"
          ? { label: "sign-in needed", tone: "error" }
          : needsPill(counts),
      chip: [instanceName(profile), profile.partition, fresh].filter(Boolean).join(" · "),
      segments: stateSegments(counts),
    },
    sections,
  };
}

function personFields(p: Identity): NonNullable<Card["fields"]> {
  return [
    ...(p.email ? [{ label: "Email", value: p.email, copyable: true }] : []),
    { label: "Role", value: p.role ?? "none" },
  ];
}

function attentionCards(people: Identity[], now: Date): Section[] {
  const missing = people.filter((p) => p.cause === "missing-users");
  const pending = people.filter((p) => p.state === "pending");
  const duplicate = people.filter((p) => p.duplicateIn !== undefined);
  const sections: Section[] = [];
  if (missing.length > 0) {
    sections.push({
      kind: "cards",
      title: `Not in users@, every call returns 401 · ${missing.length}`,
      items: missing.map((p) => ({
        title: p.name,
        edge: "error" as const,
        pill: { label: "401", tone: "error" as const },
        fields: personFields(p),
        footnote: `member of ${GROUP_NAMES[roleGroup(p)]} but not users@`,
      })),
    });
  }
  if (pending.length > 0) {
    sections.push({
      kind: "cards",
      title: `Invited, not accepted · ${pending.length}`,
      items: pending.map((p) => ({
        title: p.name,
        edge: "warn" as const,
        pill: { label: "pending", tone: "warn" as const },
        fields: [
          ...(p.email ? [{ label: "Email", value: p.email, copyable: true }] : []),
          { label: "Invited", value: p.invitedAt ? daysAgo(p.invitedAt, now) : "?" },
        ],
      })),
    });
  }
  if (duplicate.length > 0) {
    sections.push({
      kind: "cards",
      title: `Duplicate member entry · ${duplicate.length}`,
      items: duplicate.map((p) => ({
        title: p.name,
        edge: "warn" as const,
        pill: { label: "duplicate", tone: "warn" as const },
        fields: personFields(p),
        footnote: `email form and object id form are both in ${GROUP_NAMES[p.duplicateIn ?? "users"]}`,
      })),
    });
  }
  return sections;
}

function roleGroup(p: Identity): "ops" | "admins" | "editors" | "viewers" {
  for (const key of ["ops", "admins", "editors", "viewers"] as const) {
    if (p.memberships[key]) return key;
  }
  return "viewers";
}

export function composeAttention(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const { model, counts } = measured;
  const sections = attentionCards(model.people, rt.now());
  if (sections.length === 0 && model.unknown.length === 0) {
    sections.push({ kind: "rows", items: [{ glyph: "ok", text: "Nothing needs you." }] });
  }
  if (model.unknown.length > 0) {
    sections.push({
      kind: "rows",
      title: `Unknown principals · ${model.unknown.length}`,
      items: model.unknown.map((u) => ({
        glyph: "warn" as const,
        text: u.name,
        trailing: `${u.role ?? "no role"} · ${u.id.includes("@") ? "listed by email, not resolved" : "not found in Entra"}`,
      })),
    });
  }
  sections.push({
    kind: "rows",
    title: "Checks that found nothing",
    items: [
      ...(model.unknown.length === 0
        ? [{ glyph: "ok" as const, text: "Unknown principals", trailing: "0 found" }]
        : []),
      ...(counts.missingUsers === 0
        ? [{ glyph: "ok" as const, text: "Role without users@", trailing: "0 found" }]
        : []),
      ...(counts.duplicates === 0
        ? [{ glyph: "ok" as const, text: "Duplicate member entries", trailing: "0 found" }]
        : []),
    ],
  });
  const checks = sections.at(-1);
  if (checks?.kind === "rows" && checks.items.length === 0) sections.pop();
  return {
    view: "board",
    header: {
      status: needsPill(counts),
      segments: [
        { label: "broken", n: counts.broken, tone: "error" },
        { label: "pending", n: counts.pending, tone: "warn" },
        ...(counts.unknown > 0
          ? [{ label: "unknown", n: counts.unknown, tone: "caution" as const }]
          : []),
      ],
    },
    sections,
  };
}

function rosterRow(p: Identity): Row {
  const tone = p.state === "broken" ? "error" : p.state === "pending" ? "warn" : "ok";
  const when = p.acceptedAt
    ? `accepted ${day(p.acceptedAt)}`
    : p.invitedAt
      ? `invited ${day(p.invitedAt)}`
      : p.guest
        ? ""
        : "member";
  return {
    glyph: tone,
    chip: { label: p.role ?? "No role" },
    text: p.you ? `${p.name} (you)` : p.name,
    trailing: [p.email, when].filter(Boolean).join(" · "),
  };
}

const ROLE_RANK: Record<string, number> = { Ops: 0, Admin: 1, Editor: 2, Viewer: 3 };

export function composePeople(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const { model, counts } = measured;
  const attention = model.people.filter((p) => p.state !== "healthy");
  const healthy = model.people
    .filter((p) => p.state === "healthy")
    .sort((a, b) => (ROLE_RANK[a.role ?? ""] ?? 4) - (ROLE_RANK[b.role ?? ""] ?? 4));
  const sections: Section[] = [];
  if (attention.length > 0) {
    sections.push({
      kind: "rows",
      title: `Needs attention · ${attention.length}`,
      items: attention.map(rosterRow),
    });
  }
  if (healthy.length > 0) {
    const shown = healthy.slice(0, ROSTER_LIMIT);
    const rest = healthy.length - shown.length;
    sections.push({
      kind: "rows",
      title: `Healthy · ${healthy.length}`,
      items: [
        ...shown.map(rosterRow),
        ...(rest > 0 ? [{ glyph: "neutral" as const, text: `… ${rest} more · all healthy` }] : []),
      ],
    });
  }
  if (sections.length === 0) {
    sections.push({
      kind: "rows",
      items: [{ glyph: "neutral", text: "No people have entitlements." }],
    });
  }
  return {
    view: "board",
    header: { chip: `${counts.people} people` },
    sections,
  };
}

export function composePrincipals(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const { model, counts } = measured;
  if (model.apps.length === 0) {
    return {
      view: "board",
      sections: [
        { kind: "rows", items: [{ glyph: "neutral", text: "No applications have entitlements." }] },
      ],
    };
  }
  return {
    view: "board",
    header:
      counts.rootApps > 0
        ? { status: { label: `${counts.rootApps} legacy`, tone: "caution" } }
        : {},
    sections: [
      {
        kind: "cards",
        items: model.apps.map((a) => ({
          title: a.name,
          mono: true,
          ...(a.root
            ? { edge: "caution" as const, pill: { label: "legacy", tone: "caution" as const } }
            : {}),
          fields: [
            { label: "appId", value: a.appId ?? a.id, copyable: true },
            { label: "Role", value: a.root ? "root app, keyed by appId" : (a.role ?? "none") },
          ],
          ...(a.root
            ? { footnote: "The app the instance runs as. Shared, so its calls name no person." }
            : {}),
        })),
      },
    ],
  };
}
