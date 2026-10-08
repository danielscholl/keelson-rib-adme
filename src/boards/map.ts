// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import {
  KIND_BUCKET_LIMIT,
  KINDS_AREA,
  type KindCounts,
  LEGAL_AREA,
  type LegalTag,
  type LegalTags,
} from "../data/areas.ts";
import { GROUP_BYS, GROUP_LABELS, groupBy, groupKinds } from "../data/inventory.ts";
import { classifyTags, daysUntil } from "../data/legal.ts";
import {
  type Bucket,
  FACET_FIELDS,
  FACETS_AREA,
  type Facets,
  LENSES,
  type Lens,
  mapState,
  type Selection,
  type Slice,
} from "../data/map.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { SIGNIN_REASON } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Leaf = Extract<Section, { kind: "columns" }>["columns"][number]["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Tone = NonNullable<Row["glyph"]>;

export const MAP_LENS_ACTION = "map-lens";
export const MAP_GROUP_ACTION = "map-group";
export const MAP_SELECT_ACTION = "map-select";
export const MAP_BROWSE_ACTION = "map-browse";

export const MAP_ROWS = 12;
export const PROFILE_ROWS = 8;

const LENS_LABELS: Record<Lens, string> = {
  tags: "Legal tags",
  viewers: "Readers",
  owners: "Owners",
  kinds: "Kinds",
};

const LENS_TITLES: Record<Lens, string> = {
  tags: "Records per legal tag · attention first",
  viewers: "Records per reader group · acl.viewers",
  owners: "Records per owner group · acl.owners",
  kinds: "Records per",
};

const n = (v: number | null | undefined): string =>
  v === null || v === undefined ? "?" : v.toLocaleString("en-US");

// One row of a lens: what it selects, and how it draws.
export interface Entry {
  key: string;
  label: string;
  count: number | null;
  chip?: Row["chip"];
  glyph?: Tone;
  trailing?: string;
  // Summary rows ("… 3 more") select nothing.
  summary?: boolean;
}

interface Inputs {
  kinds?: KindCounts;
  legal?: LegalTags;
  facets?: Facets;
  domain?: string;
  now: Date;
}

function inputs(rt: Runtime): Inputs {
  const kinds = rt.cache.get<KindCounts>(KINDS_AREA).data;
  const legal = rt.cache.get<LegalTags>(LEGAL_AREA).data;
  const facets = rt.cache.get<Facets>(FACETS_AREA).data;
  const domain = rt.profile?.entitlementsDomain;
  return {
    ...(kinds ? { kinds } : {}),
    ...(legal ? { legal } : {}),
    ...(facets ? { facets } : {}),
    ...(domain ? { domain } : {}),
    now: rt.now(),
  };
}

// "data.pilot.viewers@opendes.dataservices.energy" reads as "data.pilot.viewers".
export function shortGroup(email: string, domain: string | undefined): string {
  return domain && email.endsWith(`@${domain}`) ? email.slice(0, -domain.length - 1) : email;
}

function tagChip(tag: LegalTag | undefined, now: Date, invalid: boolean): NonNullable<Row["chip"]> {
  if (!tag) return { label: "not listed", tone: "caution" };
  if (invalid) return { label: "invalid", tone: "error" };
  const days = daysUntil(tag.expirationDate, now);
  if (days !== undefined && days <= 30) return { label: `${days} d`, tone: "warn" };
  return { label: "valid", tone: "ok" };
}

function capped(entries: Entry[], cap: number, noun: string): Entry[] {
  if (entries.length <= cap) return entries;
  const rest = entries.slice(cap);
  const known = rest.every((e) => e.count !== null);
  return [
    ...entries.slice(0, cap),
    {
      key: "",
      label: `… ${rest.length} more ${noun}`,
      count: known ? rest.reduce((s, e) => s + (e.count ?? 0), 0) : null,
      glyph: "neutral",
      summary: true,
    },
  ];
}

