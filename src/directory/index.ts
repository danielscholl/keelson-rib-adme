// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { NO_ORG, orgOf } from "../access/orgs.ts";
import type { DirectoryEntry } from "../access/read.ts";
import { shortId } from "../profile.ts";
import { type Annotation, type IdType, keyOf } from "./annotations.ts";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Kind = "person" | "app" | "group" | "unknown";

// Where the name an identity shows came from.
export type NameSource = "directory" | "label" | "id";

export interface Resolved {
  // The id the instance lists: an object id, an app id, or an email.
  id: string;
  key: string;
  type: IdType;
  kind: Kind;
  name: string;
  nameSource: NameSource;
  email?: string;
  addresses: string[];
  former: string[];
  annotation?: Annotation;
  historical: boolean;
  deleted: boolean;
  org: { name: string; domain: string; from: "annotation" | "email" | "none" };
  you: boolean;
  root: boolean;
  appId?: string;
  guest: boolean;
}

export interface DirectoryInput {
  tenant: string;
  // Directory entries by object id or app id, in order of trust; the first hit wins.
  entries: readonly (Record<string, DirectoryEntry> | undefined)[];
  annotations: Readonly<Record<string, Annotation>>;
  deleted?: readonly string[] | undefined;
  admeAppId?: string | undefined;
  signedInAs?: string | undefined;
  // The operator's own id when entitlements reported it.
  you?: string | undefined;
}

function addressesOf(entry: DirectoryEntry | undefined): string[] {
  return [entry?.mail, entry?.upn, ...(entry?.otherMails ?? [])]
    .filter((a): a is string => Boolean(a))
    .map((a) => a.toLowerCase());
}

function isGroupEmail(id: string): boolean {
  return /^(users|data|service)\./.test(id) && id.includes("@");
}

// One resolver for every id the rib shows: role members, seismic members, record
// creators and plan rows. A directory name always leads; an operator label names
// only what the directory cannot.
export class Directory {
  private readonly byId = new Map<string, DirectoryEntry>();
  private readonly byAddress = new Map<string, string>();
  private readonly deleted: Set<string>;
  private readonly cache = new Map<string, Resolved>();
  readonly tenant: string;

  constructor(private readonly input: DirectoryInput) {
    this.tenant = input.tenant.toLowerCase();
    this.deleted = new Set(input.deleted ?? []);
    for (const dir of input.entries) {
      for (const [id, entry] of Object.entries(dir ?? {})) {
        if (!this.byId.has(id)) this.byId.set(id, entry);
        if (entry.kind === "app" && entry.appId && !this.byId.has(entry.appId)) {
          this.byId.set(entry.appId, entry);
        }
        if (entry.kind !== "user") continue;
        for (const a of addressesOf(entry)) if (!this.byAddress.has(a)) this.byAddress.set(a, id);
      }
    }
    for (const [key, a] of Object.entries(input.annotations)) {
      const id = key.split(":").slice(2).join(":");
      for (const f of a.formerAddresses ?? [])
        if (!this.byAddress.has(f)) this.byAddress.set(f, id);
    }
  }

  get annotations(): Readonly<Record<string, Annotation>> {
    return this.input.annotations;
  }

  keyFor(id: string, type?: IdType): string {
    return keyOf({ tenant: this.tenant, type: type ?? this.typeOf(id), value: id });
  }

  private typeOf(id: string): IdType {
    if (isGroupEmail(id)) return "group";
    if (id.includes("@")) return "email";
    const entry = this.byId.get(id);
    if (entry?.kind === "app" && (entry.appId === id || entry.appId === undefined)) return "app";
    if (id === this.input.admeAppId?.toLowerCase()) return "app";
    return "object";
  }

  // The object id an email resolves to, when the directory or a former address knows it.
  idOf(address: string): string | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  resolve(raw: string): Resolved {
    const id = raw.toLowerCase();
    const hit = this.cache.get(id);
    if (hit) return hit;
    const resolved = this.build(id);
    this.cache.set(id, resolved);
    return resolved;
  }

