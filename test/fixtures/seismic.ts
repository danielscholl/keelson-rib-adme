import type { SeismicRead } from "../../src/seismic/read";
import { SAMPLE_APPS, sampleAccess } from "./access";
import { SAMPLE_PROFILE } from "./profile";

// The seismic cast from design/spec.md: 13 subprojects in tenant opendes, 11 on
// their own ACL, volve and drogon reached through data.default, subproject-legacy
// empty. Group ids are placeholders.
const D = "@opendes.dataservices.energy";
const ROOT_GROUP = `users.data.root${D}`;

type Who = string;

interface CastRow {
  name: string;
  ltag: string;
  policy: string;
  admins: Who[] | "default";
  viewers: Who[] | "default";
}

const TIER_VIEWER = "contoso-adme-tier-viewer";
const TIER_EDITOR = "contoso-adme-tier-editor";
const TIER_ADMIN = "contoso-adme-tier-admin";

export const SEISMIC_CAST: CastRow[] = [
  {
    name: "alpha",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Priya Nair", "Ingrid Halvorsen", "Tomas Reyes"],
    viewers: ["Marcus Oyelaran", TIER_VIEWER, TIER_EDITOR, TIER_ADMIN],
  },
  {
    name: "bravo",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Priya Nair", "Ingrid Halvorsen"],
    viewers: [TIER_VIEWER],
  },
  {
    name: "charlie",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Ingrid Halvorsen"],
    viewers: ["Elena Petrova", TIER_VIEWER],
  },
  {
    name: "delta",
    ltag: "opendes-public-norway",
    policy: "uniform",
    admins: ["Ingrid Halvorsen"],
    viewers: ["Marcus Oyelaran", TIER_VIEWER, "Pilot Member 01"],
  },
  {
    name: "sleipner",
    ltag: "opendes-public-norway",
    policy: "uniform",
    admins: ["Tomas Reyes"],
    viewers: ["Hiro Tanaka", TIER_VIEWER],
  },
  {
    name: "echo",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Sofia Marchetti", "Ingrid Halvorsen"],
    viewers: [TIER_VIEWER],
  },
  {
    name: "foxtrot",
    ltag: "opendes-pilot-trial",
    policy: "dataset",
    admins: ["Tomas Reyes"],
    viewers: ["Sofia Marchetti", TIER_VIEWER],
  },
  {
    name: "golf",
    ltag: "opendes-pilot-trial",
    policy: "dataset",
    admins: ["Ingrid Halvorsen"],
    viewers: ["Dmitri Volkov", TIER_VIEWER],
  },
  {
    name: "golf2",
    ltag: "opendes-pilot-trial",
    policy: "dataset",
    admins: ["Ingrid Halvorsen"],
    viewers: [],
  },
  {
    name: "golf3",
    ltag: "opendes-pilot-trial",
    policy: "dataset",
    admins: ["Ingrid Halvorsen"],
    viewers: [],
  },
  {
    name: "volve",
    ltag: "opendes-public-norway",
    policy: "uniform",
    admins: "default",
    viewers: "default",
  },
  // The service's own shape: an own admin group, viewers through data.default.
  {
    name: "drogon",
    ltag: "opendes-public-norway",
    policy: "uniform",
    admins: [],
    viewers: "default",
  },
  {
    name: "subproject-legacy",
    ltag: "opendes-legacy-training",
    policy: "uniform",
    admins: [],
    viewers: [],
  },
];

export function groupEmail(name: string, role: "admin" | "viewer"): string {
  const i = SEISMIC_CAST.findIndex((r) => r.name === name);
  const n = String(i + 1).padStart(2, "0");
  const uuid = `${role === "admin" ? "a" : "b"}0${n}0000-0000-4000-8000-0000000000${n}`;
  return `data.sdms.opendes.${name}.${uuid}.${role}${D}`;
}

function idOf(who: Who): string {
  const app = SAMPLE_APPS.find((a) => a.name === who);
  if (app) return app.id;
  const hit = Object.entries(sampleAccess().directory).find(([, e]) => e.name === who);
  if (!hit) throw new Error(`no ${who} in the access cast`);
  return hit[0];
}

const defaultGroup = (role: "admin" | "viewer") =>
  role === "admin" ? `data.default.owners${D}` : `data.default.viewers${D}`;

function acl(row: CastRow, role: "admin" | "viewer"): string {
  const who = role === "admin" ? row.admins : row.viewers;
  return who === "default" ? defaultGroup(role) : groupEmail(row.name, role);
}

// GET /seistore-svc/api/v3/subproject/tenant/opendes, as the service returns it.
export function sampleSubprojectList(): unknown[] {
  return SEISMIC_CAST.map((row) => ({
    name: row.name,
    tenant: "opendes",
    ltag: row.ltag,
    acls: { admins: [acl(row, "admin")], viewers: [acl(row, "viewer")] },
    access_policy: row.policy,
    enforce_key: true,
    gcs_bucket: "ss-sample-bucket",
  }));
}

// GET /groups/{email}/members bodies for every own-ACL group. Each lists the
// instance's root app and users.data.root, as the service does.
export function sampleGroupMembers(): Record<string, { email: string; role: string }[]> {
  const out: Record<string, { email: string; role: string }[]> = {};
  for (const row of SEISMIC_CAST) {
    for (const role of ["admin", "viewer"] as const) {
      const who = role === "admin" ? row.admins : row.viewers;
      if (who === "default") continue;
      out[groupEmail(row.name, role)] = [
        { email: SAMPLE_PROFILE.admeAppId, role: "OWNER" },
        { email: ROOT_GROUP, role: "MEMBER" },
        ...who.map((w) => ({ email: idOf(w), role: "MEMBER" })),
      ];
    }
  }
  return out;
}

export function sampleSeismic(): SeismicRead {
  const members = sampleGroupMembers();
  return {
    tenant: "opendes",
    source: "list",
    subprojects: SEISMIC_CAST.map((row) => ({
      name: row.name,
      legalTag: row.ltag,
      accessPolicy: row.policy,
      admins: [acl(row, "admin")],
      viewers: [acl(row, "viewer")],
    })),
    groups: Object.fromEntries(
      Object.entries(members).map(([email, list]) => [
        email,
        { members: list.map((m) => m.email.toLowerCase()) },
      ]),
    ),
  };
}