function tagEntries(i: Inputs): Entry[] {
  const counts = new Map((i.facets?.tags ?? []).map((b) => [b.key, b.count]));
  const measured = !!i.facets?.tags;
  const count = (name: string) => (measured ? (counts.get(name) ?? 0) : null);
  const entries: Entry[] = [];
  const listed = new Set<string>();
  if (i.legal) {
    const { invalid, expiring, rest } = classifyTags(i.legal, i.now);
    for (const t of invalid) {
      listed.add(t.name);
      entries.push({
        key: t.name,
        label: t.name,
        count: count(t.name),
        chip: tagChip(t, i.now, true),
      });
    }
    for (const { tag } of expiring) {
      listed.add(tag.name);
      entries.push({
        key: tag.name,
        label: tag.name,
        count: count(tag.name),
        chip: tagChip(tag, i.now, false),
      });
    }
    // Records that carry a tag the legal service does not list need a look too.
    for (const b of i.facets?.tags ?? []) {
      if (listed.has(b.key) || rest.some((t) => t.name === b.key)) continue;
      listed.add(b.key);
      entries.push({
        key: b.key,
        label: b.key,
        count: b.count,
        chip: tagChip(undefined, i.now, false),
      });
    }
    const valid = rest
      .map((t) => ({ t, c: count(t.name) }))
      .sort((a, b) => (b.c ?? 0) - (a.c ?? 0) || a.t.name.localeCompare(b.t.name));
    for (const { t, c } of valid) {
      entries.push({ key: t.name, label: t.name, count: c, chip: tagChip(t, i.now, false) });
    }
  } else {
    for (const b of i.facets?.tags ?? []) {
      entries.push({
        key: b.key,
        label: b.key,
        count: b.count,
        chip: { label: "?", tone: "neutral" },
      });
    }
  }
  return capped(entries, MAP_ROWS, "tags");
}

function groupEntries(buckets: Bucket[], domain: string | undefined): Entry[] {
  return capped(
    buckets.map((b) => ({
      key: b.key,
      label: shortGroup(b.key, domain),
      count: b.count,
      glyph: "info" as const,
    })),
    MAP_ROWS,
    "groups",
  );
}

function kindEntries(rt: Runtime, kinds: KindCounts): Entry[] {
  const by = groupBy(rt);
  const groups = groupKinds(kinds.kinds, by);
  return capped(
    groups.map((g) => ({
      key: g.pattern,
      label: g.label,
      count: g.count,
      glyph: "accent" as const,
      trailing:
        by === "version"
          ? `${n(g.kinds)} ${g.kinds === 1 ? "kind" : "kinds"}`
          : `${n(g.versions)} ${g.versions === 1 ? "version" : "versions"}`,
    })),
    MAP_ROWS,
    "groups",
  );
}

// The rows a lens draws; also what a select action is checked against.
export function lensEntries(rt: Runtime, lens: Lens): Entry[] {
  const i = inputs(rt);
  if (lens === "tags") return tagEntries(i);
  if (lens === "kinds") return i.kinds ? kindEntries(rt, i.kinds) : [];
  const buckets = i.facets?.[lens];
  return buckets ? groupEntries(buckets, i.domain) : [];
}

function totalOf(i: Inputs): number {
  return i.kinds?.visible ?? i.kinds?.total ?? 0;
}

function lensStrip(active: Lens, i: Inputs): Leaf {
  const counts: Record<Lens, number | null> = {
    tags: i.legal
      ? i.legal.valid.length + i.legal.invalid.length
      : (i.facets?.tags?.length ?? null),
    viewers: i.facets?.viewers?.length ?? null,
    owners: i.facets?.owners?.length ?? null,
    kinds: i.kinds?.kinds.length ?? null,
  };
  return {
    kind: "actions",
    wrap: true,
    items: LENSES.map((lens) => ({
      type: MAP_LENS_ACTION,
      label:
        counts[lens] === null ? LENS_LABELS[lens] : `${LENS_LABELS[lens]} · ${n(counts[lens])}`,
      payload: { lens },
      selected: lens === active,
    })),
  };
}

function groupStrip(rt: Runtime): Leaf {
  const active = groupBy(rt);
  return {
    kind: "actions",
    wrap: true,
    items: GROUP_BYS.map((by) => ({
      type: MAP_GROUP_ACTION,
      label: GROUP_LABELS[by],
      payload: { by },
      selected: by === active,
    })),
  };
}

