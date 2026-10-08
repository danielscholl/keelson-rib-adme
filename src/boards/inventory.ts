// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { KIND_BUCKET_LIMIT, KINDS_AREA, type KindCounts } from "../data/areas.ts";
import { GROUP_BYS, GROUP_LABELS, type GroupBy, groupBy, groupKinds } from "../data/inventory.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { SIGNIN_REASON } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

export const INVENTORY_GROUP_ACTION = "inventory-group";
export const INVENTORY_OPEN_ACTION = "inventory-open";
export const INVENTORY_ROWS = 8;

const NOUNS: Record<GroupBy, [string, string]> = {
  family: ["family", "families"],
  authority: ["authority", "authorities"],
  namespace: ["namespace", "namespaces"],
  version: ["schema version", "schema versions"],
};

const n = (v: number): string => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

function groupStrip(active: GroupBy): Section {
  return {
    kind: "actions",
    wrap: true,
    items: GROUP_BYS.map((by) => ({
      type: INVENTORY_GROUP_ACTION,
      label: GROUP_LABELS[by],
      payload: { by },
      selected: by === active,
    })),
  };
}

function rows(kinds: KindCounts, by: GroupBy, locked: boolean): Row[] {
  const groups = groupKinds(kinds.kinds, by);
  const items: Row[] = groups.slice(0, INVENTORY_ROWS).map((g) => {
    const detail =
      by === "version"
        ? plural(g.kinds, "kind", "kinds")
        : plural(g.versions, "version", "versions");
    return {
      text: g.label,
      bar: { value: g.count, total: kinds.total },
      trailing: `${n(g.count)} · ${detail}`,
      ...(locked
        ? {}
        : { action: { type: INVENTORY_OPEN_ACTION, payload: { pattern: g.pattern } } }),
    };
  });
  const rest = groups.slice(INVENTORY_ROWS);
  if (rest.length > 0) {
    const count = rest.reduce((s, g) => s + g.count, 0);
    items.push({
      glyph: "neutral",
      text: `${plural(rest.length, "more group", "more groups")}`,
      bar: { value: count, total: kinds.total },
      trailing: n(count),
    });
  }
  return items;
}

function caption(kinds: KindCounts): Row {
  const truncated = kinds.kinds.length >= KIND_BUCKET_LIMIT;
  return {
    glyph: truncated ? "warn" : "neutral",
    text: truncated
      ? `Search returned ${n(KIND_BUCKET_LIMIT)} kinds, its limit: the list may be incomplete.`
      : `Bars are shares of ${n(kinds.total)} records in ${plural(kinds.kinds.length, "kind", "kinds")}. Select a row to list its records.`,
  };
}

export function composeInventory(rt: Runtime): CanvasBoardView {
  const phase = rt.status.phase;
  if (phase !== "connected" && phase !== "signin") return EMPTY_BOARD;
  const measured = rt.cache.get<KindCounts>(KINDS_AREA);
  const fresh = rt.freshness(KINDS_AREA);
  if (!measured.data) {
    return {
      view: "board",
      header: { status: { label: "not measured", tone: "neutral" } },
      sections: [
        {
          kind: "rows",
          items: [
            measured.error
              ? { glyph: "error", text: `Not measured: ${measured.error}` }
              : { glyph: "neutral", text: "Record counts are not measured yet." },
          ],
        },
      ],
    };
  }
  const kinds = measured.data;
  const by = groupBy(rt);
  const locked = phase === "signin";
  const sections: Section[] = [];
  if (measured.error) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "warn",
          text: `Last read failed${measured.errorAt ? ` at ${clock(measured.errorAt)}` : ""}: ${measured.error}`,
          trailing: `showing ${clock(measured.at)}`,
        },
      ],
    });
  }
  sections.push(groupStrip(by), {
    kind: "rows",
    title: `Records by ${NOUNS[by][0]}`,
    items: rows(kinds, by, locked),
  });
  sections.push({
    kind: "rows",
    items: [locked ? { glyph: "neutral", text: SIGNIN_REASON } : caption(kinds)],
  });
  const groups = groupKinds(kinds.kinds, by).length;
  const head = plural(groups, ...NOUNS[by]);
  return {
    view: "board",
    header: { chip: fresh ? `${head} · ${fresh}` : head },
    sections,
  };
}
