// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { join } from "node:path";
import { Store } from "../store.ts";
import { trackerFile } from "../tracker.ts";
import { sampleExec, sampleTransport } from "./transport.ts";
import { PASS_ENDS, PEOPLE, SAMPLE_NOW, SAMPLE_PROFILE } from "./world.ts";

export const SAMPLE_ENV = "KEELSON_ADME_SAMPLE";

export function sampleMode(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[SAMPLE_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// The spec's "now", running forward from the moment the rib bound.
export function sampleClock(start = Date.now()): () => Date {
  const base = Date.parse(SAMPLE_NOW);
  return () => new Date(base + (Date.now() - start));
}

function trackerSeed() {
  return {
    cohorts: [
      { name: "Pilot", created: "2026-09-28", passEnds: PASS_ENDS.Pilot },
      { name: "Vendor", created: "2026-09-29", passEnds: PASS_ENDS.Vendor },
      { name: "Permanent", created: "2026-06-02" },
    ],
    members: Object.fromEntries(PEOPLE.map((p) => [p.mail, p.cohort])),
    events: [
      {
        at: "2026-09-30T10:12:00Z",
        text: "Elena Petrova added to Vendor, pass ends 2026-10-29",
        kind: "cohort",
      },
      {
        at: "2026-09-28T09:05:00Z",
        text: "29 people imported to Pilot, pass ends 2026-10-28",
        kind: "cohort",
      },
    ],
  };
}

// A store of its own under the rib's data dir, so the sample never touches a real
// profile, tracker or cache. The profile and cohorts are written fresh on every bind.
export function sampleStore(dataDir: string | undefined): Store {
  const store = new Store(dataDir ? join(dataDir, "sample") : undefined);
  store.write("profile.json", SAMPLE_PROFILE);
  store.write(trackerFile(SAMPLE_PROFILE), trackerSeed());
  return store;
}

export { sampleExec, sampleTransport };
