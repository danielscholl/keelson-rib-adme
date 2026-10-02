// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { AccessModel, Identity } from "../access/model.ts";
import type { Batch, CallResult } from "../client.ts";
import { shortId } from "../profile.ts";
import type { Classification, Excluded } from "./model.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Classified {
  address: string;
  classification: Classification;
  oid?: string;
  name?: string;
  identity?: Identity;
  blocked: boolean;
  reason?: string;
}

interface GraphUser {
  id?: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  otherMails?: string[];
  userType?: string;
}

export function parseAddresses(text: string): { addresses: string[]; excluded: Excluded[] } {
  const addresses: string[] = [];
  const excluded: Excluded[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const address = raw.trim().toLowerCase();
    if (!address) continue;
    if (!EMAIL.test(address))
      excluded.push({ address: raw.trim(), reason: "not an email address" });
    else if (addresses.includes(address)) excluded.push({ address, reason: "listed twice" });
    else addresses.push(address);
  }
  return { addresses, excluded };
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function graphPath(base: string, filter: string, select: string): string {
  return `${base}?$filter=${encodeURIComponent(filter)}&$select=${select}`;
}

// The address's own account wins; an account that only lists it under otherMails is the
// same home identity reached through another address.
export async function classifyAddress(
  batch: Batch,
  address: string,
  model: AccessModel | undefined,
): Promise<CallResult<Classified>> {
  const q = quote(address);
  const users = await batch.graph<{ value?: GraphUser[] }>(
    graphPath(
      "/v1.0/users",
      `mail eq ${q} or otherMails/any(c:c eq ${q}) or userPrincipalName eq ${q}`,
      "id,displayName,mail,userPrincipalName,otherMails,userType",
    ),
  );
  if (!users.ok) return users;
  const found = users.data.value ?? [];
  if (found.length > 1) {
    return ok({
      address,
      classification: "ambiguous",
      blocked: true,
      reason: `${found.length} accounts answer to this address. Resolve it in Entra first.`,
    });
  }
  const user = found[0];
  if (!user?.id) {
    const deleted = await batch.graph<{ value?: GraphUser[] }>(
      graphPath(
        "/v1.0/directory/deletedItems/microsoft.graph.user",
        `mail eq ${q}`,
        "id,displayName,mail",
      ),
    );
    if (!deleted.ok) return deleted;
    const gone = deleted.data.value ?? [];
    if (gone.length > 1) {
      return ok({
        address,
        classification: "ambiguous",
        blocked: true,
        reason: `${gone.length} deleted accounts used this address. Restore one in Entra first.`,
      });
    }
    const restorable = gone[0];
    if (restorable?.id) {
      return ok({
        address,
        classification: "restorable",
        oid: restorable.id.toLowerCase(),
        ...(restorable.displayName ? { name: restorable.displayName } : {}),
        blocked: false,
      });
    }
    return ok({ address, classification: "will-invite", blocked: false });
  }
  const oid = user.id.toLowerCase();
  const identity = model?.people.find((p) => p.id === oid);
  const name = user.displayName ?? identity?.name;
  const primary = [user.mail, user.userPrincipalName].some((a) => a?.toLowerCase() === address);
  if (!primary && identity) {
    return ok({
      address,
      classification: "same-identity",
      oid,
      ...(name ? { name } : {}),
      identity,
      blocked: true,
      reason: `Same home identity as ${name ?? "an existing person"} (${shortId(oid)}). No invite, no second account. Use their existing entry.`,
    });
  }
  return ok({
    address,
    classification: identity
      ? "has-access"
      : user.userType === "Guest"
        ? "existing-guest"
        : "existing-member",
    oid,
    ...(name ? { name } : {}),
    ...(identity ? { identity } : {}),
    blocked: false,
  });
}

function ok(c: Classified): CallResult<Classified> {
  return { ok: true, status: 200, data: c };
}