function lensRows(rt: Runtime, lens: Lens, i: Inputs, locked: boolean): Leaf[] {
  const state = mapState(rt);
  const sel = state.selection?.lens === lens ? state.selection.key : undefined;
  const total = totalOf(i);
  const title =
    lens === "kinds" ? `Records per ${GROUP_LABELS[groupBy(rt)].toLowerCase()}` : LENS_TITLES[lens];
  const missing = lensMissing(rt, lens, i);
  if (missing) return [{ kind: "rows", title, items: [missing] }];
  const items: Row[] = lensEntries(rt, lens).map((e) => ({
    ...(e.chip ? { chip: e.chip } : { glyph: e.glyph ?? "neutral" }),
    text: e.label,
    trailing: e.trailing ? `${n(e.count)} · ${e.trailing}` : n(e.count),
    bar: { value: e.count, total: Math.max(total, e.count ?? 0, 1) },
    ...(e.summary || locked
      ? {}
      : { action: { type: MAP_SELECT_ACTION, payload: { lens, key: e.key } } }),
    ...(sel !== undefined && e.key === sel ? { selected: true } : {}),
  }));
  return [{ kind: "rows", title, items }];
}

function lensMissing(rt: Runtime, lens: Lens, i: Inputs): Row | undefined {
  if (lens === "kinds") {
    if (i.kinds) return undefined;
    const err = rt.cache.get(KINDS_AREA).error;
    return {
      glyph: err ? "error" : "neutral",
      text: err ? `Not measured: ${err}` : "Record counts are not measured yet.",
    };
  }
  if (lens === "tags" && (i.legal || i.facets?.tags)) return undefined;
  if (lens !== "tags" && i.facets?.[lens]) return undefined;
  const why = i.facets?.errors[lens] ?? rt.cache.get(FACETS_AREA).error;
  return why
    ? { glyph: "warn", text: `Not measured: search did not count ${FACET_FIELDS[lens]} (${why}).` }
    : { glyph: "neutral", text: "Not measured yet." };
}

function caption(rt: Runtime, lens: Lens, i: Inputs, locked: boolean): Leaf {
  const rows: Row[] = [];
  if (lens === "tags" && i.legal && !i.facets?.tags) {
    const why = i.facets?.errors.tags ?? rt.cache.get(FACETS_AREA).error;
    rows.push({
      glyph: "warn",
      text: `Records per tag not measured${why ? `: ${why}` : ""}. Tags still list from the legal service.`,
    });
  }
  if (lens === "kinds" && i.kinds && i.kinds.kinds.length >= KIND_BUCKET_LIMIT) {
    rows.push({
      glyph: "warn",
      text: `Search returned ${n(KIND_BUCKET_LIMIT)} kinds, its limit: the list may be incomplete.`,
    });
  }
  rows.push(
    locked
      ? { glyph: "neutral", text: SIGNIN_REASON }
      : lens === "kinds"
        ? {
            glyph: "neutral",
            text: `Bars are shares of ${n(totalOf(i))} visible records. Select a row for its tags and readers.`,
          }
        : {
            glyph: "neutral",
            text: `A record can carry several tags and groups, so rows overlap and do not add up to ${n(totalOf(i))}. Select a row to see the rest.`,
          },
  );
  return { kind: "rows", items: rows };
}

// ---- The profile of the selected row ----

function browse(locked: boolean): NonNullable<Card["actions"]>[number] {
  return {
    type: MAP_BROWSE_ACTION,
    label: "Browse records",
    ...(locked ? { disabled: true, reason: SIGNIN_REASON } : {}),
  };
}

function findTag(legal: LegalTags | undefined, name: string): { tag?: LegalTag; invalid: boolean } {
  const invalid = legal?.invalid.find((t) => t.name === name);
  if (invalid) return { tag: invalid, invalid: true };
  const tag = legal?.valid.find((t) => t.name === name);
  return tag ? { tag, invalid: false } : { invalid: false };
}

function countOf(rt: Runtime, sel: Selection): number | null {
  const e = lensEntries(rt, sel.lens).find((x) => !x.summary && x.key === sel.key);
  return e?.count ?? null;
}

