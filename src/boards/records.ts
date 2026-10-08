// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import type { ConnectionStatus } from "../connection.ts";
import type { KindCounts } from "../data/areas.ts";
import {
  type FindMode,
  type FoundRecord,
  MODE_WORDS,
  PAGE_SIZE,
  pageInfo,
  queryLabel,
  type RecordsState,
} from "../data/records.ts";
import { EMPTY_BOARD } from "../resting.ts";
import { clock } from "../sweep.ts";
import { phasePill, SIGNIN_REASON } from "./connection.ts";
import { RECORD_OPEN_ACTION } from "./record.ts";

type Section = CanvasBoardView["sections"][number];
type Leaf = Extract<Section, { kind: "columns" }>["columns"][number]["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

export const SEARCH_ACTIONS: Record<FindMode, string> = {
  kind: "records-search-kind",
  id: "records-search-id",
  lucene: "records-search-lucene",
  acl: "records-search-acl",
  legal: "records-search-legal",
};
export const NEXT_ACTION = "records-next";
export const PREV_ACTION = "records-prev";
export const CLEAR_ACTION = "records-clear";

export const DEFAULT_KIND = "osdu:wks:master-data--Well:*";

export interface RecordsInput {
  status: ConnectionStatus;
  kinds?: KindCounts;
  search?: RecordsState;
}

const n = (v: number | null): string => (v === null ? "?" : v.toLocaleString("en-US"));

function findActions(input: RecordsInput, locked: boolean): CanvasActionItem[] {
  const active = input.search?.query;
  const domain = input.status.profile?.entitlementsDomain ?? "opendes.dataservices.energy";
  const gate = locked ? { disabled: true, reason: SIGNIN_REASON } : {};
  const tab = (
    mode: FindMode,
    label: string,
    fields: NonNullable<CanvasActionItem["fields"]>,
  ): CanvasActionItem => ({
    type: SEARCH_ACTIONS[mode],
    label,
    submitLabel: "Search",
    submitTone: "brand",
    pendingLabel: "Searching…",
    fields,
    ...(mode === "kind" ? { defaultOpen: true } : {}),
    ...gate,
  });
  return [
    tab("kind", "By kind", [
      {
        name: "kind",
        label: "Kind",
        placeholder: DEFAULT_KIND,
        required: true,
        defaultValue: active?.mode === "kind" ? active.kind : DEFAULT_KIND,
      },
      {
        name: "query",
        label: "Query",
        placeholder: 'data.FacilityName:"NO 15/9*" (Lucene, optional)',
        ...(active?.mode === "kind" && active.query ? { defaultValue: active.query } : {}),
      },
    ]),
    tab("id", "By id", [
      {
        name: "id",
        label: "Record id",
        placeholder: "opendes:master-data--Well:8690",
        required: true,
      },
    ]),
    tab("lucene", "Lucene", [
      {
        name: "query",
        label: "Query",
        placeholder: 'data.FacilityName:"NO 15/9*" AND kind:"osdu:wks:master-data--Well:*"',
        required: true,
      },
    ]),
    tab("acl", "By ACL group", [
      {
        name: "group",
        label: "Group",
        placeholder: `data.default.viewers@${domain}`,
        required: true,
      },
    ]),
    tab("legal", "By legal tag", [
      {
        name: "tag",
        label: "Legal tag",
        placeholder: "opendes-public-usa-dataset",
        required: true,
      },
    ]),
  ];
}

export function shortKind(kind: string): string {
  const parts = kind.split(":");
  if (parts.length < 4) return kind;
  const type = parts[2] ?? "";
  return `${type.includes("--") ? type.slice(type.indexOf("--") + 2) : type} ${parts[3]}`;
}

function when(r: FoundRecord): string {
  if (r.modifyTime) return `modified ${r.modifyTime.slice(0, 10)}`;
  if (r.createTime) return `created ${r.createTime.slice(0, 10)}`;
  return "modified ?";
}

function legalChip(status: string | undefined): NonNullable<Row["chip"]> {
  if (!status) return { label: "?", tone: "neutral" };
  return { label: status, tone: status === "compliant" ? "ok" : "warn" };
}

function detail(r: FoundRecord): string {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  return [
    `kind ${r.kind}`,
    `version ${r.version ?? "?"}`,
    `created ${r.createTime ?? "?"}`,
    `modified ${r.modifyTime ?? "not since created"}`,
    `legal tags ${list(r.legaltags)}`,
    `countries ${list(r.countries)}`,
    `viewers ${list(r.viewers)}`,
    `owners ${list(r.owners)}`,
  ]
    .join("\n")
    .slice(0, 4000);
}

// Connected rows open the record drawer; while sign-in is needed they disclose the cached hit.
function recordRow(r: FoundRecord, locked: boolean): Row {
  return {
    chip: legalChip(r.legalStatus),
    text: r.id,
    trailing: [r.name, shortKind(r.kind), when(r)].filter(Boolean).join(" · "),
    ...(locked
      ? { detail: detail(r) }
      : { action: { type: RECORD_OPEN_ACTION, payload: { id: r.id } } }),
  };
}

function results(search: RecordsState, locked: boolean): Leaf[] {
  const { result, query, page } = search;
  const info = pageInfo(result.total, page);
  const title = `${n(result.total)} records · ${queryLabel(query)} · page ${n(page + 1)} of ${n(info.pages)}`;
  const gate = (state: { ok: true } | { ok: false; reason: string }) => {
    if (locked) return { disabled: true, reason: SIGNIN_REASON };
    return state.ok ? {} : { disabled: true, reason: state.reason };
  };
  const rows: Leaf =
    result.records.length > 0
      ? { kind: "rows", title, items: result.records.map((r) => recordRow(r, locked)) }
      : {
          kind: "rows",
          title,
          items: [{ glyph: "neutral", text: "No records match this query." }],
        };
  return [
    rows,
    {
      kind: "actions",
      wrap: true,
      title: `Showing ${result.records.length} of ${PAGE_SIZE} on this page · ${PAGE_SIZE} per page, paged by the server`,
      items: [
        { type: PREV_ACTION, label: "Prev", ...gate(info.prev) },
        { type: NEXT_ACTION, label: `Next ${PAGE_SIZE}`, ...gate(info.next) },
        { type: CLEAR_ACTION, label: "Clear" },
      ],
    },
  ];
}

const INVITE: Leaf = {
  kind: "rows",
  title: "Results",
  items: [
    {
      glyph: "neutral",
      text: "Search by kind, id, Lucene, ACL group or legal tag. Results page 25 at a time.",
    },
  ],
};

function chip(input: RecordsInput, signin: boolean): string | undefined {
  const s = input.search;
  if (s) {
    const q = s.query;
    const subject = `${MODE_WORDS[q.mode]}: ${q.mode === "kind" ? q.kind : q.subject}`;
    const base = `${subject} · ${n(s.result.total)} hits`;
    const at = clock(s.at);
    return signin && at ? `${base} · cached from ${at}` : base;
  }
  return input.kinds ? `${n(input.kinds.kinds.length)} kinds` : undefined;
}

export function composeRecords(input: RecordsInput): CanvasBoardView {
  const phase = input.status.phase;
  if (phase !== "connected" && phase !== "signin") return EMPTY_BOARD;
  const locked = phase === "signin";
  const head = chip(input, locked);
  return {
    view: "board",
    header: {
      defaultCollapsed: !input.search,
      ...(locked ? { status: phasePill(input.status) } : {}),
      ...(head ? { chip: head } : {}),
    },
    sections: [
      {
        kind: "columns",
        columns: [
          {
            weight: 1,
            sections: [
              {
                kind: "actions",
                title: "Find records",
                tabs: true,
                items: findActions(input, locked),
              },
            ],
          },
          { weight: 2, sections: input.search ? results(input.search, locked) : [INVITE] },
        ],
      },
    ],
  };
}
