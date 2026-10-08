// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibExec } from "@keelson/shared";
import {
  ARM_RESOURCE,
  fetchToken,
  GRAPH_RESOURCE,
  LOGS_RESOURCE,
  type TokenFailure,
  type TokenResult,
} from "./az.ts";
import type { Profile } from "./profile.ts";

export const SERVICE_PATHS = {
  entitlements: "/api/entitlements/v2",
  legal: "/api/legal/v1",
  storage: "/api/storage/v2",
  search: "/api/search/v2",
  schema: "/api/schema-service/v1",
  seismic: "/seistore-svc/api/v3",
  partition: "/api/partition/v1",
  workflow: "/api/workflow/v1",
  file: "/api/file/v2",
  indexer: "/api/indexer/v2",
  dataset: "/api/dataset/v1",
  register: "/api/register/v1",
  notification: "/api/notification/v1",
  unit: "/api/unit/v3",
  "crs-catalog": "/api/crs/catalog/v2",
  "crs-conversion": "/api/crs/converter/v2",
  policy: "/api/policy/v1",
  wellbore: "/api/os-wellbore-ddms",
  reservoir: "/api/reservoir-ddms/v2",
} as const;

export type Service = keyof typeof SERVICE_PATHS;

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

const HTTP_TIMEOUT_MS = 30_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// A body past the cap answers 413 so the call fails as a client error and is not retried.
export function tooLarge(): HttpResponse {
  return {
    status: 413,
    body: JSON.stringify({
      message: `response larger than ${MAX_BODY_BYTES / 1024 / 1024} MiB, not read`,
    }),
  };
}

export async function readCapped(res: Response, cap = MAX_BODY_BYTES): Promise<HttpResponse> {
  if (Number(res.headers.get("content-length") ?? 0) > cap) {
    await res.body?.cancel();
    return tooLarge();
  }
  if (!res.body) return { status: res.status, body: "" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }
  return { status: res.status, body: Buffer.concat(chunks).toString("utf8") };
}

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return readCapped(res);
};

export type FailureKind =
  | TokenFailure["kind"]
  | "forbidden"
  | "not-found"
  | "conflict"
  | "server"
  | "network"
  | "client";

export interface CallFailure {
  kind: FailureKind;
  status: number | null;
  message: string;
  body?: unknown;
}

export type CallResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; failure: CallFailure };

export interface CallOptions {
  method?: string;
  body?: unknown;
  correlationId?: string;
  headers?: Record<string, string>;
}

export interface GraphBatchRequest {
  id: string;
  method: "GET";
  url: string;
}

export interface GraphBatchResponse {
  status: number;
  body: unknown;
}

const RETRY_DELAYS_MS = [500, 1500];
const GRAPH_BATCH_LIMIT = 20;

export function classifyStatus(status: number): FailureKind | undefined {
  if (status < 400) return undefined;
  if (status === 401) return "signin";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  return "client";
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function failureMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; error?: { message?: unknown } | unknown };
    if (typeof b.message === "string") return b.message.slice(0, 300);
    const inner = (b.error as { message?: unknown } | undefined)?.message;
    if (typeof inner === "string") return inner.slice(0, 300);
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return `HTTP ${status}`;
}

// One batch of calls shares one token per resource; the next batch asks az again,
// so token lifetime never outlasts the work that needed it.
export class Batch {
  private readonly tokens = new Map<string, Promise<TokenResult>>();
  calls = 0;

  constructor(
    private readonly exec: RibExec,
    readonly profile: Profile,
    private readonly transport: Transport,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  private token(resource: string): Promise<TokenResult> {
    let pending = this.tokens.get(resource);
    if (!pending) {
      pending = fetchToken(this.exec, this.profile, resource);
      this.tokens.set(resource, pending);
    }
    return pending;
  }

  adme<T = unknown>(
    service: Service,
    path: string,
    opts: CallOptions = {},
  ): Promise<CallResult<T>> {
    const url = `https://${this.profile.host}${SERVICE_PATHS[service]}${path}`;
    const headers: Record<string, string> = { "data-partition-id": this.profile.partition };
    if (opts.correlationId) headers["correlation-id"] = opts.correlationId;
    return this.send<T>(this.profile.admeAppId, url, opts, headers);
  }

  graph<T = unknown>(path: string, opts: CallOptions = {}): Promise<CallResult<T>> {
    return this.send<T>(GRAPH_RESOURCE, `https://graph.microsoft.com${path}`, opts, {});
  }

  arm<T = unknown>(path: string, opts: CallOptions = {}): Promise<CallResult<T>> {
    return this.send<T>(ARM_RESOURCE, `${ARM_RESOURCE}${path}`, opts, {});
  }

  logs<T = unknown>(workspaceId: string, query: string, timespan: string): Promise<CallResult<T>> {
    const url = `https://api.loganalytics.io/v1/workspaces/${encodeURIComponent(workspaceId)}/query`;
    return this.send<T>(LOGS_RESOURCE, url, { method: "POST", body: { query, timespan } }, {});
  }

  async graphBatch(
    requests: readonly GraphBatchRequest[],
  ): Promise<CallResult<Map<string, GraphBatchResponse>>> {
    const out = new Map<string, GraphBatchResponse>();
    for (let i = 0; i < requests.length; i += GRAPH_BATCH_LIMIT) {
      const chunk = requests.slice(i, i + GRAPH_BATCH_LIMIT);
      const res = await this.graph<{
        responses?: { id: string; status: number; body?: unknown }[];
      }>("/v1.0/$batch", { method: "POST", body: { requests: chunk } });
      if (!res.ok) return res;
      for (const r of res.data.responses ?? []) out.set(r.id, { status: r.status, body: r.body });
    }
    return { ok: true, status: 200, data: out };
  }

  private async send<T>(
    resource: string,
    url: string,
    opts: CallOptions,
    extra: Record<string, string>,
  ): Promise<CallResult<T>> {
    const token = await this.token(resource);
    if (!token.ok) return { ok: false, failure: { ...token.failure, status: null } };
    const req: HttpRequest = {
      method: opts.method ?? "GET",
      url,
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extra,
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      let res: HttpResponse;
      try {
        res = await this.transport(req);
      } catch (err) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await this.sleep(RETRY_DELAYS_MS[attempt] as number);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, failure: { kind: "network", status: null, message } };
      }
      const body = parseBody(res.body);
      const kind = classifyStatus(res.status);
      if (!kind) return { ok: true, status: res.status, data: body as T };
      if (kind === "server" && attempt < RETRY_DELAYS_MS.length) {
        await this.sleep(RETRY_DELAYS_MS[attempt] as number);
        continue;
      }
      return {
        ok: false,
        failure: { kind, status: res.status, message: failureMessage(res.status, body), body },
      };
    }
  }
}

export interface AdmeClient {
  readonly profile: Profile;
  batch<T>(work: (batch: Batch) => Promise<T>): Promise<T>;
}

export function createClient(
  exec: RibExec,
  profile: Profile,
  opts: { transport?: Transport; sleep?: (ms: number) => Promise<void> } = {},
): AdmeClient {
  const transport = opts.transport ?? fetchTransport;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    profile,
    batch: (work) => work(new Batch(exec, profile, transport, sleep)),
  };
}
