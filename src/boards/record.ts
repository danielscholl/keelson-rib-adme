// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { openedRecord, type RecordDetail } from "../data/record.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

export const RECORD_OPEN_ACTION = "record-open";

const EMPTY: CanvasBoardView = {
  view: "board",
  sections: [{ kind: "rows", items: [{ glyph: "neutral", text: "Open a record from Records." }] }],
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

const list = (xs: string[]): string => (xs.length ? xs.join(", ") : "none");

function by(time: string | undefined, user: string | undefined): string {
  if (!time) return "?";
  return user ? `${time} by ${user}` : time;
}

function fields(r: RecordDetail): Row[] {
  const rows: [string, string][] = [
    ["kind", r.kind],
    ...(r.name ? [["name", r.name] as [string, string]] : []),
    ["created", by(r.createTime, r.createUser)],
    ["modified", r.modifyTime ? by(r.modifyTime, r.modifyUser) : "not since created"],
    ["legal tags", list(r.legaltags)],
    ["legal status", r.legalStatus ?? "?"],
    ["countries", list(r.countries)],
    ["viewers", list(r.viewers)],
    ["owners", list(r.owners)],
    ["parents", r.parents.length ? r.parents.join("\n") : "none"],
  ];
  return rows.map(([text, trailing]) => ({ text, trailing }));
}

export function composeRecord(rt: Runtime): CanvasBoardView {
  const view = openedRecord(rt);
  if (!view) return EMPTY;
  const when = clock(view.at);
  if (!view.ok) {
    return {
      view: "board",
      header: { status: { label: "not read", tone: "error" }, chip: view.id },
      sections: [{ kind: "rows", items: [{ glyph: "error", text: view.error }] }],
    };
  }
  const r = view.record;
  return {
    view: "board",
    header: {
      status: { label: "read from storage", tone: "ok" },
      chip: when ? `${r.id} · ${when}` : r.id,
    },
    sections: [
      {
        kind: "stats",
        items: [
          {
            label: "JSON size",
            value: formatBytes(r.bytes),
            sub: "latest version, as storage returned it",
          },
          { label: "Legal tags", value: String(r.legaltags.length) },
          { label: "Parents", value: String(r.parents.length), sub: "ancestry links" },
        ],
      },
      { kind: "rows", boxed: true, items: fields(r) },
    ],
  };
}
