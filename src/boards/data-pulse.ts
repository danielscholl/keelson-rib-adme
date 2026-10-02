// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import {
  KINDS_AREA,
  type KindCounts,
  LEGAL_AREA,
  type LegalTags,
  SERVICES_AREA,
} from "../data/areas.ts";
import { classifyTags, EXPIRY_WINDOW_DAYS } from "../data/legal.ts";
import type { Runtime } from "../runtime.ts";
import { phasePill, signinCard } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];

export interface LegalAttention {
  invalid: number;
  expiring: number;
}

export function legalAttention(legal: LegalTags, now: Date): LegalAttention {
  const { invalid, expiring } = classifyTags(legal, now);
  return { invalid: invalid.length, expiring: expiring.length };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function unmeasured(label: string, sub = "not measured"): Stat {
  return { label, value: null, sub };
}

function stats(rt: Runtime): Section {
  const kinds = rt.cache.get<KindCounts>(KINDS_AREA);
  const legal = rt.cache.get<LegalTags>(LEGAL_AREA);
  const why = (m: { error?: string }) => (m.error ? "read failed" : "not measured");
  const items: Stat[] = [];
  if (kinds.data) {
    items.push({ label: "Records", value: fmt(kinds.data.total), sub: "summed over kinds" });
    items.push({
      label: "Kinds",
      value: fmt(kinds.data.kinds.length),
      sub: "from search aggregateBy kind",
    });
  } else {
    items.push(unmeasured("Records", why(kinds)), unmeasured("Kinds", why(kinds)));
  }
  if (legal.data) {
    const { invalid, expiring } = legalAttention(legal.data, rt.now());
    const total = legal.data.valid.length + legal.data.invalid.length;
    const needs = invalid + expiring;
    items.push({
      label: "Legal tags valid",
      value: fmt(legal.data.valid.length),
      sub: `of ${fmt(total)} ${plural(total, "tag", "tags")}`,
    });
    items.push({
      label: "Invalid or expiring",
      value: fmt(needs),
      sub: `${fmt(invalid)} invalid, ${fmt(expiring)} within ${EXPIRY_WINDOW_DAYS} days`,
      ...(needs > 0 ? { tone: "caution" as const } : {}),
    });
  } else {
    items.push(
      unmeasured("Legal tags valid", why(legal)),
      unmeasured("Invalid or expiring", why(legal)),
    );
  }
  items.push(unmeasured("Schemas", "schema service not probed"));
  return { kind: "stats", items };
}

function status(rt: Runtime): NonNullable<CanvasBoardView["header"]>["status"] {
  const legal = rt.cache.get<LegalTags>(LEGAL_AREA).data;
  if (rt.status.phase !== "connected" || !legal) return phasePill(rt.status);
  const { invalid, expiring } = legalAttention(legal, rt.now());
  if (invalid + expiring === 0) return { label: "legal tags hold", tone: "ok" };
  const parts: string[] = [];
  if (invalid > 0) parts.push(`${fmt(invalid)} ${plural(invalid, "tag", "tags")} invalid`);
  if (expiring > 0) parts.push(`${fmt(expiring)} expiring`);
  return { label: parts.join(" · "), tone: "caution" };
}

function chip(rt: Runtime): string | undefined {
  const partition = rt.profile?.partition;
  if (!partition) return undefined;
  const fresh = [LEGAL_AREA, KINDS_AREA, SERVICES_AREA]
    .map((a) => rt.freshness(a))
    .find((f) => f !== undefined);
  return `${partition} · ${fresh ?? "not measured yet"}`;
}

export function composeDataPulse(rt: Runtime): CanvasBoardView {
  const phase = rt.status.phase;
  if (phase === "firstrun" || phase === "profile-error") {
    return {
      view: "board",
      header: {
        status: {
          label: "not connected, finish the steps on the ADME Access tab",
          tone: "neutral",
        },
      },
      sections: [
        {
          kind: "stats",
          items: [
            unmeasured("Records"),
            unmeasured("Kinds"),
            unmeasured("Legal tags valid"),
            unmeasured("Invalid or expiring"),
            unmeasured("Schemas"),
          ],
        },
      ],
    };
  }
  const c = chip(rt);
  const sections: Section[] = [];
  if (phase === "signin") sections.push(signinCard(rt.status));
  sections.push(stats(rt));
  return {
    view: "board",
    header: { status: status(rt), ...(c ? { chip: c } : {}) },
    sections,
  };
}