function tagCard(rt: Runtime, sel: Selection, i: Inputs, locked: boolean): Card {
  const { tag, invalid } = findTag(i.legal, sel.key);
  const days = daysUntil(tag?.expirationDate, i.now);
  const chip = tagChip(tag, i.now, invalid);
  const pill =
    chip.label === "valid" || chip.label === "invalid" || chip.label === "not listed"
      ? { label: chip.label, tone: chip.tone }
      : { label: `expires in ${days} d`, tone: "warn" as const };
  const fields: NonNullable<Card["fields"]> = [
    { label: "records", value: n(countOf(rt, sel)) },
    days !== undefined && days < 0
      ? { label: "expired", value: tag?.expirationDate ?? null, tone: "error" }
      : {
          label: "expires",
          value: tag?.expirationDate ?? null,
          ...(chip.tone === "warn" ? { tone: "warn" as const } : {}),
        },
    { label: "countries", value: tag?.countries.length ? tag.countries.join(", ") : null },
    { label: "classification", value: tag?.securityClassification ?? null },
    { label: "data type", value: tag?.dataType ?? null },
    { label: "personal data", value: tag?.personalData ?? null },
    { label: "export", value: tag?.exportClassification ?? null },
  ];
  return {
    title: sel.key,
    mono: true,
    edge: chip.tone,
    pill,
    fields,
    actions: [browse(locked)],
    ...(invalid
      ? {
          reason: {
            label: "Why invalid",
            text:
              days !== undefined && days <= 0
                ? "the contract expiry date has passed. Search may hide records on an invalid tag, so a count here is what this sign-in sees."
                : "the legal service lists this tag as invalid although its expiry date has not passed.",
          },
        }
      : !tag && i.legal
        ? {
            reason: {
              label: "Not listed",
              text: "records carry this tag but the legal service does not list it in this partition.",
            },
          }
        : {}),
  };
}

function groupCard(rt: Runtime, sel: Selection, slice: Slice | undefined, locked: boolean): Card {
  const members = slice?.members;
  const missing = members === null;
  const err = slice?.errors.members;
  const memberText =
    members === undefined
      ? err
        ? `not read: ${err}`
        : null
      : members === null
        ? "no such group in entitlements"
        : `${n(members.groups.length)} ${members.groups.length === 1 ? "group" : "groups"} · ${n(members.others)} people or applications`;
  return {
    title: sel.label,
    mono: true,
    edge: missing ? "caution" : "info",
    pill: missing
      ? { label: "not in entitlements", tone: "caution" }
      : { label: sel.lens === "viewers" ? "reader group" : "owner group", tone: "info" },
    fields: [
      { label: "records", value: n(countOf(rt, sel)) },
      { label: "members", value: memberText, ...(missing ? { tone: "caution" as const } : {}) },
      { label: "name", value: sel.key, copyable: true },
    ],
    actions: [browse(locked)],
    ...(missing
      ? {
          reason: {
            label: "Not in entitlements",
            text: "records name this group in their ACL but entitlements has no such group, so nobody can be added to it.",
          },
        }
      : {}),
  };
}

function kindCard(rt: Runtime, sel: Selection, i: Inputs, locked: boolean): Card {
  const group = groupKinds(i.kinds?.kinds ?? [], groupBy(rt)).find((g) => g.pattern === sel.key);
  return {
    title: sel.label,
    edge: "accent",
    pill: { label: GROUP_LABELS[groupBy(rt)].toLowerCase(), tone: "accent" },
    fields: [
      { label: "records", value: n(group?.count ?? null) },
      { label: "kinds", value: group ? n(group.kinds) : null },
      { label: "schema versions", value: group ? n(group.versions) : null },
      { label: "pattern", value: sel.key, copyable: true },
    ],
    actions: [browse(locked)],
  };
}

function bucketRows(
  title: string,
  buckets: Bucket[] | null | undefined,
  err: string | undefined,
  draw: (b: Bucket) => Row,
): Leaf {
  if (buckets === undefined)
    return { kind: "rows", title, items: [{ glyph: "neutral", text: "Not read yet." }] };
  if (buckets === null)
    return {
      kind: "rows",
      title,
      items: [{ glyph: "warn", text: `Not measured: ${err ?? "search refused"}` }],
    };
  if (buckets.length === 0)
    return {
      kind: "rows",
      title,
      items: [{ glyph: "neutral", text: "None visible to this sign-in." }],
    };
  const rest = buckets.slice(PROFILE_ROWS);
  const items = buckets.slice(0, PROFILE_ROWS).map(draw);
  if (rest.length > 0) {
    items.push({
      glyph: "neutral",
      text: `… ${rest.length} more`,
      trailing: n(rest.reduce((s, b) => s + b.count, 0)),
    });
  }
  return { kind: "rows", title, items };
}

