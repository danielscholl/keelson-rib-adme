import type { KindCounts, LegalTag, LegalTags } from "../../src/data/areas";
import type { Health } from "../../src/data/health";

// The ADME Data cast from design/spec.md. "Now" is 2026-10-02 14:05 UTC.
export const NOW = new Date("2026-10-02T14:05:00Z");

const v28 = (service: string, version: string) => ({ service, state: "up" as const, version });

export const SAMPLE_HEALTH: Health = {
  services: [
    v28("entitlements", "0.28.2"),
    v28("legal", "0.28.0"),
    v28("storage", "0.28.1"),
    v28("search", "0.28.1"),
    v28("indexer", "0.28.1"),
    v28("schema", "0.28.0"),
    { service: "partition", state: "up", status: 403, message: "service principals only" },
    v28("file", "0.28.0"),
    v28("dataset", "0.28.0"),
    v28("workflow", "0.28.1"),
    v28("register", "0.28.0"),
    v28("notification", "0.28.0"),
    v28("unit", "0.28.0"),
    v28("crs-catalog", "0.28.0"),
    v28("crs-conversion", "0.28.0"),
    { service: "policy", state: "off", status: 404 },
    { service: "seismic", state: "up" },
    v28("wellbore", "0.28.0"),
    { service: "reservoir", state: "off", status: 404 },
  ],
  azure: { state: "Available", since: "2026-09-12T08:00:00Z" },
};

const publicTag = (name: string, country: string): LegalTag => ({
  name,
  expirationDate: "2099-12-31",
  countries: [country],
  dataType: "Public Domain Data",
  securityClassification: "Public",
});

const moreValid: LegalTag[] = Array.from({ length: 11 }, (_, i) =>
  publicTag(`opendes-sample-tag-${String(i + 1).padStart(2, "0")}`, "US"),
);

export const SAMPLE_LEGAL: LegalTags = {
  valid: [
    {
      name: "opendes-pilot-trial",
      expirationDate: "2026-10-24",
      countries: ["US"],
      dataType: "Third Party Data",
      securityClassification: "Private",
    },
    publicTag("opendes-public-usa-dataset", "US"),
    publicTag("opendes-public-norway", "NO"),
    ...moreValid,
  ],
  invalid: [
    {
      name: "opendes-legacy-training",
      expirationDate: "2026-08-31",
      countries: ["NO"],
      dataType: "Public Domain Data",
      securityClassification: "Public",
    },
  ],
};

const TOP_KINDS = [
  { kind: "osdu:wks:work-product-component--WellLog:1.2.0", count: 412_300 },
  { kind: "osdu:wks:master-data--Wellbore:1.1.0", count: 198_450 },
  { kind: "osdu:wks:work-product-component--SeismicTraceData:1.3.0", count: 96_210 },
  { kind: "osdu:wks:master-data--Well:1.2.0", count: 88_104 },
  { kind: "osdu:wks:dataset--File.Generic:1.0.0", count: 74_902 },
  { kind: "osdu:wks:reference-data--UnitOfMeasure:1.0.0", count: 21_330 },
];

// 208 more kinds sharing 393,216 records, each smaller than the sixth.
const tail = Array.from({ length: 208 }, (_, i) => ({
  kind: `osdu:wks:reference-data--Sample${String(i + 1).padStart(3, "0")}:1.0.0`,
  count: 1_890 + (i < 96 ? 1 : 0),
}));

export const SAMPLE_KINDS: KindCounts = {
  total: 1_284_512,
  kinds: [...TOP_KINDS, ...tail],
};
