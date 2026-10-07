// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibExec } from "@keelson/shared";
import type { Profile } from "./profile.ts";

export const GRAPH_RESOURCE = "https://graph.microsoft.com";
export const LOGS_RESOURCE = "https://api.loganalytics.io";

export type TokenFailure =
  | { kind: "signin"; message: string }
  | { kind: "profile"; message: string }
  | { kind: "az-missing"; message: string }
  | { kind: "timeout"; message: string };

export type TokenResult = { ok: true; token: string } | { ok: false; failure: TokenFailure };

const TOKEN_TIMEOUT_MS = 30_000;

// The host's exec reports only the first stderr line. AADSTS500011 (resource not
// in tenant), an unknown tenant, and az's traceback banner (which an unknown
// authority produces) point at the profile, not at the operator's sign-in.
export function classifyTokenError(stderr: string): TokenFailure {
  const text = stderr.trim();
  const message = firstErrorLine(text);
  if (/AADSTS500011|AADSTS90002|AADSTS900023|authority|unexpected error/i.test(text)) {
    return { kind: "profile", message };
  }
  if (/^az not found$|ENOENT|command not found/i.test(text)) {
    return { kind: "az-missing", message: "Azure CLI (az) is not on the server's PATH" };
  }
  if (/timed out/i.test(text)) return { kind: "timeout", message };
  return { kind: "signin", message };
}

function firstErrorLine(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("ERROR:")) ?? text.split("\n")[0] ?? "";
  return line.replace(/^ERROR:\s*/, "").slice(0, 300) || "az returned no token";
}

export async function fetchToken(
  exec: RibExec,
  profile: Profile,
  resource: string,
): Promise<TokenResult> {
  const res = await exec.runJSON<{ accessToken?: string }>(
    "az",
    [
      "account",
      "get-access-token",
      "--resource",
      resource,
      "--tenant",
      profile.tenantId,
      "--output",
      "json",
    ],
    { timeoutMs: TOKEN_TIMEOUT_MS },
  );
  if (!res.ok) return { ok: false, failure: classifyTokenError(res.error) };
  const token = res.data?.accessToken;
  if (!token) return { ok: false, failure: { kind: "signin", message: "az returned no token" } };
  return { ok: true, token };
}
