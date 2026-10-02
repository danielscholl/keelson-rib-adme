// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// The values that describe one instance. None is secret. The entitlements
// domain is read from the instance by Test connection when it is left out.
export const profileSchema = z
  .object({
    host: z
      .string()
      .trim()
      .transform((h) => h.replace(/^https?:\/\//, "").replace(/\/+$/, ""))
      .pipe(z.string().regex(/^[a-z0-9.-]+$/i, "host is a bare hostname")),
    partition: z.string().trim().min(1),
    entitlementsDomain: z.preprocess(blank, z.string().trim().min(1).optional()),
    tenantId: z.string().trim().regex(GUID, "tenant id is a GUID"),
    admeAppId: z.string().trim().regex(GUID, "ADME app id is a GUID"),
    rosterGroupId: z.preprocess(
      blank,
      z.string().trim().regex(GUID, "roster group id is a GUID").optional(),
    ),
  })
  .strict();

export type Profile = z.infer<typeof profileSchema>;

export function instanceName(profile: Profile): string {
  return profile.host.split(".")[0] ?? profile.host;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}
