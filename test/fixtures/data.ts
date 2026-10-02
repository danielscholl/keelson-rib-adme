import type { KindCounts, LegalTag, LegalTags, ServiceProbe } from "../../src/data/areas";

// The ADME Data cast from design/spec.md. "Now" is 2026-10-02 14:05 UTC.
export const NOW = new Date("2026-10-02T14:05:00Z");

export const SAMPLE_SERVICES: ServiceProbe[] = [
  { service: "entitlements", state: "ok", version: "0.28.2" },
  { service: "legal", state: "ok", version: "0.28.0" },
  { service: "storage", state: "ok", version: "0.28.1" },
  { service: "search", state: "ok", version: "0.28.1" },
  { service: "schema", state: "unprobed" },
  { service: "workflow", state: "unprobed" },
  { service: "file", state: "unprobed" },
  { service: "indexer", state: "unprobed" },
  {
    service: "partition",
    state: "forbidden",
    status: 403,
    message: "not permitted (service principal only)",
  },
  { service: "seismic", state: "ok" },
];

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
