// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import type { Batch, CallFailure, CallResult } from "./client.ts";
import type { Profile } from "./profile.ts";

export const CAPABILITY_IDS = [
  "own-groups",
  "all-groups",
  "invite",
  "deleted-users",
  "seismic-list",
  "partition",
  "kind-counts",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

const capabilitySchema = z.object({
  id: z.enum(CAPABILITY_IDS),
  // "yes", "no", an HTTP status such as "403", or "?" when the probe could not tell.
  result: z.string(),
  detail: z.string().optional(),
});
export type Capability = z.infer<typeof capabilitySchema>;

export const testResultSchema = z.object({
  testedAt: z.string(),
  signedInAs: z.string().optional(),
  capabilities: z.array(capabilitySchema),
});
export type TestResult = z.infer<typeof testResultSchema>;

export const CAPABILITY_LABELS: Record<CapabilityId, { label: string; source: string }> = {
  "own-groups": { label: "List my own groups", source: "entitlements /groups" },
  "all-groups": { label: "List every group", source: "entitlements /groups/all" },
  invite: { label: "Invite guests", source: "Graph authorization policy" },
  "deleted-users": { label: "Read deleted users", source: "Graph /directory/deletedItems" },
  "seismic-list": { label: "List seismic subprojects", source: "seismic /subproject/tenant" },
  partition: { label: "Partition API", source: "partition /partitions" },
  "kind-counts": { label: "Count records by kind", source: "search aggregateBy kind" },
};

export type Phase = "firstrun" | "connected" | "signin" | "profile-error";

// What the operator sees about the connection. Token lifetime never appears.
export interface ConnectionStatus {
  phase: Phase;
  profile?: Profile;
  test?: TestResult;
  error?: string;
}

export function signinCommand(profile: Profile | undefined): string {
  return profile ? `az login --tenant ${profile.tenantId}` : "az login";
}

export function capability(test: TestResult | undefined, id: CapabilityId): string | undefined {
  return test?.capabilities.find((c) => c.id === id)?.result;
}

export type ProbeOutcome =
  | { kind: "signin"; message: string }
  | { kind: "profile"; message: string }
  | { kind: "tested"; result: TestResult; reachable: boolean; message?: string };

function fromCall(id: CapabilityId, res: CallResult<unknown>): Capability {
  if (res.ok) return { id, result: "yes" };
  const f = res.failure;
  if (f.kind === "forbidden")
    return { id, result: "403", detail: "not permitted for this sign-in" };
  if (f.status) return { id, result: String(f.status), detail: f.message };
  return { id, result: "?", detail: f.message };
}

function tokenFailure(f: CallFailure): ProbeOutcome | undefined {
  if (f.kind === "signin" && f.status === null) return { kind: "signin", message: f.message };
  if (f.kind === "profile" || f.kind === "az-missing" || f.kind === "timeout") {
    return { kind: "profile", message: f.message };
  }
  return undefined;
}

interface Me {
  userPrincipalName?: string;
  mail?: string;
  userType?: string;
}

const MEMBER_INVITE_POLICIES = new Set(["everyone", "adminsGuestInvitersAndAllMembers"]);

// About seven read-only calls that record what this sign-in can and cannot do.
export async function probeConnection(batch: Batch, now: () => Date): Promise<ProbeOutcome> {
  const p = batch.profile;
  const [me, ownGroups] = await Promise.all([
    batch.graph<Me>("/v1.0/me?$select=userPrincipalName,mail,userType"),
    batch.adme("entitlements", "/groups"),
  ]);
  for (const res of [me, ownGroups]) {
    if (!res.ok) {
      const stop = tokenFailure(res.failure);
      if (stop) return stop;
    }
  }

  const [allGroups, policy, deleted, seismic, partition, kinds] = await Promise.all([
    batch.adme("entitlements", "/groups/all?type=NONE&limit=1"),
    batch.graph<{ allowInvitesFrom?: string }>("/v1.0/policies/authorizationPolicy"),
    batch.graph("/v1.0/directory/deletedItems/microsoft.graph.user?$top=1&$select=id"),
    batch.adme("seismic", `/subproject/tenant/${encodeURIComponent(p.partition)}`),
    batch.adme("partition", "/partitions"),
    batch.adme("search", "/query", {
      method: "POST",
      body: { kind: "*:*:*:*", query: "*", limit: 1, aggregateBy: "kind" },
    }),
  ]);

  let invite: Capability;
  if (!policy.ok) {
    invite = { id: "invite", result: "?", detail: policy.failure.message };
  } else if (policy.data.allowInvitesFrom === "none") {
    invite = { id: "invite", result: "no", detail: "guest invitations are off in this tenant" };
  } else if (
    me.ok &&
    me.data.userType === "Member" &&
    MEMBER_INVITE_POLICIES.has(policy.data.allowInvitesFrom ?? "")
  ) {
    invite = { id: "invite", result: "yes" };
  } else {
    invite = {
      id: "invite",
      result: "?",
      detail: "needs the Guest Inviter role; confirmed on the first invitation",
    };
  }

  const allGroupsCap = fromCall("all-groups", allGroups);
  if (!allGroups.ok && allGroups.failure.kind === "client") {
    allGroupsCap.result = "?";
    allGroupsCap.detail = "not available on this entitlements version";
  }

  const result: TestResult = {
    testedAt: now().toISOString(),
    ...(me.ok ? { signedInAs: me.data.mail ?? me.data.userPrincipalName } : {}),
    capabilities: [
      fromCall("own-groups", ownGroups),
      allGroupsCap,
      invite,
      fromCall("deleted-users", deleted),
      fromCall("seismic-list", seismic),
      fromCall("partition", partition),
      fromCall("kind-counts", kinds),
    ],
  };
  if (!ownGroups.ok) {
    return {
      kind: "tested",
      result,
      reachable: false,
      message:
        ownGroups.failure.kind === "signin"
          ? "ADME answered 401 to this sign-in. Check the ADME app id, and that the account is in users@."
          : `ADME did not answer: ${ownGroups.failure.message}`,
    };
  }
  return { kind: "tested", result, reachable: true };
}
