// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import type { Store } from "../store.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const ID_TYPES = ["object", "app", "email", "group"] as const;
export type IdType = (typeof ID_TYPES)[number];

// The tenant, the identifier type and the value. Email is never the key for an
// identity that has an object id, because a guest's address can change.
export interface IdentityKey {
  tenant: string;
  type: IdType;
  value: string;
}

export function keyOf(k: IdentityKey): string {
  return `${k.type}:${k.tenant.toLowerCase()}:${k.value.toLowerCase()}`;
}

export function parseKey(text: string): IdentityKey | undefined {
  const [type, tenant, ...rest] = text.split(":");
  const value = rest.join(":");
  if (!type || !tenant || !value || !(ID_TYPES as readonly string[]).includes(type)) {
    return undefined;
  }
  return { type: type as IdType, tenant, value };
}

export const ANNOTATION_KINDS = ["person", "application", "historical-actor", "service"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const ANNOTATION_KIND_LABEL: Record<AnnotationKind, string> = {
  person: "person",
  application: "application",
  "historical-actor": "historical actor",
  service: "service account",
};

const text = z.string().trim().min(1).max(200);

const annotationSchema = z.object({
  label: text.optional(),
  kind: z.enum(ANNOTATION_KINDS).optional(),
  organization: text.optional(),
  formerAddresses: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
  responsibility: text.optional(),
  note: z.string().trim().min(1).max(1000).optional(),
  source: z.object({
    from: z.enum(["operator", "handbook"]),
    at: z.string().regex(DAY),
  }),
});
export type Annotation = z.infer<typeof annotationSchema>;

const fileSchema = z.object({ entries: z.record(z.string(), annotationSchema) });
type AnnotationsFile = z.infer<typeof fileSchema>;

// What an operator may set on one identity; an empty field clears it.
export const annotationInputSchema = z.object({
  label: z.string().trim().max(200).optional(),
  kind: z.union([z.enum(ANNOTATION_KINDS), z.literal("")]).optional(),
  organization: z.string().trim().max(200).optional(),
  formerAddresses: z.string().trim().max(2000).optional(),
  responsibility: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type AnnotationInput = z.infer<typeof annotationInputSchema>;

export type SaveResult = { ok: true } | { ok: false; error: string };

// One file per instance, beside the tracker.
export function annotationsFile(profile: { host: string; partition: string } | undefined): string {
  return profile ? `directory.${profile.host}.${profile.partition}.json` : "directory.json";
}

function addressList(raw: string | undefined): string[] | string {
  const list = (raw ?? "")
    .split(/[\s,;]+/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.find((a) => !z.string().email().safeParse(a).success);
  return bad ? `${bad} is not an email address` : [...new Set(list)];
}

// What only the operator knows about an identity, each entry with its source and date.
// Annotations name and describe; they never override a directory fact and never grant.
export class Annotations {
  private file: AnnotationsFile;
  readonly unreadable: boolean;

  constructor(
    private readonly store: Store,
    private readonly name: string,
  ) {
    const read = store.read(name, fileSchema);
    this.unreadable = read === undefined && store.exists(name);
    this.file = read ?? { entries: {} };
  }

  get(key: string): Annotation | undefined {
    return this.file.entries[key];
  }

  get entries(): Readonly<Record<string, Annotation>> {
    return this.file.entries;
  }

  set(key: string, input: AnnotationInput, now: Date): SaveResult {
    if (this.unreadable) {
      return {
        ok: false,
        error: `${this.name} could not be read. Fix or remove it, then restart.`,
      };
    }
    if (!parseKey(key)) return { ok: false, error: "That identity key is not valid." };
    const former = addressList(input.formerAddresses);
    if (typeof former === "string") return { ok: false, error: former };
    const value = (s: string | undefined) => (s?.trim() ? s.trim() : undefined);
    const next: Omit<Annotation, "source"> = {
      ...(value(input.label) ? { label: value(input.label) } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(value(input.organization) ? { organization: value(input.organization) } : {}),
      ...(former.length > 0 ? { formerAddresses: former } : {}),
      ...(value(input.responsibility) ? { responsibility: value(input.responsibility) } : {}),
      ...(value(input.note) ? { note: value(input.note) } : {}),
    };
    const entries = { ...this.file.entries };
    if (Object.keys(next).length === 0) {
      delete entries[key];
    } else {
      const parsed = annotationSchema.safeParse({
        ...next,
        source: { from: "operator", at: now.toISOString().slice(0, 10) },
      });
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
      }
      entries[key] = parsed.data;
    }
    this.file = { entries };
    this.store.write(this.name, this.file);
    return { ok: true };
  }
}
