import { expect } from "bun:test";
import { ACCESS_AREA } from "../../src/access/read";
import { HEALTH_AREA } from "../../src/data/health";
import { planModule } from "../../src/modules/plan";
import { seismicModule } from "../../src/modules/seismic";
import { operationPending } from "../../src/plan/apply";
import { bindingOf } from "../../src/plan/model";
import { planState } from "../../src/plan/state";
import type { Runtime } from "../../src/runtime";
import { SEISMIC_AREA, type SeismicRead } from "../../src/seismic/read";
import type { Store } from "../../src/store";
import { routeTransport, type SentRequest, seededRuntime } from "../harness";
import { sampleAccess } from "./access";
import { NOW, SAMPLE_HEALTH } from "./data";
import { SAMPLE_PROFILE } from "./profile";
import { sampleGroupMembers, sampleSeismic } from "./seismic";

export const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const BASE = 33;
export const binding = bindingOf(SAMPLE_PROFILE);

type Answer = { status: number; body?: unknown };

export interface WorldOptions {
  extra?: Record<string, string[]>;
  seismic?: SeismicRead;
  phase?: "signin";
  store?: Store;
  // Answers a request before the store does, to stage a failure.
  failAt?: (req: SentRequest) => Answer | undefined;
}

// Entitlements as a store: each person's seismic groups, read back as effective groups.
function world(o: WorldOptions) {
  const held = new Map<string, Set<string>>();
  for (const [group, members] of Object.entries(sampleGroupMembers())) {
    for (const m of members) {
      const set = held.get(m.email) ?? new Set<string>();
      set.add(group);
      held.set(m.email, set);
    }
  }
  for (const [id, groups] of Object.entries(o.extra ?? {})) {
    const set = held.get(id) ?? new Set<string>();
    for (const g of groups) set.add(g);
    held.set(id, set);
  }
  const parse = (url: string, re: RegExp) => decodeURIComponent(url.match(re)?.[1] ?? "");
  const staged =
    (route: (req: SentRequest) => Answer) =>
    (req: SentRequest): Answer =>
      o.failAt?.(req) ?? route(req);
  const routes = routeTransport({
    "GET /api/entitlements/v2/members/": staged((req) => {
      const id = parse(req.url, /members\/([^/]+)\/groups/);
      const base = Array.from({ length: BASE }, (_, i) => ({ email: `base.${i}@x` }));
      const seis = [...(held.get(id) ?? [])].map((email) => ({ email }));
      return { status: 200, body: { groups: [...base, ...seis] } };
    }),
    "POST /api/entitlements/v2/groups/": staged((req) => {
      const group = parse(req.url, /groups\/([^/]+)\/members/);
      const id = (req.body as { email: string }).email;
      const set = held.get(id) ?? new Set<string>();
      if (set.has(group)) return { status: 409, body: { message: "exists" } };
      set.add(group);
      held.set(id, set);
      return { status: 200, body: {} };
    }),
    "DELETE /api/entitlements/v2/groups/": staged((req) => {
      const group = parse(req.url, /groups\/([^/]+)\/members/);
      const id = parse(req.url, /members\/([^/?]+)$/);
      if (!held.get(id)?.delete(group)) return { status: 404, body: { message: "not found" } };
      return { status: 204 };
    }),
  });
  return { ...routes, held };
}

export function seismicRuntime(o: WorldOptions = {}) {
  const w = world(o);
  const rt = seededRuntime(
    {
      [ACCESS_AREA]: sampleAccess(),
      [HEALTH_AREA]: SAMPLE_HEALTH,
      [SEISMIC_AREA]: o.seismic ?? sampleSeismic(),
    },
    {
      now: NOW,
      transport: w.transport,
      ...(o.phase ? { phase: o.phase } : {}),
      ...(o.store ? { store: o.store } : {}),
    },
  );
  return { rt, ...w };
}

export async function act(rt: Runtime, type: string, payload: Record<string, unknown> = {}) {
  const handler = planModule.actions?.[type] ?? seismicModule.actions?.[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  const res = await handler(rt, { ...binding, ...payload });
  await planState(rt).pending;
  await operationPending(rt);
  return res;
}

export async function plan(rt: Runtime, type: string, payload: Record<string, unknown>) {
  const res = await act(rt, type, payload);
  expect(res).toMatchObject({ ok: true });
  const p = planState(rt).plan;
  if (!p) throw new Error(`no plan: ${planState(rt).error}`);
  return p;
}

export const writes = (sent: SentRequest[]) => sent.filter((r) => r.method !== "GET");
