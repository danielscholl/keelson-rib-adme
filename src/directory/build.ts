// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import type { Runtime } from "../runtime.ts";
import { SEISMIC_AREA, type SeismicRead } from "../seismic/read.ts";
import { Directory } from "./index.ts";

// The directory over everything the last sweep read and the operator's annotations.
export function directoryOf(rt: Runtime): Directory {
  const access = rt.cache.get<AccessRead>(ACCESS_AREA).data;
  const seismic = rt.cache.get<SeismicRead>(SEISMIC_AREA).data;
  return new Directory({
    tenant: rt.profile?.tenantId ?? "",
    entries: [access?.directory, seismic?.directory],
    annotations: rt.annotations.entries,
    deleted: access?.deleted,
    admeAppId: rt.profile?.admeAppId,
    signedInAs: rt.status.test?.signedInAs,
    you: seismic?.you,
  });
}

// The operator's label for an id the directory cannot name.
export function labelOf(directory: Directory, id: string): string | undefined {
  const r = directory.resolve(id);
  return r.nameSource === "label" ? r.name : undefined;
}
