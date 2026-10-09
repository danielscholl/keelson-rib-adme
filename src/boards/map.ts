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
import { daysUntil, type TagUsage, tagUsage } from "../data/legal.ts";
import {
  type Bucket,
  FACETS_AREA,
  type Facets,
  type Flow,
  LENSES,
  type Lens,
  lensField,
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
type FlowLeaf = Extract<Leaf, { kind: "flow" }>;
type FlowNode = FlowLeaf["nodes"][number];
type Tone = NonNullable<Row["glyph"]>;

export const MAP_LENS_ACTION = "map-lens";
export const MAP_GROUP_ACTION = "map-group";
export const MAP_SELECT_ACTION = "map-select";
export const MAP_BROWSE_ACTION = "map-browse";
export const MAP_COPY_ACTION = "map-copy";

export const MAP_ROWS = 12;
export const PROFILE_ROWS = 8;
// Nodes the flow draws on each side before it folds the rest into one.
export const FLOW_NODES = { left: 6, right: 4 } as const;

export const CLEANUP_SETS = ["invalid-empty", "valid-empty"] as const;
export type CleanupSet = (typeof CLEANUP_SETS)[number];

const LENS_LABELS: Record<Lens, string> = {
  tags: "Tags in use",
  viewers: "Readers",
  owners: "Owners",
  kinds: "Kinds",
  cleanup: "Cleanup",
};

const LENS_TITLES: Record<Exclude<Lens, "kinds">, string> = {
  tags: "Tags holding records · largest first",
  viewers: "Records per reader group · acl.viewers",
  owners: "Records per owner group · acl.owners",
  cleanup: "Hold records, need a decision",
};

const n = (v: number | null | undefined): string =>
  v === null || v === undefined ? "?" : v.toLocaleString("en-US");

function share(v: number | null, total: number): string {
  if (v === null || total <= 0) return "";
  const p = (v / total) * 100;
  return p >= 10 ? `${Math.round(p)}%` : p >= 0.1 ? `${p.toFixed(1)}%` : "<0.1%";
}

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
  usage?: TagUsage;
  domain?: string;
  now: Date;
}

