// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { LegalTag, LegalTags } from "./areas.ts";

export const EXPIRY_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

export interface ExpiringTag {
  tag: LegalTag;
  daysLeft: number;
}

export interface TagClassification {
  invalid: LegalTag[];
  expiring: ExpiringTag[];
  rest: LegalTag[];
}

// Whole calendar days from `now` (UTC) to an ISO date; undefined when absent or unparseable.
export function daysUntil(date: string | undefined, now: Date): number | undefined {
  if (!date) return undefined;
  const at = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(at)) return undefined;
  const d = new Date(at);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((day - today) / DAY_MS);
}

// Invalid newest expiry first, expiring soonest first, the rest soonest expiry first.
export function classifyTags(tags: LegalTags, now: Date): TagClassification {
  const expiring: ExpiringTag[] = [];
  const rest: { tag: LegalTag; days: number }[] = [];
  for (const tag of tags.valid) {
    const days = daysUntil(tag.expirationDate, now);
    if (days !== undefined && days <= EXPIRY_WINDOW_DAYS) expiring.push({ tag, daysLeft: days });
    else rest.push({ tag, days: days ?? Number.POSITIVE_INFINITY });
  }
  const invalid = tags.invalid
    .map((tag) => ({ tag, days: daysUntil(tag.expirationDate, now) }))
    .sort((a, b) => order(b.days ?? Number.NEGATIVE_INFINITY, a.days ?? Number.NEGATIVE_INFINITY))
    .map((x) => x.tag);
  return {
    invalid,
    expiring: expiring.sort((a, b) => a.daysLeft - b.daysLeft),
    rest: rest.sort((a, b) => order(a.days, b.days)).map((x) => x.tag),
  };
}

function order(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export interface TagUse {
  tag: LegalTag;
  count: number;
  daysLeft?: number;
}

// Where records sit across the legal service's tags. Needs measured per-tag counts.
export interface TagUsage {
  inUse: TagUse[];
  invalidHeld: TagUse[];
  unlisted: { key: string; count: number }[];
  invalidEmpty: LegalTag[];
  validEmpty: LegalTag[];
}

export function tagUsage(
  legal: LegalTags,
  counts: readonly { key: string; count: number }[],
  now: Date,
): TagUsage {
  const byName = new Map(counts.map((b) => [b.key, b.count]));
  const most = (a: TagUse, b: TagUse) => b.count - a.count || a.tag.name.localeCompare(b.tag.name);
  const inUse: TagUse[] = [];
  const validEmpty: LegalTag[] = [];
  for (const tag of legal.valid) {
    const count = byName.get(tag.name) ?? 0;
    if (count === 0) {
      validEmpty.push(tag);
      continue;
    }
    const days = daysUntil(tag.expirationDate, now);
    inUse.push({
      tag,
      count,
      ...(days !== undefined && days <= EXPIRY_WINDOW_DAYS ? { daysLeft: days } : {}),
    });
  }
  const { invalid } = classifyTags(legal, now);
  const invalidHeld = invalid
    .filter((tag) => (byName.get(tag.name) ?? 0) > 0)
    .map((tag) => ({ tag, count: byName.get(tag.name) ?? 0 }));
  const listed = new Set([...legal.valid, ...legal.invalid].map((t) => t.name));
  return {
    inUse: inUse.sort(most),
    invalidHeld: invalidHeld.sort(most),
    unlisted: counts.filter((b) => b.count > 0 && !listed.has(b.key)),
    invalidEmpty: invalid.filter((tag) => (byName.get(tag.name) ?? 0) === 0),
    validEmpty: validEmpty.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface LegalAttention {
  invalid: number;
  expiring: number;
  // True when both counts are tags that hold records; false when counts were not measured.
  held: boolean;
}

// What needs a decision: invalid tags still holding records and tags in use about to expire.
// Without per-tag counts it falls back to every invalid and expiring tag.
export function legalAttention(
  legal: LegalTags,
  counts: readonly { key: string; count: number }[] | null | undefined,
  now: Date,
): LegalAttention {
  if (counts) {
    const use = tagUsage(legal, counts, now);
    return {
      invalid: use.invalidHeld.length,
      expiring: use.inUse.filter((u) => u.daysLeft !== undefined).length,
      held: true,
    };
  }
  const { invalid, expiring } = classifyTags(legal, now);
  return { invalid: invalid.length, expiring: expiring.length, held: false };
}