  private annotation(id: string, type: IdType): Annotation | undefined {
    const a = this.input.annotations;
    return (
      a[keyOf({ tenant: this.tenant, type, value: id })] ??
      (type === "app" ? a[keyOf({ tenant: this.tenant, type: "object", value: id })] : undefined) ??
      (type === "object" ? a[keyOf({ tenant: this.tenant, type: "app", value: id })] : undefined)
    );
  }

  private build(id: string): Resolved {
    if (id.includes("@") && !isGroupEmail(id)) {
      const target = this.byAddress.get(id);
      if (target && target !== id) return { ...this.resolve(target) };
    }
    const type = this.typeOf(id);
    const key = keyOf({ tenant: this.tenant, type, value: id });
    const annotation = this.annotation(id, type);
    const entry = type === "group" ? undefined : this.byId.get(id);
    const label = annotation?.label;
    const historical = annotation?.kind === "historical-actor";
    const root = id === this.input.admeAppId?.toLowerCase();
    const base = {
      id,
      key,
      type,
      ...(annotation ? { annotation } : {}),
      former: annotation?.formerAddresses ?? [],
      historical,
      deleted: this.deleted.has(id),
      root,
    };
    if (type === "group") {
      return {
        ...base,
        kind: "group",
        name: id.split("@")[0] ?? id,
        nameSource: "directory",
        addresses: [],
        org: { ...NO_ORG, from: "none" },
        you: false,
        guest: false,
      };
    }
    if (entry?.kind === "app" || (!entry && root)) {
      return {
        ...base,
        kind: "app",
        name: entry?.name ?? label ?? shortId(id),
        nameSource: entry ? "directory" : label ? "label" : "id",
        addresses: [],
        org: annotation?.organization
          ? { name: annotation.organization, domain: "", from: "annotation" }
          : { ...NO_ORG, from: "none" },
        you: false,
        appId: entry?.appId ?? id,
        guest: false,
      };
    }
    if (entry?.kind === "user") {
      const addresses = addressesOf(entry);
      const email = entry.mail ?? entry.upn;
      const signedIn = this.input.signedInAs?.toLowerCase();
      const emailOrg = orgOf(email ? { email } : {});
      return {
        ...base,
        kind: "person",
        name: entry.name,
        nameSource: "directory",
        ...(email ? { email } : {}),
        addresses,
        org: annotation?.organization
          ? { name: annotation.organization, domain: emailOrg.domain, from: "annotation" }
          : { ...emailOrg, from: email ? "email" : "none" },
        you:
          id === this.input.you?.toLowerCase() ||
          (signedIn !== undefined && addresses.includes(signedIn)),
        guest: entry.guest ?? false,
      };
    }
    const kind: Kind =
      annotation?.kind === "person"
        ? "person"
        : annotation?.kind === "application"
          ? "app"
          : "unknown";
    return {
      ...base,
      kind,
      name: label ?? (id.includes("@") ? id : shortId(id)),
      nameSource: label ? "label" : "id",
      ...(id.includes("@") ? { email: id } : {}),
      addresses: id.includes("@") ? [id] : [],
      org: annotation?.organization
        ? { name: annotation.organization, domain: "", from: "annotation" }
        : { ...NO_ORG, from: "none" },
      you: id === this.input.you?.toLowerCase(),
      guest: false,
    };
  }

  // True when nothing names this id: not the directory and not an operator label.
  unresolved(id: string): boolean {
    const r = this.resolve(id);
    return r.kind !== "group" && r.nameSource === "id" && GUID.test(r.id);
  }
}

// The text a search box matches for one identity: names, addresses past and present,
// the operator label and the ids.
export function searchText(r: Resolved): string {
  return [
    r.name,
    r.email,
    ...r.addresses,
    ...r.former,
    r.annotation?.label,
    r.annotation?.organization,
    r.annotation?.responsibility,
    r.org.name,
    r.id,
    r.appId,
  ]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase())
    .join(" ");
}
