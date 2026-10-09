import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rib from "../src/index";
import {
  DATA_PULSE_KEY,
  EXPLAIN_KEY,
  HEADER_KEY,
  PERSON_KEY,
  PULSE_KEY,
  SEIS_PULSE_KEY,
} from "../src/keys";
import { SAMPLE_ENV, sampleMode } from "../src/sample/index";
import { kindMatches, parseQuery, READ_ONLY, sampleTransport } from "../src/sample/transport";
import { DOMAIN, person, ROLE_GROUPS } from "../src/sample/world";
import { SECTION_ACTION } from "../src/section";
import { fakeContext } from "./harness";

const HOST = "https://contoso-adme.energy.azure.com";

async function call(method: string, url: string, body?: unknown) {
  const res = await sampleTransport({
    method,
    url,
    headers: {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined };
}

async function effectiveCount(member: string): Promise<number> {
  const res = await call(
    "GET",
    `${HOST}/api/entitlements/v2/members/${encodeURIComponent(member)}/groups?type=NONE`,
  );
  return res.body.groups.length;
}

describe("sample instance transport", () => {
  test("role groups reach the spec's effective counts, users@ included", async () => {
    const withUsers = async (g: string) => 1 + 1 + (await effectiveCount(g));
    expect(await withUsers(ROLE_GROUPS.editors)).toBe(33);
    expect(await withUsers(ROLE_GROUPS.admins)).toBe(49);
    expect(await withUsers(ROLE_GROUPS.ops)).toBe(46);
    expect(await effectiveCount(person("Rachel Kim").id)).toBe(32);
  });

  test("refuses every write", async () => {
    const res = await call("POST", `${HOST}/api/entitlements/v2/groups/users@${DOMAIN}/members`, {
      email: "x",
      role: "MEMBER",
    });
    expect(res).toEqual({ status: 403, body: { message: READ_ONLY } });
    const invite = await call("POST", "https://graph.microsoft.com/v1.0/invitations", {});
    expect(invite.status).toBe(403);
  });

  test("search counts and aggregates by kind, tag and ACL", async () => {
    const all = await call("POST", `${HOST}/api/search/v2/query`, {
      kind: "*:*:*:*",
      query: "*",
      limit: 1,
      aggregateBy: "kind",
    });
    expect(all.body.totalCount).toBe(1_284_512);
    expect(all.body.aggregations).toHaveLength(214);
    const wells = await call("POST", `${HOST}/api/search/v2/query`, {
      kind: "osdu:wks:master-data--Well:*",
      limit: 2,
    });
    expect(wells.body.totalCount).toBe(88_104);
    const id = wells.body.results[1].id;
    const record = await call("GET", `${HOST}/api/storage/v2/records/${encodeURIComponent(id)}`);
    expect(record.body.id).toBe(id);
  });

  test("the query subset reads fields, OR, AND and parentheses", () => {
    const c = {
      kind: "osdu:wks:master-data--Well:1.2.0",
      tag: "opendes-pilot-trial",
      viewers: [`data.pilot.viewers@${DOMAIN}`],
      owners: [`data.pilot.owners@${DOMAIN}`],
      count: 1,
    };
    expect(parseQuery('legal.legaltags:"opendes-pilot-trial"')(c)).toBe(true);
    expect(parseQuery(`acl.viewers:("a" OR "data.pilot.viewers@${DOMAIN}")`)(c)).toBe(true);
    expect(parseQuery('legal.legaltags:"x" OR acl.owners:"data.pilot.*"')(c)).toBe(true);
    expect(parseQuery('(kind:"*Well*") AND legal.legaltags:"x"')(c)).toBe(false);
    expect(parseQuery('data.FacilityName:"15/9*"')(c)).toBe(false);
    expect(kindMatches("osdu:wks:master-data--Well:*", c.kind)).toBe(true);
    expect(kindMatches("osdu:wks:*", c.kind)).toBe(false);
  });
});

describe("sample mode", () => {
  beforeEach(() => {
    process.env[SAMPLE_ENV] = "1";
  });
  afterEach(async () => {
    delete process.env[SAMPLE_ENV];
    await rib.dispose?.();
  });

  async function until(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  }

  test("reads the switch from the environment", () => {
    expect(sampleMode({ [SAMPLE_ENV]: "1" })).toBe(true);
    expect(sampleMode({ [SAMPLE_ENV]: "true" })).toBe(true);
    expect(sampleMode({ [SAMPLE_ENV]: "0" })).toBe(false);
    expect(sampleMode({})).toBe(false);
  });

  test("serves the spec's cast through the real composers, and says it is a sample", async () => {
    const { ctx, snapshots } = fakeContext();
    rib.registerTools?.(ctx);
    const text = (k: string) => JSON.stringify(snapshots.frames.get(k) ?? null);
    await until(() => text(PULSE_KEY).includes("organizations"));
    expect(text(HEADER_KEY)).toContain(
      "Sample instance contoso-adme · opendes as ingrid.halvorsen@contoso.example · Ops",
    );
    expect(text(PULSE_KEY)).toContain(
      "32 people from 12 organizations. 3 used it this week; 3 not accepted yet and 25 accepted with no data call since 2026-09-20. 2 people cannot use it.",
    );

    await rib.onAction?.({ type: SECTION_ACTION, payload: { section: "data" } }, ctx);
    await until(() => text(DATA_PULSE_KEY).includes("legal tags"));
    expect(text(HEADER_KEY)).toContain("1,284,512 records under 4 legal tags");

    await rib.onAction?.({ type: SECTION_ACTION, payload: { section: "seismic" } }, ctx);
    await rib.onAction?.({ type: "seis-read", payload: {} }, ctx);
    await until(() => text(SEIS_PULSE_KEY).includes("hold a grant"));
    expect(text(SEIS_PULSE_KEY)).toContain(
      "13 subprojects; 9 of 32 people hold a grant; 2 rely on the default ACL and 1 has no members.",
    );

    const rachel = person("Rachel Kim");
    await rib.onAction?.({ type: "select-person", payload: { id: rachel.id } }, ctx);
    await until(() => text(PERSON_KEY).includes("401 on every call"));
    await rib.onAction?.(
      {
        type: "explain-access",
        payload: {
          id: rachel.id,
          host: "contoso-adme.energy.azure.com",
          partition: "opendes",
          tenantId: "1f2e8c47-5b93-4d1a-a6f0-7e2b4c819a00",
        },
      },
      ctx,
    );
    await until(() => text(EXPLAIN_KEY).includes("Rachel Kim"));
    expect(text(EXPLAIN_KEY)).toContain("401: not a member of users@");
  });

  test("keeps its own store beside the real one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adme-sample-"));
    writeFileSync(join(dir, "profile.json"), '{"host":"real.example"}');
    const { ctx } = fakeContext({ getDataDir: () => dir });
    rib.registerTools?.(ctx);
    expect(readFileSync(join(dir, "profile.json"), "utf8")).toBe('{"host":"real.example"}');
    expect(readFileSync(join(dir, "sample", "profile.json"), "utf8")).toContain("contoso-adme");
  });
});
