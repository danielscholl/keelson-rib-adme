// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import type { Brief, Fact, Item, Tone } from "../brief/index.ts";
import { readFacts } from "../brief/index.ts";
import type { PersonRow } from "../brief/people.ts";
import { dayText } from "../brief/words.ts";
import type { LegalTags } from "../data/areas.ts";
import { daysUntil } from "../data/legal.ts";
import {
  ANNOTATION_KIND_LABEL,
  ANNOTATION_KINDS,
  type Annotation,
} from "../directory/annotations.ts";
import type { Binding } from "../plan/model.ts";
import { type ReadArea, readTrouble } from "../status/index.ts";
import { INSPECT_ACTION } from "../surfaces.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Field = NonNullable<CanvasActionItem["fields"]>[number];

export const ANNOTATE_ACTION = "annotate-identity";
export const REREAD_ACTION = "reread-area";

const GLYPH: Record<Tone, NonNullable<Row["glyph"]>> = {
  bad: "error",
  warn: "warn",
  ok: "ok",
  neutral: "neutral",
};

const SOURCE: Record<Fact["source"], string> = {
  directory: "directory",
  instance: "instance",
  audit: "audit log",
  operator: "operator",
};

export function factSection(title: string | undefined, facts: readonly Fact[]): Section {
  return {
    kind: "rows",
    boxed: true,
    ...(title ? { title } : {}),
    items: facts.map((f) => ({
      glyph: GLYPH[f.tone],
      text: f.label,
      trailing: f.value,
      chip: { label: SOURCE[f.source], tone: "neutral" as const },
    })),
  };
}

export function openAction(id: string, label: string): CanvasActionItem {
  return { type: INSPECT_ACTION, label, payload: { id } };
}

const STATUS_TONE: Record<Item["cls"], "error" | "warn" | "neutral"> = {
  BLOCKED: "error",
  INCONSISTENT: "warn",
  IDENTITY: "warn",
  GRANT: "warn",
  LEGAL: "warn",
  READ: "neutral",
};

export interface ItemVerbs {
  // Verbs the class adds beside opening its subject.
  verbs: CanvasActionItem[];
  form?: CanvasActionItem;
}

export function composeItem(item: Item, extra: ItemVerbs): CanvasBoardView {
  const subject = item.subject;
  const open: CanvasActionItem[] = subject
    ? [
        openAction(
          subject,
          subject.startsWith("who:")
            ? "Open identity"
            : subject.startsWith("cell:")
              ? "Open the grant"
              : subject.startsWith("tag:")
                ? "Open the tag"
                : "Open the read",
        ),
      ]
    : [];
  const sections: Section[] = [
    { kind: "rows", items: [{ text: item.sub }] },
    item.opens
      ? {
          kind: "rows",
          title: item.opens.title,
          items: item.opens.rows.map((o) => ({
            glyph: "neutral" as const,
            text: o.text,
            ...(o.trailing ? { trailing: o.trailing } : {}),
            action: { type: INSPECT_ACTION, payload: { id: o.id } },
          })),
        }
      : factSection("Evidence", item.facts),
    { kind: "rows", title: "Next", items: [{ glyph: "neutral", text: item.next }] },
  ];
  if (item.scope) sections.push({ kind: "rows", items: [{ text: item.scope }] });
  const actions = [...extra.verbs, ...open];
  if (actions.length > 0) sections.push({ kind: "actions", wrap: true, items: actions });
  if (extra.form) sections.push({ kind: "actions", items: [extra.form] });
  return {
    view: "board",
    header: { status: { label: item.cls, tone: STATUS_TONE[item.cls] } },
    sections,
  };
}

export function rereadAction(
  area: ReadArea,
  label: string,
  cost: string,
  signedOut: boolean,
): CanvasActionItem {
  return {
    type: REREAD_ACTION,
    label,
    payload: { area },
    pendingLabel: "Reading…",
    hint: cost,
    ...(signedOut ? { disabled: true, reason: "sign-in needed: run az login, then Re-test" } : {}),
  };
}