function inputs(rt: Runtime): Inputs {
  const kinds = rt.cache.get<KindCounts>(KINDS_AREA).data;
  const legal = rt.cache.get<LegalTags>(LEGAL_AREA).data;
  const facets = rt.cache.get<Facets>(FACETS_AREA).data;
  const domain = rt.profile?.entitlementsDomain;
  const now = rt.now();
  const usage = legal && facets?.tags ? tagUsage(legal, facets.tags, now) : undefined;
  return {
    ...(kinds ? { kinds } : {}),
    ...(legal ? { legal } : {}),
    ...(facets ? { facets } : {}),
    ...(usage ? { usage } : {}),
    ...(domain ? { domain } : {}),
    now,
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

// Valid tags that hold records, most records first. Without counts, every valid tag at "?".
function tagEntries(i: Inputs): Entry[] {
  if (i.usage) {
    return capped(
      i.usage.inUse.map((u) => ({
        key: u.tag.name,
        label: u.tag.name,
        count: u.count,
        ...(u.daysLeft !== undefined
          ? { chip: { label: `${u.daysLeft} d`, tone: "warn" as const } }
          : { glyph: "ok" as const }),
      })),
      MAP_ROWS,
      "tags in use",
    );
  }
  if (i.legal) {
    return capped(
      i.legal.valid.map((t) => ({ key: t.name, label: t.name, count: null, glyph: "neutral" })),
      MAP_ROWS,
      "tags",
    );
  }
  return capped(
    (i.facets?.tags ?? []).map((b) => ({
      key: b.key,
      label: b.key,
      count: b.count,
      glyph: "neutral",
    })),
    MAP_ROWS,
    "tags",
  );
}

// Tags that hold records but need a decision: invalid ones, then ones the legal service does not list.
function cleanupEntries(i: Inputs): Entry[] {
  if (!i.usage) return [];
  return [
    ...i.usage.invalidHeld.map((u) => ({
      key: u.tag.name,
      label: u.tag.name,
      count: u.count,
      chip: { label: "invalid", tone: "error" as const },
      ...(u.tag.expirationDate ? { trailing: `expired ${u.tag.expirationDate}` } : {}),
    })),
    ...i.usage.unlisted.map((b) => ({
      key: b.key,
      label: b.key,
      count: b.count,
      chip: { label: "not listed", tone: "caution" as const },
    })),
  ];
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
  if (lens === "cleanup") return cleanupEntries(i);
  if (lens === "kinds") return i.kinds ? kindEntries(rt, i.kinds) : [];
  const buckets = i.facets?.[lens];
  return buckets ? groupEntries(buckets, i.domain) : [];
}

// The row the profile shows: the operator's pick while it is still drawn, else the largest.
export function focusOf(rt: Runtime, lens: Lens): Selection | undefined {
  const entries = lensEntries(rt, lens).filter((e) => !e.summary);
  const state = mapState(rt);
  const key = state.selection?.lens === lens ? state.selection.key : state.picks?.[lens];
  const kept = key === undefined ? undefined : entries.find((e) => e.key === key);
  const pick = kept ?? entries[0];
  return pick ? { lens, key: pick.key, label: pick.label } : undefined;
}

// The names Copy hands off, so a delete script never needs them retyped.
export function cleanupNames(rt: Runtime, set: CleanupSet): string[] | undefined {
  const usage = inputs(rt).usage;
  if (!usage) return undefined;
  return (set === "invalid-empty" ? usage.invalidEmpty : usage.validEmpty).map((t) => t.name);
}

function totalOf(i: Inputs): number {
  return i.kinds?.visible ?? i.kinds?.total ?? 0;
}

function lensStrip(active: Lens, i: Inputs): Leaf {
  const u = i.usage;
  const counts: Record<Lens, number | null> = {
    tags: u ? u.inUse.length : (i.legal?.valid.length ?? i.facets?.tags?.length ?? null),
    viewers: i.facets?.viewers?.length ?? null,
    owners: i.facets?.owners?.length ?? null,
    kinds: i.kinds?.kinds.length ?? null,
    cleanup: u
      ? u.invalidHeld.length + u.unlisted.length + u.invalidEmpty.length + u.validEmpty.length
      : null,
  };
  const held = u ? u.invalidHeld.length + u.unlisted.length : 0;
  return {
    kind: "actions",
    wrap: true,
    items: LENSES.map((lens) => ({
      type: MAP_LENS_ACTION,
      label:
        counts[lens] === null ? LENS_LABELS[lens] : `${LENS_LABELS[lens]} · ${n(counts[lens])}`,
      payload: { lens },
      selected: lens === active,
      ...(lens === "cleanup" && held > 0
        ? {
            glyph: "●",
            tone: "error" as const,
            hint: `${n(held)} ${held === 1 ? "tag that needs a decision holds" : "tags that need a decision hold"} records`,
          }
        : {}),
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

function lensTitle(rt: Runtime, lens: Lens, i: Inputs, entries: Entry[]): string {
  if (lens === "kinds") return `Records per ${GROUP_LABELS[groupBy(rt)].toLowerCase()}`;
  if (lens === "tags" && i.usage && i.legal) {
    const all = i.legal.valid.length + i.legal.invalid.length;
    return `Tags holding records · ${n(i.usage.inUse.length)} of ${n(all)} · largest first`;
  }
  if (lens === "cleanup") return `${LENS_TITLES.cleanup} · ${n(entries.length)}`;
  return LENS_TITLES[lens];
}

function lensRows(rt: Runtime, lens: Lens, i: Inputs): Leaf[] {
  const entries = lensEntries(rt, lens);
  const title = lensTitle(rt, lens, i, entries);
  const missing = lensMissing(rt, lens, i);
  if (missing) return [{ kind: "rows", title, items: [missing] }];
  if (lens === "cleanup" && entries.length === 0) {
    return [
      {
        kind: "rows",
        title,
        items: [{ glyph: "ok", text: "No invalid or unlisted tag holds records." }],
      },
    ];
  }
  const sel = focusOf(rt, lens)?.key;
  const total = totalOf(i);
  // Bars scale to the largest row so a long tail still reads; the share says the rest.
  const max = Math.max(1, ...entries.filter((e) => !e.summary).map((e) => e.count ?? 0));
  const items: Row[] = entries.map((e) => {
    const pct = lens === "cleanup" || e.summary ? "" : share(e.count, total);
    const count = pct ? `${n(e.count)} · ${pct}` : n(e.count);
    return {
      ...(e.chip ? { chip: e.chip } : { glyph: e.glyph ?? "neutral" }),
      text: e.label,
      trailing: e.trailing ? `${count} · ${e.trailing}` : count,
      ...(e.summary || lens === "cleanup"
        ? {}
        : { bar: { value: e.count, total: Math.max(max, e.count ?? 0) } }),
      // Kept while signed out: the selected row needs its action, and select says why it refuses.
      ...(e.summary ? {} : { action: { type: MAP_SELECT_ACTION, payload: { lens, key: e.key } } }),
      ...(!e.summary && e.key === sel ? { selected: true } : {}),
    };
  });
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
  if (lens === "cleanup" && i.usage) return undefined;
  if ((lens === "viewers" || lens === "owners") && i.facets?.[lens]) return undefined;
  const facet = lens === "cleanup" || lens === "tags" ? "tags" : lens;
  const why = i.facets?.errors[facet] ?? rt.cache.get(FACETS_AREA).error;
  if (lens === "cleanup" && !why && !i.legal) {
    return { glyph: "neutral", text: "Legal tags are not read yet." };
  }
  return why
    ? { glyph: "warn", text: `Not measured: search did not count ${lensField(lens)} (${why}).` }
    : { glyph: "neutral", text: "Not measured yet." };
}

function caption(rt: Runtime, lens: Lens, i: Inputs, locked: boolean): Leaf {
  const rows: Row[] = [];
  if (lens === "tags" && i.legal && !i.facets?.tags) {
    const why = i.facets?.errors.tags ?? rt.cache.get(FACETS_AREA).error;
    rows.push({
      glyph: "warn",
      text: `Records per tag not measured${why ? `: ${why}` : ""}. Valid tags still list from the legal service.`,
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
      : lens === "cleanup"
        ? {
            glyph: "neutral",
            text: "Counts are records this sign-in can see. Deleting or extending a tag happens outside the rib.",
          }
        : {
            glyph: "neutral",
            text: "Bars scale to the largest row. A record can carry several tags and groups, so shares can add up past 100%.",
          },
  );
  return { kind: "rows", items: rows };
}

// ---- The flow: where the records sit, from one side to the other ----

interface Side {
  label: string;
  key: string;
  // Records on this node from the facet read, for its sublabel.
  count: number | null;
}

interface FlowPlan {
  left: string;
  right: string;
  title: string;
  links: { l: string; r: string; n: number }[];
  lefts: Map<string, Side>;
  rights: Map<string, Side>;
  note?: string;
}

const L = (key: string) => `l:${key}`;
const R = (key: string) => `r:${key}`;
const MORE_L = "l:\u0000more";
const MORE_R = "r:\u0000more";

function plan(rt: Runtime, flow: Flow, i: Inputs): FlowPlan {
  const counts = (buckets: Bucket[] | null | undefined) =>
    new Map((buckets ?? []).map((b) => [b.key, b.count]));
  const unread = flow.parts.filter((p) => !p.buckets);
  const note = unread.length
    ? `${n(unread.length)} not read: ${unread[0]?.error ?? "search refused"}`
    : undefined;
  if (flow.lens === "kinds") {
    const by = groupBy(rt);
    const tagCounts = counts(i.facets?.tags);
    const links: FlowPlan["links"] = [];
    const lefts = new Map<string, Side>();
    const rights = new Map<string, Side>();
    for (const part of flow.parts) {
      if (!part.buckets) continue;
      rights.set(part.key, {
        key: part.key,
        label: part.key,
        count: tagCounts.get(part.key) ?? null,
      });
      const groups = groupKinds(
        part.buckets.map((b) => ({ kind: b.key, count: b.count })),
        by,
      );
      for (const g of groups) {
        const all = groupKinds(i.kinds?.kinds ?? [], by).find((x) => x.pattern === g.pattern);
        lefts.set(g.pattern, { key: g.pattern, label: g.label, count: all?.count ?? null });
        links.push({ l: g.pattern, r: part.key, n: g.count });
      }
    }
    const shown =
      flow.parts.length < flow.of ? ` · showing ${n(flow.parts.length)} of ${n(flow.of)} tags` : "";
    return {
      left: GROUP_LABELS[by],
      right: "Legal tag",
      title: `Where the records sit · ${GROUP_LABELS[by].toLowerCase()} to legal tag${shown}`,
      links,
      lefts,
      rights,
      ...(note ? { note } : {}),
    };
  }
  const groupCounts = counts(flow.lens === "owners" ? i.facets?.owners : i.facets?.viewers);
  const tagCounts = counts(i.facets?.tags);
  const links: FlowPlan["links"] = [];
  const lefts = new Map<string, Side>();
  const rights = new Map<string, Side>();
  for (const part of flow.parts) {
    if (!part.buckets) continue;
    rights.set(part.key, {
      key: part.key,
      label: shortGroup(part.key, i.domain),
      count: groupCounts.get(part.key) ?? null,
    });
    for (const b of part.buckets) {
      lefts.set(b.key, { key: b.key, label: b.key, count: tagCounts.get(b.key) ?? null });
      links.push({ l: b.key, r: part.key, n: b.count });
    }
  }
  const noun = flow.lens === "owners" ? "who owns" : "who can read";
  const shown =
    flow.parts.length < flow.of ? ` · showing ${n(flow.parts.length)} of ${n(flow.of)} groups` : "";
  return {
    left: "Legal tag",
    right: flow.lens === "owners" ? "Who owns" : "Who can read",
    title: `Where the records sit · legal tag to ${noun}${shown}`,
    links,
    lefts,
    rights,
    ...(note ? { note } : {}),
  };
}

// Keeps the largest `cap` keys on a side, always keeping the selected one, and folds the rest.
function fold(
  totals: Map<string, number>,
  cap: number,
  keep: string | undefined,
): { kept: string[]; folded: string[] } {
  const order = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (order.length <= cap + 1) return { kept: order.map(([k]) => k), folded: [] };
  let kept = order.slice(0, cap).map(([k]) => k);
  if (keep && totals.has(keep) && !kept.includes(keep)) kept = [...kept.slice(0, cap - 1), keep];
  const set = new Set(kept);
  return { kept, folded: order.map(([k]) => k).filter((k) => !set.has(k)) };
}

function flowLeaf(
  rt: Runtime,
  lens: Exclude<Lens, "cleanup">,
  i: Inputs,
  sel: Selection | undefined,
  locked: boolean,
): Leaf[] {
  const read = mapState(rt).flow;
  const title = "Where the records sit";
  if (!read || ("data" in read && read.data.lens !== lens)) {
    return [
      {
        kind: "rows",
        title,
        items: [
          { glyph: "neutral", text: locked ? SIGNIN_REASON : "Reading where the records sit…" },
        ],
      },
    ];
  }
  if ("error" in read) {
    return [{ kind: "rows", title, items: [{ glyph: "error", text: `Not read: ${read.error}` }] }];
  }
  const p = plan(rt, read.data, i);
  if (p.links.length === 0) {
    return [{ kind: "rows", title, items: [{ glyph: "neutral", text: "No records to draw." }] }];
  }
  const sum = (side: "l" | "r") => {
    const m = new Map<string, number>();
    for (const link of p.links) m.set(link[side], (m.get(link[side]) ?? 0) + link.n);
    return m;
  };
  const selLeft = sel && (lens === "tags" || lens === "kinds") ? sel.key : undefined;
  const selRight = sel && (lens === "viewers" || lens === "owners") ? sel.key : undefined;
  const left = fold(sum("l"), FLOW_NODES.left, selLeft);
  const right = fold(sum("r"), FLOW_NODES.right, selRight);
  const total = totalOf(i);
  const sub = (count: number | null) =>
    count === null ? undefined : `${n(count)}${total > 0 ? ` · ${share(count, total)}` : ""}`;
  const node = (side: Side, id: string, s: "left" | "right", selected: boolean): FlowNode => {
    const label = sub(side.count);
    return {
      id,
      side: s,
      label: side.label,
      ...(label ? { sublabel: label } : {}),
      ...(selected ? { selected: true } : {}),
    };
  };
  const foldNode = (
    keys: string[],
    sides: Map<string, Side>,
    totals: Map<string, number>,
    id: string,
    s: "left" | "right",
    noun: string,
  ): FlowNode[] => {
    if (keys.length === 0) return [];
    const members = keys.map((k) => ({ label: sides.get(k)?.label ?? k, n: totals.get(k) ?? 0 }));
    const count = members.reduce((acc, m) => acc + m.n, 0);
    return [
      {
        id,
        side: s,
        label: `${n(keys.length)} more ${noun}`,
        sublabel: n(count),
        folded: members,
      },
    ];
  };
  const leftNoun = lens === "kinds" ? `${GROUP_LABELS[groupBy(rt)].toLowerCase()} groups` : "tags";
  const rightNoun = lens === "kinds" ? "tags" : "groups";
  const lTotals = sum("l");
  const rTotals = sum("r");
  const nodes: FlowNode[] = [
    ...left.kept.map((k) => node(p.lefts.get(k) as Side, L(k), "left", k === selLeft)),
    ...foldNode(left.folded, p.lefts, lTotals, MORE_L, "left", leftNoun),
    ...right.kept.map((k) => node(p.rights.get(k) as Side, R(k), "right", k === selRight)),
    ...foldNode(right.folded, p.rights, rTotals, MORE_R, "right", rightNoun),
  ];
  const lSet = new Set(left.kept);
  const rSet = new Set(right.kept);
  const merged = new Map<string, { source: string; target: string; n: number }>();
  for (const link of p.links) {
    const source = lSet.has(link.l) ? L(link.l) : MORE_L;
    const target = rSet.has(link.r) ? R(link.r) : MORE_R;
    const key = `${source}\u0000${target}`;
    const at = merged.get(key);
    if (at) at.n += link.n;
    else merged.set(key, { source, target, n: link.n });
  }
  const leaves: Leaf[] = [
    {
      kind: "flow",
      title: p.title,
      left: p.left,
      right: p.right,
      nodes,
      links: [...merged.values()].filter((l) => l.n > 0).sort((a, b) => b.n - a.n),
    },
  ];
  if (p.note) leaves.push({ kind: "rows", items: [{ glyph: "warn", text: p.note }] });
  return leaves;
}

// ---- The profile of the focused row ----

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

function profile(rt: Runtime, sel: Selection | undefined, i: Inputs, locked: boolean): Leaf[] {
  if (!sel) return [];
  const state = mapState(rt);
  const mine = state.selection?.lens === sel.lens && state.selection.key === sel.key;
  const read = mine ? state.slice : undefined;
  const slice = read && "data" in read ? read.data : undefined;
  const card =
    sel.lens === "tags" || sel.lens === "cleanup"
      ? tagCard(rt, sel, i, locked)
      : sel.lens === "kinds"
        ? kindCard(rt, sel, i, locked)
        : groupCard(rt, sel, slice, locked);
  const leaves: Leaf[] = [{ kind: "cards", items: [card] }];
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
  const groupRow = (b: Bucket): Row => ({
    glyph: "info",
    text: shortGroup(b.key, i.domain),
    trailing: n(b.count),
  });
  const count = countOf(rt, sel);
  if (sel.lens === "cleanup") {
    leaves.push(bucketRows("Who can read it", slice.viewers, slice.errors.viewers, groupRow));
  }
  if (sel.lens === "tags" || sel.lens === "cleanup") {
    leaves.push(bucketRows("Who owns it", slice.owners, slice.errors.owners, groupRow));
    leaves.push(coverBars(slice, count));
  } else if (sel.lens === "kinds") {
    leaves.push(bucketRows("Who can read it", slice.viewers, slice.errors.viewers, groupRow));
  } else {
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

// ---- Cleanup: the tags to review, with the empty ones as a compact grid ----

function cleanupBoard(rt: Runtime, i: Inputs, locked: boolean): Leaf[] {
  const u = i.usage;
  if (!u) return [];
  const sum = (xs: { count: number }[]) => xs.reduce((s, x) => s + x.count, 0);
  const held = [...u.invalidHeld, ...u.unlisted];
  const prefix = rt.profile?.partition ? `${rt.profile.partition}-` : "";
  const shortTag = (name: string) =>
    prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  const leaves: Leaf[] = [
    {
      kind: "stats",
      items: [
        {
          label: "Need a decision",
          value: n(held.length),
          sub: `${n(u.invalidHeld.length)} invalid · ${n(u.unlisted.length)} not listed · ${n(sum(held))} records`,
          ...(held.length > 0 ? { tone: "error" as const } : {}),
        },
        { label: "Invalid, empty", value: n(u.invalidEmpty.length), sub: "likely safe to delete" },
        { label: "Valid, empty", value: n(u.validEmpty.length), sub: "no visible records" },
        { label: "In use", value: n(u.inUse.length), sub: `hold ${n(sum(u.inUse))} records` },
      ],
    },
  ];
  if (held.length > 0) leaves.push(...profile(rt, focusOf(rt, "cleanup"), i, locked));
  const dropped = prefix ? ` · ${prefix} dropped` : "";
  if (u.invalidEmpty.length > 0) {
    leaves.push({
      kind: "grid",
      title: `Invalid, no records · ${n(u.invalidEmpty.length)}${dropped} · expired on`,
      cells: u.invalidEmpty.map((t) => ({
        label: shortTag(t.name),
        ...(t.expirationDate
          ? { badge: { text: t.expirationDate.slice(0, 7), tone: "neutral" as const } }
          : {}),
      })),
    });
  }
  if (u.validEmpty.length > 0) {
    leaves.push({
      kind: "grid",
      title: `Valid, no records · ${n(u.validEmpty.length)}${dropped}`,
      cells: u.validEmpty.map((t) => ({
        label: shortTag(t.name),
        badge: { text: "valid", tone: "ok" as const },
      })),
    });
  }
  const copies: NonNullable<Card["fields"]> = [];
  const copy = (set: CleanupSet, label: string, count: number) => {
    if (count === 0) return;
    copies.push({
      label,
      value: `${n(count)} ${count === 1 ? "name" : "names"}`,
      ...(locked ? {} : { copyAction: { type: MAP_COPY_ACTION, payload: { set } } }),
    });
  };
  copy("invalid-empty", "invalid, no records", u.invalidEmpty.length);
  copy("valid-empty", "valid, no records", u.validEmpty.length);
  if (copies.length > 0) {
    leaves.push({
      kind: "cards",
      items: [
        {
          title: "Copy names",
          fields: copies,
          reason: { text: "The rib only lists them; deleting a tag happens outside the rib." },
        },
      ],
    });
  }
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
  left.push(...lensRows(rt, lens, i), caption(rt, lens, i, locked));
  const sel = focusOf(rt, lens);
  const right =
    lens === "cleanup"
      ? cleanupBoard(rt, i, locked)
      : [...flowLeaf(rt, lens, i, sel, locked), ...profile(rt, sel, i, locked)];
  const fresh = rt.freshness(FACETS_AREA) ?? rt.freshness(KINDS_AREA);
  return {
    view: "board",
    header: fresh ? { chip: fresh } : {},
    sections: [
      {
        kind: "columns",
        columns: [
          { weight: 5, sections: left },
          { weight: 7, sections: right },
        ],
      },
    ],
  };
}
