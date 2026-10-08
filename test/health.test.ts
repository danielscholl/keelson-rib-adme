import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { platformSections } from "../src/boards/health";
import type { CallResult, FailureKind } from "../src/client";
import {
  HEALTH_AREA,
  type Health,
  probe,
  readHealth,
  SERVICE_CATALOG,
  verdict,
} from "../src/data/health";
import { CONNECTION_KEY, HEADER_KEY } from "../src/keys";
import { connectionModule } from "../src/modules/connection";
import { headerModule } from "../src/modules/header";
import { NOW, SAMPLE_HEALTH } from "./fixtures/data";
import { routeTransport, seededRuntime } from "./harness";

const headerBoard = expectView(HEADER_KEY, "board");
const connectionBoard = expectView(CONNECTION_KEY, "board");

function line(rt: ReturnType<typeof seededRuntime>) {
  const view = headerBoard(headerModule.composers?.[HEADER_KEY]?.(rt)) as CanvasBoardView;
  const rows = view.sections[1];
  if (rows?.kind !== "rows") throw new Error("connection line expected second");
  return rows.items[0];
}

const fail = (status: number | null, kind: FailureKind = "server"): CallResult<unknown> => ({
  ok: false,
  failure: { kind, status, message: "m" },
});

describe("probe", () => {
  test("any answer but 404 is up, 404 is not enabled, 5xx and no answer are down", () => {
    expect(probe("legal", { ok: true, status: 200, data: { version: "0.28.0" } })).toEqual({
      service: "legal",
      state: "up",
      version: "0.28.0",
    });
    expect(probe("partition", fail(403, "forbidden")).state).toBe("up");
    expect(probe("storage", fail(401, "signin")).state).toBe("up");
    expect(probe("policy", fail(404, "not-found")).state).toBe("off");
    expect(probe("search", fail(503)).state).toBe("down");
    expect(probe("search", fail(null, "network")).state).toBe("down");
  });
});

describe("verdict", () => {
  const withServices = (patch: Partial<Health>): Health => ({ ...SAMPLE_HEALTH, ...patch });

  test("the sample cast is healthy on 0.28", () => {
    expect(verdict(SAMPLE_HEALTH)).toEqual({ tone: "ok", word: "healthy", release: "0.28" });
  });

  test("unmeasured reads health ?", () => {
    expect(verdict(undefined)).toEqual({ tone: "neutral", word: "health ?" });
  });

  test("one service down names it; several are counted", () => {
    const down = (s: string) => ({ service: s, state: "down" as const, status: 503 });
    const one = SAMPLE_HEALTH.services.map((s) => (s.service === "search" ? down("search") : s));
    expect(verdict(withServices({ services: one })).word).toBe("search not answering");
    const two = one.map((s) => (s.service === "crs-catalog" ? down("crs-catalog") : s));
    expect(verdict(withServices({ services: two }))).toMatchObject({
      tone: "caution",
      word: "2 services not answering",
    });
  });

  test("Azure's verdict wins when it says unavailable or degraded", () => {
    expect(verdict(withServices({ azure: { state: "Unavailable" } }))).toMatchObject({
      tone: "error",
      word: "Azure: unavailable",
    });
    expect(verdict(withServices({ azure: { state: "Degraded" } })).word).toBe("Azure: degraded");
  });

  test("services on different releases read mixed versions", () => {
    const services = [
      { service: "legal", state: "up" as const, version: "0.28.0" },
      { service: "search", state: "up" as const, version: "0.27.3" },
    ];
    expect(verdict(withServices({ services })).release).toBe("mixed versions");
  });
});

describe("connection line", () => {
  test("ends in the health chip instead of details", () => {
    const item = line(seededRuntime({ [HEALTH_AREA]: SAMPLE_HEALTH }, { now: NOW }));
    expect(item).toMatchObject({ chip: { label: "healthy · 0.28", tone: "ok" } });
    expect(item).not.toHaveProperty("trailing");
  });

  test("before the first check it reads health ?", () => {
    expect(line(seededRuntime({}, { now: NOW }))).toMatchObject({
      chip: { label: "health ?", tone: "neutral" },
    });
  });

  test("sign-in needed keeps details and drops the chip", () => {
    const item = line(seededRuntime({ [HEALTH_AREA]: SAMPLE_HEALTH }, { phase: "signin" }));
    expect(item).toMatchObject({ trailing: "details" });
    expect(item).not.toHaveProperty("chip");
  });
});

