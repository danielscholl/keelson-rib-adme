// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { ACTIVITY_AREA } from "../access/activity.ts";
import { measuredAccess } from "../access/measured.ts";
import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import { healthChip } from "../boards/health.ts";
import { operatorRole } from "../connection.ts";
import { KINDS_AREA, type KindCounts, LEGAL_AREA, type LegalTags } from "../data/areas.ts";
import { FACETS, FACETS_AREA, type Facets } from "../data/facets.ts";
import { HEALTH_AREA, type Health, verdict } from "../data/health.ts";
import { directoryOf, labelOf } from "../directory/build.ts";
import { instanceName } from "../profile.ts";
import type { Runtime } from "../runtime.ts";
import { buildSeismic, type SeismicModel } from "../seismic/model.ts";
import { isDefaultGroup, SEISMIC_AREA, type SeismicRead } from "../seismic/read.ts";
import {
  type Completeness,
  READ_SERVICE,
  type ReadArea,
  type ReadSignal,
  readSignal,
} from "../status/index.ts";
import { type Brief, type BriefInputs, buildBrief } from "./index.ts";

function availability(health: Health | undefined, area: ReadArea): "up" | "down" | "unknown" {
  const service = READ_SERVICE[area];
  const probe = service ? health?.services.find((s) => s.service === service) : undefined;
  if (!probe || probe.state === "off") return "unknown";
  return probe.state;
}

function seismicCompleteness(read: SeismicRead | undefined): Completeness | undefined {
  if (!read) return undefined;
  if (read.source === "own-groups") {
    return {
      complete: false,
      text: "subprojects listed from your own groups; listing was refused",
    };
  }
  const emails = [...new Set(read.subprojects.flatMap((s) => [...s.admins, ...s.viewers]))].filter(
    (e) => !isDefaultGroup(e),
  );
  const unknownRole = read.subprojects.filter(
    (s) => s.admins.length === 0 || s.viewers.length === 0,
  ).length;
  const done = emails.filter((e) => read.groups[e]?.members).length;
  const complete = done === emails.length && unknownRole === 0;
  return { complete, text: `${done} of ${emails.length} groups read` };
}

function signalsOf(rt: Runtime): ReadSignal[] {
  const now = rt.now();
  const health = rt.cache.get<Health>(HEALTH_AREA).data;
  const access = rt.cache.get<AccessRead>(ACCESS_AREA);
  const seismic = rt.cache.get<SeismicRead>(SEISMIC_AREA);
  const facets = rt.cache.get<Facets>(FACETS_AREA);
  const groups = seismicCompleteness(seismic.data);
  const facetErrors = Object.keys(facets.data?.errors ?? {}).length;
  return [
    readSignal({
      area: "access",
      measured: access,
      available: availability(health, "access"),
      ...(access.data && !access.data.closures
        ? { completeness: { complete: false, text: "nested role groups not read" } }
        : {}),
      cost: "about 12 calls",
      now,
    }),
    readSignal({
      area: "activity",
      measured: rt.cache.get(ACTIVITY_AREA),
      configured: Boolean(rt.profile?.logWorkspaceId),
      cost: "one query",
      now,
    }),
    readSignal({
      area: "seismic",
      measured: seismic,
      available: availability(health, "seismic"),
      ...(groups ? { completeness: groups } : {}),
      cost: seismic.data
        ? `about ${1 + Object.keys(seismic.data.groups).length} calls`
        : "one call per subproject group",
      now,
    }),
    readSignal({
      area: "legal",
      measured: rt.cache.get(LEGAL_AREA),
      available: availability(health, "legal"),
      cost: "two calls",
      now,
    }),
    readSignal({
      area: "kinds",
      measured: rt.cache.get(KINDS_AREA),
      available: availability(health, "kinds"),
      cost: "two calls",
      now,
    }),
    readSignal({
      area: "facets",
      measured: facets,
      available: availability(health, "facets"),
      ...(facets.data && facetErrors > 0
        ? {
            completeness: {
              complete: false,
              text: `${FACETS.length - facetErrors} of ${FACETS.length} counts read`,
            },
          }
        : {}),
      cost: `${FACETS.length} calls`,
      now,
    }),
  ];
}

export function seismicModelOf(rt: Runtime): SeismicModel | undefined {
  const read = rt.cache.get<SeismicRead>(SEISMIC_AREA).data;
  if (!read || rt.status.phase === "firstrun" || rt.status.phase === "profile-error") {
    return undefined;
  }
  const directory = directoryOf(rt);
  return buildSeismic(read, {
    directory: rt.cache.get<AccessRead>(ACCESS_AREA).data?.directory,
    labelOf: (id) => labelOf(directory, id),
    signedInAs: rt.status.test?.signedInAs,
    admeAppId: rt.profile?.admeAppId,
  });
}

// Everything the brief reads, gathered from the runtime in one place.
export function briefInputs(rt: Runtime): BriefInputs {
  const profile = rt.profile;
  const directory = directoryOf(rt);
  const access = measuredAccess(rt);
  const seismic = seismicModelOf(rt);
  const legal = rt.cache.get<LegalTags>(LEGAL_AREA).data;
  const facets = rt.cache.get<Facets>(FACETS_AREA).data;
  const kinds = rt.cache.get<KindCounts>(KINDS_AREA).data;
  const accessRead = rt.cache.get<AccessRead>(ACCESS_AREA).data;
  const signedIn = rt.status.test?.signedInAs;
  const you = access?.model.people.find((p) => p.you);
  const role = operatorRole(rt.status.test);
  const health = rt.cache.get<Health>(HEALTH_AREA).data;
  const chip = healthChip(verdict(health));
  return {
    now: rt.now(),
    phase: rt.status.phase,
    sample: rt.sample,
    ...(profile ? { instance: { name: instanceName(profile), partition: profile.partition } } : {}),
    ...(you || signedIn
      ? { operator: { name: you?.name ?? signedIn ?? "", ...(role ? { role } : {}) } }
      : {}),
    directory,
    ...(access ? { access } : {}),
    ...(accessRead ? { accessRead } : {}),
    ...(seismic ? { seismic } : {}),
    ...(legal ? { legal } : {}),
    ...(facets ? { tagCounts: facets.tags } : {}),
    ...(kinds ? { kinds } : {}),
    ...(health ? { health: { text: chip.label, tone: chip.tone } } : {}),
    signals: signalsOf(rt),
  };
}

export function briefOf(rt: Runtime): Brief {
  return buildBrief(briefInputs(rt));
}
