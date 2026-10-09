// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Profile } from "../profile.ts";

// The sample instance from design/spec.md. Every person, organization and id is made up.

export const SAMPLE_NOW = "2026-10-02T14:05:00Z";
export const DOMAIN = "opendes.dataservices.energy";
const D = `@${DOMAIN}`;

export const SAMPLE_PROFILE: Profile = {
  host: "contoso-adme.energy.azure.com",
  partition: "opendes",
  tenantId: "1f2e8c47-5b93-4d1a-a6f0-7e2b4c819a00",
  admeAppId: "4c7d91e3-6a2f-4b58-8e07-c3d95a6f2b18",
  rosterGroupId: "9d3a6f12-8c4e-4b7a-9f31-0e6d2a7b5e42",
  logWorkspaceId: "6b8e2d41-3c7a-4f95-b0e2-91d4c5a7e3f6",
};

export const ROSTER_GROUP_NAME = "contoso-adme";

// A stable, made-up GUID per seed, so ids never change between runs.
export function guid(seed: string): string {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 32; round++) {
    for (const ch of `${seed}#${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  const s = out.slice(0, 32);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

export type Role = "ops" | "admins" | "editors";

export interface Person {
  id: string;
  name: string;
  mail: string;
  role: Role;
  cohort: "Pilot" | "Vendor" | "Permanent";
  member?: boolean;
  invited: string;
  accepted?: string;
  notInUsers?: boolean;
  duplicate?: boolean;
  otherMails?: string[];
}

interface Cast {
  name: string;
  mail: string;
  role?: Role;
  cohort?: Person["cohort"];
  member?: boolean;
  invited?: string;
  accepted?: string | null;
  notInUsers?: boolean;
  duplicate?: boolean;
  otherMails?: string[];
  id?: string;
}

const NAMED: Cast[] = [
  {
    name: "Ingrid Halvorsen",
    mail: "ingrid.halvorsen@contoso.example",
    role: "ops",
    cohort: "Permanent",
    member: true,
  },
  {
    name: "Tomas Reyes",
    mail: "tomas.reyes@contoso.example",
    role: "ops",
    cohort: "Permanent",
    member: true,
  },
  { name: "Priya Nair", mail: "priya.nair@halden-geo.example", role: "admins" },
  { name: "Marcus Oyelaran", mail: "m.oyelaran@northfield.example", accepted: "2026-09-29" },
  { name: "Lena Fischer", mail: "lena.fischer@rheinseis.example" },
  { name: "Hiro Tanaka", mail: "h.tanaka@kaiyo-data.example", accepted: "2026-09-29" },
  { name: "Sofia Marchetti", mail: "sofia.marchetti@adriatica.example", accepted: "2026-09-30" },
  { name: "Ben Whitaker", mail: "ben.whitaker@northfield.example", accepted: null },
  { name: "Amara Diallo", mail: "amara.diallo@sahelgeo.example", accepted: null },
  {
    name: "Jonas Lindqvist",
    mail: "jonas.lindqvist@fjordline.example",
    invited: "2026-09-30",
    accepted: null,
  },
  {
    name: "Rachel Kim",
    mail: "rachel.kim@pacrim-energy.example",
    accepted: "2026-09-29",
    notInUsers: true,
    otherMails: ["rkim@pacrim-energy.example"],
    id: "7c2e5a90-3b1d-4f6e-9c0a-2d8e7f1341ab",
  },
  {
    name: "Dmitri Volkov",
    mail: "d.volkov@baltica.example",
    accepted: "2026-09-29",
    duplicate: true,
  },
  {
    name: "Elena Petrova",
    mail: "elena.petrova@vendor-partners.example",
    cohort: "Vendor",
    invited: "2026-09-29",
    accepted: "2026-09-30",
  },
];

// "… 19 more": healthy Pilot editors, spread so the cast spans 12 organizations.
const MORE: Cast[] = [
  ["Kari Solberg", "kari.solberg@halden-geo.example"],
  ["Erik Moen", "erik.moen@halden-geo.example"],
  ["Grace Adeyemi", "g.adeyemi@northfield.example"],
  ["Owen Hartley", "owen.hartley@northfield.example"],
  ["Jana Weber", "jana.weber@rheinseis.example"],
  ["Felix Brandt", "felix.brandt@rheinseis.example"],
  ["Yuki Sato", "y.sato@kaiyo-data.example"],
  ["Kenji Mori", "k.mori@kaiyo-data.example"],
  ["Luca Bianchi", "luca.bianchi@adriatica.example"],
  ["Moussa Keita", "moussa.keita@sahelgeo.example"],
  ["Sigrid Aune", "sigrid.aune@fjordline.example"],
  ["Magnus Berg", "magnus.berg@fjordline.example"],
  ["Mei Lin Tan", "meilin.tan@pacrim-energy.example"],
  ["Andris Kalnins", "andris.kalnins@baltica.example"],
  ["Carlos Mendes", "carlos.mendes@meridian-subsurface.example"],
  ["Aisha Rahman", "aisha.rahman@meridian-subsurface.example"],
  ["Tom Becker", "tom.becker@meridian-subsurface.example"],
  ["Nina Kowalski", "nina.kowalski@meridian-subsurface.example"],
  ["Samuel Osei", "samuel.osei@meridian-subsurface.example"],
].map(([name, mail]) => ({ name: name as string, mail: mail as string }));

export const PEOPLE: readonly Person[] = [...NAMED, ...MORE].map((c) => {
  const cohort = c.cohort ?? "Pilot";
  const invited = c.invited ?? (cohort === "Permanent" ? "2026-06-02" : "2026-09-28");
  const accepted = c.accepted === null ? undefined : (c.accepted ?? invited);
  return {
    id: c.id ?? guid(c.mail),
    name: c.name,
    mail: c.mail,
    role: c.role ?? "editors",
    cohort,
    invited,
    ...(accepted ? { accepted } : {}),
    ...(c.member ? { member: true } : {}),
    ...(c.notInUsers ? { notInUsers: true } : {}),
    ...(c.duplicate ? { duplicate: true } : {}),
    ...(c.otherMails ? { otherMails: c.otherMails } : {}),
  };
});

export const YOU = PEOPLE[0] as Person;

export function person(name: string): Person {
  const p = PEOPLE.find((x) => x.name === name);
  if (!p) throw new Error(`no ${name} in the sample cast`);
  return p;
}

export const PASS_ENDS = { Pilot: "2026-10-28", Vendor: "2026-10-29" } as const;

export interface App {
  appId: string;
  objectId: string;
  name: string;
  group: "ops" | "viewers" | "editors" | "admins";
}

export const APPS: readonly App[] = [
  { appId: SAMPLE_PROFILE.admeAppId, name: "contoso-adme-root-app", group: "ops" },
  {
    appId: "2d4c8a15-7e36-4f02-b9d1-5c0a6e8f9e13",
    name: "contoso-adme-tier-viewer",
    group: "viewers",
  },
  {
    appId: "a07f3c62-1d84-4e9b-8a25-f6b0d1c43b68",
    name: "contoso-adme-tier-editor",
    group: "editors",
  },
  {
    appId: "c5b24e97-0a3f-4c61-9d8e-2b7f5a1c70da",
    name: "contoso-adme-tier-admin",
    group: "admins",
  },
].map((a) => ({ ...a, group: a.group as App["group"], objectId: guid(`sp:${a.appId}`) }));

export function app(name: string): App {
  const a = APPS.find((x) => x.name === name);
  if (!a) throw new Error(`no ${name} in the sample apps`);
  return a;
}

// ---- Entitlements: the role groups and every group they are nested in ----

export const ROLE_GROUPS = {
  users: `users${D}`,
  viewers: `users.datalake.viewers${D}`,
  editors: `users.datalake.editors${D}`,
  admins: `users.datalake.admins${D}`,
  ops: `users.datalake.ops${D}`,
} as const;

const svc = (names: string[]) => names.map((n) => `${n}${D}`);

const VIEWER_PARENTS = svc([
  "data.default.viewers",
  "service.entitlements.user",
  "service.legal.user",
  "service.search.user",
  "service.storage.viewer",
  "service.schema-service.viewers",
  "service.file.viewers",
  "service.dataset.viewers",
  "service.workflow.viewer",
  "service.unit.viewers",
]);

const EDITOR_PARENTS = svc([
  "data.default.viewers",
  "data.default.owners",
  "service.entitlements.user",
  "service.legal.user",
  "service.legal.editor",
  "service.search.user",
  "service.storage.viewer",
  "service.storage.creator",
  "service.schema-service.viewers",
  "service.schema-service.editors",
  "service.file.viewers",
  "service.file.editors",
  "service.dataset.viewers",
  "service.dataset.editors",
  "service.workflow.viewer",
  "service.workflow.creator",
  "service.delivery.viewer",
  "service.notification.user",
  "service.notification.editor",
  "service.register.viewer",
  "service.register.editor",
  "service.unit.viewers",
  "service.crs-catalog.viewers",
  "service.crs-conversion.user",
  "service.seistore.viewer",
  "service.seistore.editor",
  "service.wellbore-ddms.viewers",
  "service.wellbore-ddms.editors",
  "service.indexer.viewer",
  "service.messaging.user",
  "service.edsdms.user",
]);

const ADMIN_PARENTS = [
  ...EDITOR_PARENTS,
  ...svc([
    "service.messaging.admin",
    "service.entitlements.admin",
    "service.legal.admin",
    "service.storage.admin",
    "service.search.admin",
    "service.schema-service.admin",
    "service.file.admin",
    "service.dataset.admin",
    "service.workflow.admin",
    "service.register.admin",
    "service.notification.admin",
    "service.crs-catalog.admin",
    "service.unit.admin",
    "service.seistore.admin",
    "service.wellbore-ddms.admin",
    "service.indexer.admin",
  ]),
];

const OPS_PARENTS = [
  ...EDITOR_PARENTS,
  ...svc([
    "service.entitlements.admin",
    "service.legal.admin",
    "service.storage.admin",
    "service.search.admin",
    "service.schema-service.admin",
    "service.file.admin",
    "service.dataset.admin",
    "service.workflow.admin",
    "service.indexer.admin",
    "service.partition.admin",
    "service.seistore.admin",
    "seistore.system.admin",
    "service.policy.admin",
  ]),
];

// What each role group is nested in. Sized so the effective counts match the spec:
// Editor 33, Admin 49 and Ops 46, users@ included.
export const PARENTS: Record<keyof typeof ROLE_GROUPS, string[]> = {
  users: [],
  viewers: VIEWER_PARENTS,
  editors: EDITOR_PARENTS,
  admins: ADMIN_PARENTS,
  ops: OPS_PARENTS,
};

export const RECORD_GROUPS = {
  pilotViewers: `data.pilot.viewers${D}`,
  pilotOwners: `data.pilot.owners${D}`,
  vendorViewers: `data.vendor.viewers${D}`,
  legacyViewers: `data.legacy.viewers${D}`,
} as const;

// ---- Seismic: 13 subprojects in tenant opendes ----

type Who = string;

export interface SubprojectCast {
  name: string;
  ltag: string;
  policy: "uniform" | "dataset";
  admins: Who[] | "default";
  viewers: Who[] | "default";
}

const TV = "contoso-adme-tier-viewer";
const TE = "contoso-adme-tier-editor";
const TA = "contoso-adme-tier-admin";

export const SUBPROJECTS: readonly SubprojectCast[] = [
  {
    name: "alpha",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Priya Nair", "Ingrid Halvorsen", "Tomas Reyes"],
    viewers: ["Marcus Oyelaran", TV, TE, TA],
  },
  {
    name: "bravo",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Priya Nair", "Ingrid Halvorsen"],
    viewers: [TV],
  },
  {
    name: "charlie",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Ingrid Halvorsen"],
    viewers: ["Elena Petrova", TV],
  },
  {
    name: "delta",
    ltag: "opendes-public-norway",
    policy: "uniform",
    admins: ["Ingrid Halvorsen"],
    viewers: ["Marcus Oyelaran", TV, "Kari Solberg"],
  },
  {
    name: "sleipner",
    ltag: "opendes-public-norway",
    policy: "uniform",
    admins: ["Tomas Reyes"],
    viewers: ["Hiro Tanaka", TV],
  },
  {
    name: "echo",
    ltag: "opendes-public-usa-dataset",
    policy: "uniform",
    admins: ["Sofia Marchetti", "Ingrid Halvorsen"],
    viewers: [TV],
  },
  {
    name: "foxtrot",
    ltag: "opendes-pilot-trial",
    policy: "dataset",
    admins: ["Tomas Reyes"],
    viewers: ["Sofia Marchetti", TV],
  },
  {
    name: "golf",
    ltag: "opendes-pilot-trial",
    policy: "dataset",
    admins: ["Ingrid Halvorsen"],
    viewers: ["Dmitri Volkov", TV],
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

export function sdmsGroup(name: string, role: "admin" | "viewer"): string {
  return `data.sdms.opendes.${name}.${guid(`sdms:${name}`)}.${role}${D}`;
}

export function aclOf(s: SubprojectCast, role: "admin" | "viewer"): string {
  const who = role === "admin" ? s.admins : s.viewers;
  if (who === "default")
    return role === "admin" ? `data.default.owners${D}` : `data.default.viewers${D}`;
  return sdmsGroup(s.name, role);
}

// An object id for a person or an app id for an application, by display name.
export function idOf(who: Who): string {
  return APPS.find((a) => a.name === who)?.appId ?? person(who).id;
}

// ---- Legal tags: 14 valid, 1 invalid ----

export interface Tag {
  name: string;
  description: string;
  expires: string;
  countries: string[];
  dataType: string;
  classification: "Public" | "Private" | "Confidential";
  valid: boolean;
}

const publicTag = (name: string, description: string, country: string): Tag => ({
  name,
  description,
  expires: "2099-12-31",
  countries: [country],
  dataType: "Public Domain Data",
  classification: "Public",
  valid: true,
});

export const TAGS: readonly Tag[] = [
  {
    name: "opendes-pilot-trial",
    description: "Pilot trial data shared with the pilot cohort",
    expires: "2026-10-24",
    countries: ["US"],
    dataType: "Third Party Data",
    classification: "Private",
    valid: true,
  },
  publicTag("opendes-public-usa-dataset", "Public US wells and logs", "US"),
  publicTag("opendes-public-norway", "Volve and other public Norwegian data", "NO"),
  publicTag("opendes-tno-netherlands", "TNO open Dutch subsurface data", "NL"),
  publicTag("opendes-reference-data", "OSDU reference values", "US"),
  publicTag("opendes-training-wells", "Training wells for onboarding", "US"),
  publicTag("opendes-demo-seismic", "Demo seismic for walkthroughs", "NO"),
  publicTag("opendes-uk-north-sea", "UK North Sea released wells", "GB"),
  publicTag("opendes-brazil-anp-open", "ANP open data sample", "BR"),
  publicTag("opendes-australia-nopims", "NOPIMS released surveys", "AU"),
  publicTag("opendes-canada-bc-open", "BC open well data", "CA"),
  publicTag("opendes-gulf-of-mexico", "Released Gulf of Mexico logs", "US"),
  publicTag("opendes-test-ingestion", "Ingestion test loads", "US"),
  publicTag("opendes-partner-sandbox", "Partner sandbox loads", "US"),
  {
    name: "opendes-legacy-training",
    description: "Retired training set",
    expires: "2026-08-31",
    countries: ["NO"],
    dataType: "Public Domain Data",
    classification: "Public",
    valid: false,
  },
];

// ---- Records: classes of records that share a kind, a legal tag and ACLs ----

export interface RecordClass {
  kind: string;
  tag: string;
  viewers: string[];
  owners: string[];
  count: number;
}

const WELL_TYPES: [string, string, number][] = [
  ["work-product-component--WellLog", "1.2.0", 412_300],
  ["master-data--Wellbore", "1.1.0", 198_450],
  ["work-product-component--SeismicTraceData", "1.3.0", 96_210],
  ["master-data--Well", "1.2.0", 88_104],
  ["dataset--File.Generic", "1.0.0", 74_902],
  ["reference-data--UnitOfMeasure", "1.0.0", 21_330],
];

const MORE_TYPES = [
  "master-data--Organisation",
  "master-data--Field",
  "master-data--Basin",
  "master-data--GeoPoliticalEntity",
  "master-data--SeismicAcquisitionSurvey",
  "master-data--SeismicProcessingProject",
  "master-data--Reservoir",
  "master-data--ReservoirSegment",
  "master-data--WellPlanningWell",
  "master-data--WellPlanningWellbore",
  "master-data--Rig",
  "master-data--StorageFacility",
  "work-product-component--WellboreTrajectory",
  "work-product-component--WellboreMarkerSet",
  "work-product-component--WellboreIntervalSet",
  "work-product-component--Document",
  "work-product-component--SeismicHorizon",
  "work-product-component--SeismicFault",
  "work-product-component--SeismicBinGrid",
  "work-product-component--SeismicLineGeometry",
  "work-product-component--VelocityModeling",
  "work-product-component--FaultSystem",
  "work-product-component--GenericRepresentation",
  "work-product-component--PPFGDataset",
  "work-product-component--RockSampleAnalysis",
  "work-product-component--WellLogAcquisition",
  "work-product-component--TubularAssembly",
  "work-product-component--NotionalSeismicLine",
  "work-product--WorkProduct",
  "dataset--File.CompressedVectorHeaders",
  "dataset--FileCollection.SEGY",
  "dataset--FileCollection.Slb.OpenZGY",
  "dataset--File.OGC.GeoTIFF",
  "dataset--File.WITSML",
  "dataset--File.Image.PNG",
  "dataset--File.Document",
  "dataset--ConnectedSource.Generic",
  "reference-data--UnitQuantity",
  "reference-data--CoordinateReferenceSystem",
  "reference-data--CoordinateTransformation",
  "reference-data--FacilityType",
  "reference-data--FacilityStateType",
  "reference-data--FacilityEventType",
  "reference-data--OperatingEnvironment",
  "reference-data--VerticalMeasurementType",
  "reference-data--VerticalMeasurementPath",
  "reference-data--VerticalMeasurementSource",
  "reference-data--WellboreTrajectoryType",
  "reference-data--WellInterestType",
  "reference-data--WellRole",
  "reference-data--WellBusinessIntention",
  "reference-data--WellBusinessIntentionOutcome",
  "reference-data--WellStatusSummary",
  "reference-data--WellProductType",
  "reference-data--WellCondition",
  "reference-data--WellFluidDirection",
  "reference-data--WellTechnologyApplied",
  "reference-data--DrillingReasonType",
  "reference-data--OutcomeType",
  "reference-data--LogCurveType",
  "reference-data--LogCurveFamily",
  "reference-data--LogCurveMainFamily",
  "reference-data--LogType",
  "reference-data--MarkerType",
  "reference-data--GeologicUnitType",
  "reference-data--LithologyType",
  "reference-data--SeismicAttributeType",
  "reference-data--SeismicDomainType",
  "reference-data--SeismicTraceDataDimensionalityType",
  "reference-data--SeismicGeometryType",
  "reference-data--SeismicProcessingStageType",
  "reference-data--SeismicWaveType",
  "reference-data--SeismicFilteringType",
  "reference-data--SeismicMigrationType",
  "reference-data--SeismicStackingType",
  "reference-data--SeismicPickingType",
  "reference-data--SeismicEnergySourceType",
  "reference-data--SeismicFaultType",
  "reference-data--SeismicHorizonType",
  "reference-data--SeismicBinGridType",
  "reference-data--SchemaFormatType",
  "reference-data--EncodingFormatType",
  "reference-data--ResourceSecurityClassification",
  "reference-data--SecuritySecurityClassification",
  "reference-data--LegalStatus",
  "reference-data--ExportClassificationControlNumber",
  "reference-data--DataRuleRole",
  "reference-data--ContractorType",
  "reference-data--ParameterType",
  "reference-data--ParameterRole",
  "reference-data--QualitativeSpatialAccuracyType",
  "reference-data--QuantitativeAccuracyBand",
  "reference-data--SpatialGeometryType",
  "reference-data--SpatialParameterType",
  "reference-data--AnisotropyType",
  "reference-data--AliasNameType",
  "reference-data--AliasNameTypeClass",
  "reference-data--ArtefactRole",
  "reference-data--AzimuthReferenceType",
  "reference-data--BasinType",
  "reference-data--BitType",
  "reference-data--CalculationMethodType",
  "reference-data--CompressionMethodType",
  "reference-data--ContextType",
  "reference-data--CurveIndexDimensionType",
  "reference-data--CurveSampleType",
  "reference-data--DimensionType",
  "reference-data--DocumentType",
  "reference-data--FacilityStateType",
];

// 208 more kinds share 393,216 records, each smaller than the sixth. Types run out
// at their first version, so later ones take a second version.
function tailKinds(): [string, number][] {
  const types = [...new Set(MORE_TYPES)];
  const out: [string, number][] = [];
  for (let i = 0; out.length < 208; i++) {
    const type = types[i % types.length] as string;
    const version = i < types.length ? "1.0.0" : "1.1.0";
    out.push([`osdu:wks:${type}:${version}`, 1_890 + (out.length < 96 ? 1 : 0)]);
  }
  return out;
}

export const KINDS: readonly [string, number][] = [
  ...WELL_TYPES.map(([t, v, n]): [string, number] => [`osdu:wks:${t}:${v}`, n]),
  ...tailKinds(),
];

const DEFAULT_ACL = { viewers: [`data.default.viewers${D}`], owners: [`data.default.owners${D}`] };

// Each kind's records split by legal tag; a few slices carry the pilot or vendor ACLs.
function classesOf(kind: string, count: number, i: number): RecordClass[] {
  const pilot = i < 6 ? Math.round(count * 0.0065) : 0;
  const vendor = i < 6 ? Math.round(count * 0.041) : 0;
  const tno = Math.round(count * 0.076);
  const norway = Math.round(count * 0.305);
  const usa = count - pilot - vendor - tno - norway;
  const parts: RecordClass[] = [
    { kind, tag: "opendes-public-usa-dataset", ...DEFAULT_ACL, count: usa },
    { kind, tag: "opendes-public-norway", ...DEFAULT_ACL, count: norway },
    {
      kind,
      tag: "opendes-tno-netherlands",
      viewers: [`data.default.viewers${D}`],
      owners: [`data.default.owners${D}`],
      count: tno,
    },
  ];
  if (vendor > 0) {
    parts.push({
      kind,
      tag: "opendes-public-usa-dataset",
      viewers: [RECORD_GROUPS.vendorViewers],
      owners: [`data.default.owners${D}`],
      count: vendor,
    });
  }
  if (pilot > 0) {
    parts.push({
      kind,
      tag: "opendes-pilot-trial",
      viewers: [RECORD_GROUPS.pilotViewers],
      owners: [RECORD_GROUPS.pilotOwners],
      count: pilot,
    });
  }
  return parts.filter((p) => p.count > 0);
}

export const RECORD_CLASSES: readonly RecordClass[] = KINDS.flatMap(([kind, n], i) =>
  classesOf(kind, n, i),
);

// ---- The audit log: calls per person per day ----

export interface Calls {
  who: string;
  day: string;
  calls: number;
}

// Ingrid (you), Priya and Dmitri called this week; Tomas last called on 2026-09-20.
export const AUDIT: readonly Calls[] = [
  ...[
    ["2026-09-22", 88],
    ["2026-09-24", 132],
    ["2026-09-26", 41],
    ["2026-09-29", 117],
    ["2026-09-30", 96],
    ["2026-10-01", 140],
    ["2026-10-02", 60],
  ].map(([day, calls]) => ({
    who: "Ingrid Halvorsen",
    day: day as string,
    calls: calls as number,
  })),
  { who: "Tomas Reyes", day: "2026-09-20", calls: 8 },
  { who: "Priya Nair", day: "2026-09-29", calls: 14 },
  { who: "Priya Nair", day: "2026-09-30", calls: 25 },
  { who: "Dmitri Volkov", day: "2026-10-01", calls: 3 },
  { who: "Dmitri Volkov", day: "2026-10-02", calls: 12 },
];

// The platform's release on each service that reports one; seismic and wellbore answer
// without a version, policy and reservoir are not enabled.
export const SERVICES: Record<string, { version?: string; off?: true; status?: number }> = {
  entitlements: { version: "0.28.2" },
  legal: { version: "0.28.0" },
  storage: { version: "0.28.1" },
  search: { version: "0.28.1" },
  indexer: { version: "0.28.1" },
  schema: { version: "0.28.0" },
  partition: { status: 403 },
  file: { version: "0.28.0" },
  dataset: { version: "0.28.0" },
  workflow: { version: "0.28.1" },
  register: { version: "0.28.0" },
  notification: { version: "0.28.0" },
  unit: { version: "0.28.0" },
  "crs-catalog": { version: "0.28.0" },
  "crs-conversion": { version: "0.28.0" },
  policy: { off: true },
  seismic: {},
  wellbore: { version: "0.28.0" },
  reservoir: { off: true },
};

export const AZURE_SINCE = "2026-09-12T08:00:00Z";