export function composeRead(
  b: Brief,
  area: ReadArea,
  now: Date,
  signedOut: boolean,
): CanvasBoardView | undefined {
  const s = b.reads.find((x) => x.area === area);
  if (!s) return undefined;
  const trouble = readTrouble(s);
  const status = !s.configured
    ? { label: "not set up", tone: "neutral" as const }
    : trouble
      ? { label: trouble, tone: trouble === "failed" ? ("error" as const) : ("warn" as const) }
      : { label: "current", tone: "ok" as const };
  const sections: Section[] = [
    factSection("Availability, completeness and freshness", readFacts(s, now)),
    {
      kind: "rows",
      items: [
        {
          text: `Limit ${Math.round(s.limitMs / 3_600_000)} h. Views keep the last good read and its age; a part that was not read shows as ?, never as 0.`,
        },
      ],
    },
  ];
  if (s.configured) {
    sections.push({
      kind: "actions",
      items: [rereadAction(area, `Re-read ${s.label.toLowerCase()}`, s.cost, signedOut)],
    });
  } else {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "Set the audit log workspace in Connection to measure observed use.",
        },
      ],
    });
  }
  return { view: "board", header: { status, chip: s.label }, sections };
}

export function composeTag(
  b: Brief,
  legal: LegalTags | undefined,
  name: string,
  use: { subprojects: string[]; empty: string[]; records: number | null },
  now: Date,
): CanvasBoardView | undefined {
  const valid = legal?.valid.find((t) => t.name === name);
  const invalid = legal?.invalid.find((t) => t.name === name);
  const tag = valid ?? invalid;
  if (!tag) return undefined;
  const days = daysUntil(tag.expirationDate, now);
  const item = [...b.items, ...(b.stewardship ?? [])].find((x) => x.id === `item:legal:${name}`);
  const facts: Fact[] = [
    {
      label: "Status",
      value: invalid
        ? "invalid"
        : days !== undefined && days <= 30
          ? `expires in ${days} d`
          : "valid",
      source: "instance",
      tone: invalid ? "bad" : days !== undefined && days <= 30 ? "warn" : "ok",
    },
    {
      label: "Expires",
      value: tag.expirationDate ? `${dayText(tag.expirationDate, now)}` : "no date",
      source: "instance",
      tone: "neutral",
    },
    ...(tag.description
      ? [
          {
            label: "Description",
            value: tag.description,
            source: "instance" as const,
            tone: "neutral" as const,
          },
        ]
      : []),
    {
      label: "Countries",
      value: tag.countries.join(", ") || "none listed",
      source: "instance",
      tone: "neutral",
    },
    ...(tag.dataType
      ? [
          {
            label: "Data type",
            value: tag.dataType,
            source: "instance" as const,
            tone: "neutral" as const,
          },
        ]
      : []),
    ...(tag.securityClassification
      ? [
          {
            label: "Classification",
            value: tag.securityClassification,
            source: "instance" as const,
            tone: "neutral" as const,
          },
        ]
      : []),
  ];
  const usage: Fact[] = [
    {
      label: "Indexed records",
      value:
        use.records === null
          ? "not counted"
          : `${use.records.toLocaleString("en-US")}, visible to this sign-in`,
      source: "instance",
      tone: "neutral",
    },
    {
      label: "Seismic subprojects",
      value: use.subprojects.length > 0 ? use.subprojects.join(", ") : "none with members",
      source: "instance",
      tone: "neutral",
    },
    ...(use.empty.length > 0
      ? [
          {
            label: "Named by empty subprojects",
            value: use.empty.join(", "),
            source: "instance" as const,
            tone: "neutral" as const,
          },
        ]
      : []),
  ];
  return {
    view: "board",
    header: {
      status: item
        ? { label: "LEGAL", tone: "warn" }
        : invalid
          ? { label: "invalid, unused", tone: "neutral" }
          : { label: "valid", tone: "ok" },
      chip: name,
    },
    sections: [
      factSection("Tag", facts),
      factSection("In use · records and subprojects overlap, so counts are never summed", usage),
      ...(item
        ? [
            {
              kind: "rows" as const,
              title: "Next",
              items: [{ glyph: "neutral" as const, text: item.next }],
            },
          ]
        : []),
      { kind: "rows", items: [{ text: "The rib does not edit legal tags." }] },
    ],
  };
}

