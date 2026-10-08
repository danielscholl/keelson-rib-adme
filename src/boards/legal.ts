// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { LEGAL_AREA, type LegalTag, type LegalTags } from "../data/areas.ts";
import { classifyTags, daysUntil, EXPIRY_WINDOW_DAYS, type ExpiringTag } from "../data/legal.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { SIGNIN_REASON } from "./connection.ts";
import { LEGAL_BROWSE_ACTION } from "./records.ts";

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Action = NonNullable<Card["actions"]>[number];

export const INVALID_CARD_CAP = 3;
export const INVALID_ROW_CAP = 10;
export const VALID_ROW_CAP = 2;

const EXPIRED_REASON = "the contract expiry date has passed.";
const OTHER_REASON =
  "the legal service lists this tag as invalid although its expiry date has not passed.";

export const EXPIRY_BANDS = [
  "past",
  "0–30 d",
  "31–90 d",
  "91–365 d",
  "over 365 d",
  "no date",
] as const;

export function expiryBand(days: number | undefined): (typeof EXPIRY_BANDS)[number] {
  if (days === undefined) return "no date";
  if (days < 0) return "past";
  if (days <= 30) return "0–30 d";
  if (days <= 90) return "31–90 d";
  if (days <= 365) return "91–365 d";
  return "over 365 d";
}

export function composeLegal(rt: Runtime): CanvasBoardView {
  const phase = rt.status.phase;
  if (phase === "firstrun" || phase === "profile-error") return EMPTY_BOARD;
  const measured = rt.cache.get<LegalTags>(LEGAL_AREA);
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
              : { glyph: "neutral", text: "Legal tags are not measured yet." },
          ],
        },
      ],
    };
  }

  const tags = measured.data;
  const now = rt.now();
  const { invalid, expiring, rest } = classifyTags(tags, now);
  const total = tags.valid.length + tags.invalid.length;
  const needs = invalid.length + expiring.length;
  const freshness = rt.freshness(LEGAL_AREA);
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
  if (needs > 0) {
    sections.push({
      kind: "cards",
      title: `Needs a look · ${needs}`,
      items: [
        ...invalid.slice(0, INVALID_CARD_CAP).map((t) => invalidCard(t, now, locked)),
        ...expiring.map((e) => expiringCard(e, locked)),
      ],
    });
  }
  const moreInvalid = invalid.slice(INVALID_CARD_CAP);
  if (moreInvalid.length > 0) {
    sections.push({
      kind: "rows",
      title: `More invalid tags · ${moreInvalid.length}`,
      items: capped(
        moreInvalid,
        INVALID_ROW_CAP,
        (t) => invalidRow(t, now),
        (n) => ({
          glyph: "error",
          text: `… ${n} more invalid tags`,
        }),
      ),
    });
  }
  if (total > 0) sections.push(bands(tags, now));
  if (rest.length > 0) {
    sections.push({
      kind: "rows",
      title: `Valid, no expiry within ${EXPIRY_WINDOW_DAYS} days · ${rest.length}`,
      items: capped(rest, VALID_ROW_CAP, validRow, (n) => ({
        glyph: "ok",
        text: `… ${n} more valid tags`,
        trailing: `none expire within ${EXPIRY_WINDOW_DAYS} days`,
      })),
    });
  }

  if (total > 0) sections.push(properties(tags));
  return {
    view: "board",
    header: {
      status:
        needs > 0
          ? { label: `${needs} need a look`, tone: "caution" }
          : { label: "none need a look", tone: "ok" },
      chip: freshness ? `${total} tags · ${freshness}` : `${total} tags`,
      segments: [
        { label: "valid", n: tags.valid.length, tone: "ok" },
        { label: "invalid", n: tags.invalid.length, tone: "error" },
      ],
    },
    sections,
  };
}

function capped<T>(items: T[], cap: number, draw: (t: T) => Row, more: (n: number) => Row): Row[] {
  const rows = items.slice(0, cap).map(draw);
  if (items.length > cap) rows.push(more(items.length - cap));
  return rows;
}

