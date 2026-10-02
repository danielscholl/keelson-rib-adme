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

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

export const INVALID_CARD_CAP = 3;
export const INVALID_ROW_CAP = 10;
export const VALID_ROW_CAP = 2;

const EXPIRED_REASON =
  "the contract expiry date has passed. Records that carry only this tag are dropped from search and cannot be read until the tag is valid again.";
const OTHER_REASON =
  "the legal service lists this tag as invalid although its expiry date has not passed. Records that carry only this tag are dropped from search and cannot be read until the tag is valid again.";

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
        ...invalid.slice(0, INVALID_CARD_CAP).map((t) => invalidCard(t, now)),
        ...expiring.map(expiringCard),
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

function invalidCard(tag: LegalTag, now: Date): Card {
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
      { label: "records affected", value: null },
      { label: "name", value: tag.name, copyable: true },
    ],
    reason: { label: "Why invalid", text: expired ? EXPIRED_REASON : OTHER_REASON },
  };
}

function expiringCard({ tag, daysLeft }: ExpiringTag): Card {
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
