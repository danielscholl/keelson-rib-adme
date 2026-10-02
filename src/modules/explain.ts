// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { cachedGroups, type Evidence, explain, recordExplanation } from "../access/explain.ts";
import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import { measuredAccess } from "../boards/access.ts";
import { EXPLAIN_ACTION } from "../boards/change.ts";
import { composeExplain } from "../boards/explain.ts";
import { EXPLAIN_KEY } from "../keys.ts";
import { bindingOf, sameBinding } from "../plan/model.ts";
import type { RegionModule } from "../region.ts";
import type { Runtime } from "../runtime.ts";

type Payload = Record<string, unknown>;

function str(p: Payload, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// The answer stays available while sign-in is needed, from the cached sweep.
async function evidenceFor(
  rt: Runtime,
  id: string,
  cached: string[] | undefined,
  sweptAt: string | undefined,
): Promise<Evidence> {
  const fallback = (failure?: string): Evidence => ({
    source: "cached",
    ...(cached ? { groups: cached } : {}),
    ...(sweptAt ? { sweptAt } : {}),
    ...(failure ? { failure } : {}),
  });
  if (rt.status.phase !== "connected") return fallback("sign-in needed");
  const res = await rt.run((b) =>
    b.adme<{ groups?: { email?: string }[] }>(
      "entitlements",
      `/members/${encodeURIComponent(id)}/groups?type=NONE`,
    ),
  );
  if (!res.ok) return fallback(`effective groups read failed: ${res.failure.message}`);
  const groups = (res.data.groups ?? []).flatMap((g) => (g.email ? [g.email.toLowerCase()] : []));
  return { source: "live", groups: [...new Set(groups)] };
}

export const explainModule: RegionModule = {
  composers: { [EXPLAIN_KEY]: composeExplain },
  actions: {
    [EXPLAIN_ACTION]: async (rt, payload) => {
      const p: Payload = payload && typeof payload === "object" ? (payload as Payload) : {};
      const profile = rt.profile;
      if (!profile) return { ok: false, error: "Not connected." };
      const drawn = {
        host: str(p, "host") ?? "",
        partition: str(p, "partition") ?? "",
        tenantId: str(p, "tenantId") ?? "",
      };
      if (!sameBinding(drawn, bindingOf(profile))) {
        return {
          ok: false,
          error: "This board was drawn for another instance. Refresh and try again.",
        };
      }
      const id = str(p, "id");
      if (!id) return { ok: false, error: "Pick a person." };
      const domain = profile.entitlementsDomain;
      const area = rt.cache.get<AccessRead>(ACCESS_AREA);
      const person = measuredAccess(rt)?.model.people.find((x) => x.id === id);
      if (!domain || !person) {
        return { ok: false, error: "That person is not in the last sweep. Refresh and try again." };
      }
      const closures = area.data?.closures;
      const evidence = await evidenceFor(rt, id, cachedGroups(person, closures), area.at);
      recordExplanation(
        rt,
        explain({ person, profile, domain, closures, evidence, now: rt.now() }),
      );
      rt.recompose([EXPLAIN_KEY]);
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: EXPLAIN_KEY,
          title: `Why 401/403 · ${person.name}`,
          placement: "side",
        },
      };
    },
  },
};