function browse(tag: LegalTag, locked: boolean): Action {
  return {
    type: LEGAL_BROWSE_ACTION,
    label: "Browse records",
    payload: { tag: tag.name },
    ...(locked ? { disabled: true, reason: SIGNIN_REASON } : {}),
  };
}

function bands(tags: LegalTags, now: Date): Section {
  const all = [...tags.valid, ...tags.invalid];
  const counts = new Map<string, number>(EXPIRY_BANDS.map((b) => [b, 0]));
  for (const t of all) {
    const band = expiryBand(daysUntil(t.expirationDate, now));
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  const tone = (b: string) =>
    b === "past" ? { tone: "error" as const } : b === "0–30 d" ? { tone: "warn" as const } : {};
  return {
    kind: "bars",
    title: "Tags by expiry",
    inline: true,
    items: EXPIRY_BANDS.map((b) => {
      const v = counts.get(b) ?? 0;
      return {
        label: b,
        value: v,
        total: all.length,
        trailing: String(v),
        ...(v > 0 ? tone(b) : {}),
      };
    }),
  };
}

function tally(values: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v ?? "not set", (counts.get(v ?? "not set") ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, c]) => `${k} ${c}`)
    .join(" · ");
}

// Counted over tags, so a country here is a tag's country of origin, not where data is stored.
function properties(tags: LegalTags): Section {
  const all = [...tags.valid, ...tags.invalid];
  return {
    kind: "rows",
    title: "Tag properties · counted over tags",
    boxed: true,
    items: [
      {
        text: "country of origin",
        trailing: tally(all.flatMap((t) => (t.countries.length ? t.countries : [undefined]))),
      },
      { text: "data type", trailing: tally(all.map((t) => t.dataType)) },
      { text: "security", trailing: tally(all.map((t) => t.securityClassification)) },
      { text: "personal data", trailing: tally(all.map((t) => t.personalData)) },
      { text: "export", trailing: tally(all.map((t) => t.exportClassification)) },
    ],
  };
}

function invalidCard(tag: LegalTag, now: Date, locked: boolean): Card {
  const expired = (daysUntil(tag.expirationDate, now) ?? 1) <= 0;
  return {
    title: tag.name,
    mono: true,
    edge: "error",
    pill: { label: "invalid", tone: "error" },
    fields: [
      expired
        ? { label: "expired", value: tag.expirationDate ?? null, tone: "error" }
        : { label: "expires", value: tag.expirationDate ?? null },
      { label: "name", value: tag.name, copyable: true },
    ],
    actions: [browse(tag, locked)],
    reason: { label: "Why invalid", text: expired ? EXPIRED_REASON : OTHER_REASON },
  };
}

function expiringCard({ tag, daysLeft }: ExpiringTag, locked: boolean): Card {
  return {
    title: tag.name,
    mono: true,
    edge: "warn",
    pill: { label: "expires", tone: "warn" },
    fields: [
      daysLeft < 0
        ? { label: "expired", value: `${-daysLeft} d ago`, tone: "error" }
        : { label: "expires in", value: `${daysLeft} d`, tone: "warn" },
      { label: "on", value: tag.expirationDate ?? null },
      { label: "countries", value: tag.countries.length ? tag.countries.join(", ") : null },
      { label: "classification", value: tag.securityClassification ?? null },
    ],
    actions: [browse(tag, locked)],
  };
}

function invalidRow(tag: LegalTag, now: Date): Row {
  const days = daysUntil(tag.expirationDate, now);
  const trailing =
    days === undefined
      ? "no expiry date"
      : `${days <= 0 ? "expired" : "expires"} ${tag.expirationDate}`;
  return { glyph: "error", text: tag.name, trailing };
}

function validRow(tag: LegalTag): Row {
  const detail = [
    tag.expirationDate ? `expires ${tag.expirationDate}` : "no expiry date",
    ...(tag.dataType ? [tag.dataType] : []),
  ];
  return { chip: { label: "valid", tone: "ok" }, text: tag.name, trailing: detail.join(" · ") };
}