function coverBars(slice: Slice, total: number | null): Leaf {
  const title = "What it covers";
  if (!slice.kinds) return bucketRows(title, slice.kinds, slice.errors.kinds, () => ({ text: "" }));
  const groups = groupKinds(
    slice.kinds.map((b) => ({ kind: b.key, count: b.count })),
    "family",
  );
  if (groups.length === 0) return bucketRows(title, [], undefined, () => ({ text: "" }));
  const top = groups.slice(0, PROFILE_ROWS);
  const max = Math.max(total ?? 0, top[0]?.count ?? 0, 1);
  const items = top.map((g) => ({
    label: g.label,
    value: g.count,
    total: max,
    trailing: n(g.count),
  }));
  const rest = groups.slice(PROFILE_ROWS);
  if (rest.length > 0) {
    const c = rest.reduce((s, g) => s + g.count, 0);
    items.push({ label: `${rest.length} more families`, value: c, total: max, trailing: n(c) });
  }
  return { kind: "bars", title, items };
}

function profile(rt: Runtime, i: Inputs, locked: boolean): Leaf[] {
  const state = mapState(rt);
  const sel = state.selection;
  if (!sel) {
    return [
      {
        kind: "rows",
        title: "Selected",
        items: [
          {
            glyph: "neutral",
            text: "Select a row to see what it covers, who can reach it and which legal tag governs it.",
          },
        ],
      },
    ];
  }
  const read = state.slice;
  const slice = read && "data" in read ? read.data : undefined;
  const leaves: Leaf[] = [];
  const card =
    sel.lens === "tags"
      ? tagCard(rt, sel, i, locked)
      : sel.lens === "kinds"
        ? kindCard(rt, sel, i, locked)
        : groupCard(rt, sel, slice, locked);
  leaves.push({ kind: "cards", items: [card] });
  if (read && "error" in read) {
    leaves.push({ kind: "rows", items: [{ glyph: "error", text: `Not read: ${read.error}` }] });
    return leaves;
  }
  if (!slice) {
    leaves.push({
      kind: "rows",
      items: [{ glyph: "neutral", text: locked ? SIGNIN_REASON : "Reading this slice…" }],
    });
    return leaves;
  }
  const tagRow = (b: Bucket): Row => {
    const { tag, invalid } = findTag(i.legal, b.key);
    return { chip: tagChip(tag, i.now, invalid), text: b.key, trailing: n(b.count) };
  };
  const groupRow = (b: Bucket): Row => ({
    glyph: "info",
    text: shortGroup(b.key, i.domain),
    trailing: n(b.count),
  });
  const count = countOf(rt, sel);
  if (sel.lens === "tags") {
    leaves.push(bucketRows("Who can read it", slice.viewers, slice.errors.viewers, groupRow));
    leaves.push(bucketRows("Who owns it", slice.owners, slice.errors.owners, groupRow));
    leaves.push(coverBars(slice, count));
  } else if (sel.lens === "kinds") {
    leaves.push(bucketRows("Governed by", slice.tags, slice.errors.tags, tagRow));
    leaves.push(bucketRows("Who can read it", slice.viewers, slice.errors.viewers, groupRow));
  } else {
    leaves.push(bucketRows("Under which legal tags", slice.tags, slice.errors.tags, tagRow));
    leaves.push(coverBars(slice, count));
    if (slice.members && slice.members.groups.length > 0) {
      leaves.push({
        kind: "rows",
        title: "Member groups",
        items: slice.members.groups
          .slice(0, PROFILE_ROWS)
          .map((g) => ({ glyph: "info" as const, text: shortGroup(g, i.domain) })),
      });
    }
  }
  const at = clock(read?.at);
  if (at) leaves.push({ kind: "rows", items: [{ glyph: "neutral", text: `Slice read ${at}.` }] });
  return leaves;
}

export function composeMap(rt: Runtime): CanvasBoardView {
  const phase = rt.status.phase;
  if (phase !== "connected" && phase !== "signin") return EMPTY_BOARD;
  const locked = phase === "signin";
  const i = inputs(rt);
  const lens = mapState(rt).lens;
  const left: Leaf[] = [lensStrip(lens, i)];
  if (lens === "kinds") left.push(groupStrip(rt));
  left.push(...lensRows(rt, lens, i, locked), caption(rt, lens, i, locked));
  const fresh = rt.freshness(FACETS_AREA) ?? rt.freshness(KINDS_AREA);
  return {
    view: "board",
    header: fresh ? { chip: fresh } : {},
    sections: [
      {
        kind: "columns",
        columns: [
          { weight: 5, sections: left },
          { weight: 7, sections: profile(rt, i, locked) },
        ],
      },
    ],
  };
}
