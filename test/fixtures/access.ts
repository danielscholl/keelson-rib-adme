import type { AccessRead, DirectoryEntry, GroupMember } from "../../src/access/read";
import { SAMPLE_PROFILE } from "./profile";

// The identities cast from design/spec.md: 32 people and 4 applications.
// Object ids are placeholders.
const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Cast {
  name: string;
  mail: string;
  role: "ops" | "admins" | "editors";
  member?: boolean;
  pendingSince?: string;
  accepted?: string;
  notInUsers?: boolean;
  duplicate?: boolean;
}

const NAMED: Cast[] = [
  { name: "Ingrid Halvorsen", mail: "ingrid.halvorsen@contoso.example", role: "ops", member: true },
  { name: "Tomas Reyes", mail: "tomas.reyes@contoso.example", role: "ops", member: true },
  {
    name: "Priya Nair",
    mail: "priya.nair@halden-geo.example",
    role: "admins",
    accepted: "2026-09-28",
  },
  {
    name: "Marcus Oyelaran",
    mail: "m.oyelaran@northfield.example",
    role: "editors",
    accepted: "2026-09-29",
  },
  {
    name: "Lena Fischer",
    mail: "lena.fischer@rheinseis.example",
    role: "editors",
    accepted: "2026-09-28",
  },
  {
    name: "Hiro Tanaka",
    mail: "h.tanaka@kaiyo-data.example",
    role: "editors",
    accepted: "2026-09-29",
  },
  {
    name: "Sofia Marchetti",
    mail: "sofia.marchetti@adriatica.example",
    role: "editors",
    accepted: "2026-09-30",
  },
  {
    name: "Ben Whitaker",
    mail: "ben.whitaker@northfield.example",
    role: "editors",
    pendingSince: "2026-09-28",
  },
  {
    name: "Amara Diallo",
    mail: "amara.diallo@sahelgeo.example",
    role: "editors",
    pendingSince: "2026-09-28",
  },
  {
    name: "Jonas Lindqvist",
    mail: "jonas.lindqvist@fjordline.example",
    role: "editors",
    pendingSince: "2026-09-30",
  },
  {
    name: "Rachel Kim",
    mail: "rachel.kim@pacrim-energy.example",
    role: "editors",
    accepted: "2026-09-29",
    notInUsers: true,
  },
  {
    name: "Dmitri Volkov",
    mail: "d.volkov@baltica.example",
    role: "editors",
    accepted: "2026-09-29",
    duplicate: true,
  },
  {
    name: "Elena Petrova",
    mail: "elena.petrova@vendor-partners.example",
    role: "editors",
    accepted: "2026-09-30",
  },
];

const MORE: Cast[] = Array.from({ length: 19 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    name: `Pilot Member ${n}`,
    mail: `pilot.member.${n}@sample.example`,
    role: "editors" as const,
    accepted: "2026-09-28",
  };
});

export const SAMPLE_APPS = [
  { id: SAMPLE_PROFILE.admeAppId, name: "contoso-adme-root-app", group: "ops" as const },
  {
    id: "2d4c0000-0000-4000-8000-000000009e13",
    name: "contoso-adme-tier-viewer",
    group: "viewers" as const,
  },
  {
    id: "a07f0000-0000-4000-8000-000000003b68",
    name: "contoso-adme-tier-editor",
    group: "editors" as const,
  },
  {
    id: "c5b20000-0000-4000-8000-0000000070da",
    name: "contoso-adme-tier-admin",
    group: "admins" as const,
  },
];

export function sampleAccess(): AccessRead {
  const groups: AccessRead["groups"] = { users: [], viewers: [], editors: [], admins: [], ops: [] };
  const directory: Record<string, DirectoryEntry> = {};
  const member = (id: string, owner = false): GroupMember => ({ id, owner });
  [...NAMED, ...MORE].forEach((p, i) => {
    const id = oid(i + 1);
    const changed = p.pendingSince ?? p.accepted;
    directory[id] = {
      kind: "user",
      name: p.name,
      mail: p.mail,
      guest: !p.member,
      ...(p.member ? {} : { inviteState: p.pendingSince ? "PendingAcceptance" : "Accepted" }),
      ...(changed ? { inviteChangedAt: `${changed}T09:00:00Z` } : {}),
    };
    if (!p.notInUsers) groups.users.push(member(id, p.role === "ops"));
    groups[p.role].push(member(id, p.role === "ops"));
    if (p.duplicate) groups[p.role].push(member(p.mail));
  });
  for (const app of SAMPLE_APPS) {
    directory[app.id] = { kind: "app", name: app.name };
    groups.users.push(member(app.id));
    groups[app.group].push(member(app.id));
  }
  return { groups, directory };
}

export const SIGNED_IN_AS = "ingrid.halvorsen@contoso.example";

// Cohorts from the cast: Pilot 29, Vendor 1, Permanent 2 (no pass).
export function sampleCohortCsv(): string {
  const lines = ["email,cohort,pass_end"];
  for (const p of [...NAMED, ...MORE]) {
    if (p.member) lines.push(`${p.mail},Permanent`);
    else if (p.mail.endsWith("@vendor-partners.example")) lines.push(`${p.mail},Vendor,2026-10-29`);
    else lines.push(`${p.mail},Pilot,2026-10-28`);
  }
  return lines.join("\n");
}
