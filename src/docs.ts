// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibDocsSource } from "@keelson/shared";

export const DOCS: readonly RibDocsSource[] = [
  {
    title: "ADME",
    summary:
      "The ADME rib for Keelson: an admin surface for one Azure Data Manager for Energy instance, worked from the operator's Azure CLI sign-in.",
    content: [
      "# ADME rib",
      "",
      "Administers one Azure Data Manager for Energy (ADME) instance from three",
      "tabs: ADME Access (people and applications), ADME Data (services, legal",
      "tags, record counts and record search; read-only) and ADME Seismic",
      "(subprojects and who can reach them).",
      "",
      "## Connecting",
      "",
      "The rib holds no secret. The operator runs `az login --tenant <tenant id>`",
      "in a terminal. The ADME Access tab then lists the ADME instances that",
      "sign-in can see in Azure, across every subscription, and Connect on one",
      "saves its host, partition, tenant id and ADME app id as the profile. An",
      "operator with no Azure role on the instance enters those four by hand.",
      "Test connection makes about eight read-only calls, reads the entitlements",
      "domain from the instance, and records what the sign-in can do; a missing",
      "capability disables the feature that needs it, with a reason. The roster",
      "group id is optional: the rib offers an Entra group named after the",
      "instance, and the operator confirms it.",
      "",
      "Before each batch of calls the rib asks `az account get-access-token` for",
      "tokens for the ADME app id and for Microsoft Graph. When the sign-in",
      'lapses every tab reads "sign-in needed", shows the last sweep marked',
      '"cached from HH:MMZ", and pauses changes until `az login` and Re-test.',
      "",
      "## Reads",
      "",
      "A sweep runs on Refresh now, after Re-test, and on a timer only within 15",
      "minutes of the last operator action. The last sweep is cached in the rib's",
      "data directory. Record totals are summed from search's aggregate by kind,",
      "because search caps its own total at 10,000.",
      "",
      "## Changes",
      "",
      "Every change is a previewed plan: a form submits Preview plan and never",
      "writes. Apply re-runs the dry run first. The ADME Data tab never writes.",
      "",
      "## Data handling",
      "",
      "Names, email addresses and object ids are plain text in board frames and",
      "in the data directory, which suits one operator on a local workbench.",
      "Selection is held by the rib, so two browser windows share one view.",
    ].join("\n"),
  },
];