describe("Connection inspector", () => {
  test("the Platform block lists every service with its version or result", () => {
    const rt = seededRuntime({ [HEALTH_AREA]: SAMPLE_HEALTH }, { now: NOW });
    const view = connectionBoard(
      connectionModule.composers?.[CONNECTION_KEY]?.(rt),
    ) as CanvasBoardView;
    const text = JSON.stringify(view);
    expect(text).toContain("All 17 enabled services answer");
    expect(text).toContain("Available since 2026-09-12 08:00Z");
    expect(text).toContain("0.28 on 15 of 17");
    const table = view.sections.find((s) => s.kind === "table" && s.title?.startsWith("Services"));
    if (table?.kind !== "table") throw new Error("services table expected");
    expect(table.title).toBe("Services · 17 enabled · 2 not enabled");
    expect(table.rows).toHaveLength(SERVICE_CATALOG.length);
    const byName = Object.fromEntries(table.rows.map((r) => [r.service, r.result]));
    expect(byName.partition).toEqual({ value: "up, 403 without a version", tone: "ok" });
    expect(byName.policy).toEqual({ value: "not enabled", tone: "neutral" });
    expect(byName["CRS catalog"]).toEqual({ value: "0.28.0", tone: "ok" });
  });

  test("unmeasured says when it will check", () => {
    const sections = platformSections({});
    expect(JSON.stringify(sections)).toContain("Not checked yet");
  });
});

describe("readHealth", () => {
  test("probes the catalog and reads Azure Resource Health for the instance", async () => {
    const id =
      "/subscriptions/s/resourceGroups/g/providers/Microsoft.OpenEnergyPlatform/energyServices/contoso-adme";
    const { transport, sent } = routeTransport({
      "GET /info": () => ({ status: 200, body: { version: "0.28.1" } }),
      "GET /api/partition/v1/info": () => ({ status: 403, body: { message: "Forbidden" } }),
      "GET /api/policy/v1/info": () => ({ status: 404 }),
      "GET /seistore-svc/api/v3/svcstatus": () => ({ status: 200, body: "service running" }),
      "GET /api/os-wellbore-ddms/ddms/v2/about": () => ({
        status: 200,
        body: { version: "0.28.0" },
      }),
      "POST Microsoft.ResourceGraph/resources": () => ({ status: 200, body: { data: [{ id }] } }),
      "GET availabilityStatuses/current": () => ({
        status: 200,
        body: {
          properties: { availabilityState: "Available", occuredTime: "2026-09-12T08:00:00Z" },
        },
      }),
    });
    const rt = seededRuntime({}, { now: NOW, transport });
    const res = await rt.run(readHealth);
    if (!res.ok) throw new Error(res.failure.message);
    const states = Object.fromEntries(res.data.services.map((s) => [s.service, s.state]));
    expect(states.partition).toBe("up");
    expect(states.policy).toBe("off");
    expect(states.seismic).toBe("up");
    expect(res.data.azure).toEqual({ state: "Available", since: "2026-09-12T08:00:00Z" });
    const graph = sent.find((r) => r.url.includes("ResourceGraph"));
    expect(JSON.stringify(graph?.body)).toContain("contoso-adme");
  });

  test("an Azure read it cannot make leaves the probes standing", async () => {
    const { transport } = routeTransport({
      "GET /info": () => ({ status: 200, body: { version: "0.28.1" } }),
      "POST Microsoft.ResourceGraph/resources": () => ({
        status: 403,
        body: { error: { message: "no Reader role" } },
      }),
    });
    const rt = seededRuntime({}, { now: NOW, transport });
    const res = await rt.run(readHealth);
    if (!res.ok) throw new Error(res.failure.message);
    expect(res.data.azure).toEqual({ state: "unread", reason: "no Reader role" });
    expect(verdict(res.data).tone).toBe("ok");
  });
});