export function annotateForm(
  id: string,
  annotation: Annotation | undefined,
  binding: Binding | undefined,
  opts: { labelFirst: boolean },
): CanvasActionItem {
  const text = (
    name: string,
    label: string,
    value: string | undefined,
    extra: Partial<Field> = {},
  ): Field => ({
    name,
    label,
    ...(value ? { defaultValue: value } : {}),
    ...extra,
  });
  const fields: Field[] = [
    ...(opts.labelFirst
      ? [
          text("label", "Label", annotation?.label, {
            placeholder: "what this id is, e.g. Reference data loader",
          }),
          {
            name: "kind",
            label: "Kind",
            required: false,
            placeholder: "not set",
            options: ANNOTATION_KINDS.map((k) => ({ value: k, label: ANNOTATION_KIND_LABEL[k] })),
            ...(annotation?.kind ? { defaultValue: annotation.kind } : {}),
          },
        ]
      : []),
    text("organization", "Organization", annotation?.organization, { half: true }),
    text("responsibility", "Responsibility", annotation?.responsibility, { half: true }),
    text("formerAddresses", "Former addresses", annotation?.formerAddresses?.join(", "), {
      placeholder: "comma separated",
    }),
    text("note", "Note", annotation?.note, { multiline: true }),
  ];
  return {
    type: ANNOTATE_ACTION,
    label: annotation ? "Edit note" : opts.labelFirst ? "Label this id" : "Add note",
    submitLabel: "Save note",
    pendingLabel: "Saving…",
    hint: "Writes only to the annotations file in the rib's data directory; never to the instance.",
    payload: { id },
    ...(binding ? { binding: { ...binding } } : {}),
    fields,
  };
}

// An identity the people list does not hold: an id Entra cannot name, or someone a
// seismic group lists who has no entitlements group.
export function composeIdentity(
  row: PersonRow,
  annotation: Annotation | undefined,
  binding: Binding | undefined,
  extra: CanvasActionItem[],
): CanvasBoardView {
  return {
    view: "board",
    header: {
      status: row.chips[0]
        ? {
            label: row.chips[0].text,
            tone:
              row.chips[0].tone === "bad"
                ? "error"
                : row.chips[0].tone === "warn"
                  ? "warn"
                  : "neutral",
          }
        : { label: "identity", tone: "neutral" },
      chip: row.keys,
    },
    sections: [
      factSection(row.question, row.ladder),
      ...(row.known.length > 0 ? [factSection("What we know", row.known)] : []),
      ...(row.note ? [{ kind: "rows" as const, items: [{ text: row.note }] }] : []),
      ...(extra.length > 0 ? [{ kind: "actions" as const, wrap: true, items: extra }] : []),
      {
        kind: "actions",
        items: [annotateForm(row.id, annotation, binding, { labelFirst: row.group === "actors" })],
      },
    ],
  };
}

export interface CellView {
  title: string;
  status: { label: string; tone: "ok" | "warn" | "error" | "neutral" };
  facts: Fact[];
  backs: string[];
  text: string;
  verbs: CanvasActionItem[];
}

// One person on one subproject: the path, the group and every subproject that group backs.
export function composeCell(v: CellView): CanvasBoardView {
  return {
    view: "board",
    header: { status: v.status, chip: v.title },
    sections: [
      factSection("Path · configured from group membership", v.facts),
      {
        kind: "rows",
        title: "Every subproject this group backs",
        items:
          v.backs.length > 0
            ? v.backs.map((b) => ({ glyph: "neutral" as const, text: b }))
            : [
                {
                  glyph: "neutral" as const,
                  text: "No own group: reach comes with the data role.",
                },
              ],
      },
      { kind: "rows", items: [{ text: v.text }] },
      ...(v.verbs.length > 0 ? [{ kind: "actions" as const, wrap: true, items: v.verbs }] : []),
    ],
  };
}
