// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import {
  ACTIVE_DAYS,
  ACTIVITY_AREA,
  callsIn,
  USAGE_LABEL,
  USAGE_TONE,
  type Usage,
} from "../access/activity.ts";
import type { Identity } from "../access/model.ts";
import { groupByOrg, ORG_FILTER } from "../access/orgs.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { activityReason, type Measured, measuredAccess } from "./access.ts";
import { findAuditAction } from "./connection.ts";
import { PEOPLE_FILTER_ACTION, peopleState } from "./people.ts";

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];

const ORG_BARS = 10;
const USAGE_ORDER: readonly Usage[] = ["active", "idle", "not-used", "invited"];

// A person's tone: their usage when measured, else what entitlements says.
export function personTone(m: Measured, p: Identity) {
  if (p.state === "broken") return "error" as const;
  const u = m.usage.get(p.id);
  if (u) return USAGE_TONE[u];
  return p.state === "pending" ? USAGE_TONE.invited : ("neutral" as const);
}

function notMeasured(m: Measured): CanvasBoardView {
  const state = m.activity;
  const unset = state.kind === "unset";
  return {
    view: "board",
    header: { status: { label: "not measured", tone: "neutral" } },
    sections: [
      {
        kind: "rows",
        items: [
          unset
            ? {
                glyph: "neutral",
                text: "Who uses the instance comes from its audit log, the OEPAuditLogs table in Log Analytics. No workspace is set.",
              }
            : {
                glyph: state.kind === "unread" && state.error ? "warn" : "neutral",
                text: `The audit log is not read: ${activityReason(state)}.`,
              },
        ],
      },
      ...(unset ? [{ kind: "actions" as const, items: [findAuditAction(true)] }] : []),
    ],
  };
}

export function composeActivity(rt: Runtime): CanvasBoardView {
  const m = measuredAccess(rt);
  if (!m) return EMPTY_BOARD;
  if (m.activity.kind !== "measured") return notMeasured(m);
  const activity = m.activity.model;
  const days = activity.recent;
  const people = m.model.people;
  const perDay = days.map((d) => ({
    x: d.slice(5),
    y: people.filter((p) => callsIn(activity.byId.get(p.id), [d]) > 0).length,
  }));
  const week = days.slice(-ACTIVE_DAYS);
  const orgs = groupByOrg(people)
    .map((g) => ({
      g,
      calls: g.people.reduce((n, p) => n + callsIn(activity.byId.get(p.id), days), 0),
      active: g.people.filter((p) => callsIn(activity.byId.get(p.id), week) > 0).length,
    }))
    .filter((o) => o.calls > 0)
    .sort((a, b) => b.calls - a.calls);
  const top = orgs[0]?.calls ?? 0;
  const sections: Section[] = [
    {
      kind: "chart",
      title: "People who made a data call, per day",
      mark: "bar",
      series: [{ label: "People", points: perDay }],
    },
  ];
  if (orgs.length > 0) {
    sections.push({
      kind: "bars",
      title: `Calls by organization, last ${days.length} days`,
      items: orgs.slice(0, ORG_BARS).map((o) => ({
        label: o.g.org.name,
        value: o.calls,
        total: top,
        tone: "accent" as const,
        trailing: `${o.calls.toLocaleString("en-US")} · ${o.active} of ${o.g.people.length} active`,
      })),
    });
  }
  if (orgs.length > ORG_BARS) {
    sections.push({
      kind: "rows",
      items: [
        { glyph: "neutral", text: `… ${orgs.length - ORG_BARS} more organizations made calls` },
      ],
    });
  }
  const fresh = rt.freshness(ACTIVITY_AREA);
  return {
    view: "board",
    header: {
      chip: [`last ${days.length} days`, fresh].filter(Boolean).join(" · "),
    },
    sections,
  };
}

function orgCard(m: Measured, domain: string, name: string, people: Identity[], filter: string) {
  const measured = m.activity.kind === "measured";
  const n = (u: Usage) => people.filter((p) => m.usage.get(p.id) === u).length;
  const broken = people.filter((p) => p.state === "broken").length;
  const invited = n("invited");
  const segments = measured
    ? USAGE_ORDER.map((u) => ({ label: USAGE_LABEL[u], n: n(u), tone: USAGE_TONE[u] })).filter(
        (s) => s.n > 0,
      )
    : [
        { label: "Accepted", n: people.length - invited, tone: "neutral" as const },
        { label: "Invited", n: invited, tone: USAGE_TONE.invited },
      ].filter((s) => s.n > 0);
  const active = n("active");
  const key = `${ORG_FILTER}${domain}`;
  const card: Card = {
    title: name,
    ...(broken > 0
      ? { pill: { label: "gap", tone: "error" as const } }
      : invited > 0
        ? { pill: { label: `${invited} invited`, tone: USAGE_TONE.invited } }
        : {}),
    ...(segments.length > 0
      ? {
          bar: {
            segments,
            label: measured ? "Usage" : "Accepted",
            trailing: measured ? `${active} of ${people.length} active` : `${people.length}`,
          },
        }
      : {}),
    fields: [
      { label: "People", people: people.map((p) => ({ name: p.name, tone: personTone(m, p) })) },
    ],
    ...(domain ? { footnote: domain } : {}),
    action: { type: PEOPLE_FILTER_ACTION, payload: { filter: key } },
    ...(filter === key ? { selected: true } : {}),
  };
  return card;
}

export function composeOrgs(rt: Runtime): CanvasBoardView {
  const m = measuredAccess(rt);
  if (!m || m.model.people.length === 0) return EMPTY_BOARD;
  const groups = groupByOrg(m.model.people);
  const filter = peopleState(rt).filter;
  return {
    view: "board",
    header: {
      chip: `${groups.length} ${groups.length === 1 ? "organization" : "organizations"} · ${m.model.people.length} people`,
    },
    sections: [
      {
        kind: "cards",
        grid: true,
        items: groups.map((g) => orgCard(m, g.org.domain, g.org.name, g.people, filter)),
      },
    ],
  };
}
