// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import {
  CAPABILITY_IDS,
  CAPABILITY_LABELS,
  type ConnectionStatus,
  signinCommand,
} from "../connection.ts";
import { instanceName, type Profile } from "../profile.ts";

type Section = CanvasBoardView["sections"][number];
type Pill = NonNullable<NonNullable<CanvasBoardView["header"]>["status"]>;

export const SAVE_PROFILE_ACTION = "save-profile";
export const RETEST_ACTION = "retest-connection";

export const SIGNIN_REASON = "sign-in needed: run az login, then Re-test";

export function phasePill(status: ConnectionStatus): Pill {
  switch (status.phase) {
    case "connected":
      return { label: "connected", tone: "ok" };
    case "signin":
      return { label: "sign-in needed", tone: "error" };
    case "profile-error":
      return { label: "check the connection", tone: "error" };
    case "firstrun":
      return { label: "not connected", tone: "neutral" };
  }
}

export function instanceChip(profile: Profile | undefined): string | undefined {
  return profile ? `${instanceName(profile)} · ${profile.partition}` : undefined;
}

export function signinCard(status: ConnectionStatus): Section {
  return {
    kind: "cards",
    title: "Sign in again",
    items: [
      {
        title: "az login",
        mono: true,
        edge: "error",
        pill: { label: "needed", tone: "error" },
        fields: [{ label: "Command", value: signinCommand(status.profile), copyable: true }],
        footnote:
          "Run this in a terminal, then Re-test. Until then this page shows the last sweep and changes are paused.",
      },
    ],
  };
}

export function retestAction(brand: boolean): CanvasActionItem {
  return { type: RETEST_ACTION, label: "Re-test connection", ...(brand ? { tone: "brand" } : {}) };
}

const PROFILE_FIELDS: { name: keyof Profile; label: string; placeholder: string }[] = [
  { name: "host", label: "Host", placeholder: "contoso-adme.energy.azure.com" },
  { name: "partition", label: "Partition", placeholder: "opendes" },
  {
    name: "entitlementsDomain",
    label: "Entitlements domain",
    placeholder: "opendes.dataservices.energy",
  },
  { name: "tenantId", label: "Tenant id", placeholder: "Entra tenant GUID" },
  { name: "admeAppId", label: "ADME app id", placeholder: "app registration GUID" },
  { name: "rosterGroupId", label: "Roster group id", placeholder: "Entra group GUID" },
];

export function profileForm(profile: Profile | undefined, expanded: boolean): CanvasActionItem {
  return {
    type: SAVE_PROFILE_ACTION,
    label: profile ? "Edit profile" : "Test connection",
    submitLabel: "Test connection",
    submitTone: "brand",
    pendingLabel: "Testing…",
    ...(expanded ? { expanded: true } : {}),
    fields: PROFILE_FIELDS.map((f) => ({
      name: f.name,
      label: f.label,
      placeholder: f.placeholder,
      required: true,
      half: f.name !== "host",
      ...(profile ? { defaultValue: profile[f.name] } : {}),
    })),
  };
}

function profileCard(profile: Profile): Section {
  return {
    kind: "cards",
    title: "Instance profile (no secrets)",
    boxed: true,
    items: [
      {
        title: instanceName(profile),
        mono: true,
        fields: PROFILE_FIELDS.map((f) => ({
          label: f.label,
          value: profile[f.name],
          copyable: true,
        })),
      },
    ],
  };
}

export function capabilityTable(status: ConnectionStatus): Section | undefined {
  const test = status.test;
  if (!test) return undefined;
  const rows = CAPABILITY_IDS.map((id) => {
    const cap = test.capabilities.find((c) => c.id === id);
    const result = cap?.result ?? "?";
    const tone = result === "yes" ? "ok" : result === "?" ? "neutral" : "warn";
    return {
      capability: CAPABILITY_LABELS[id].label,
      result: { value: result, tone },
      source: cap?.detail ?? CAPABILITY_LABELS[id].source,
    } as const;
  });
  return {
    kind: "table",
    title: "What this sign-in can do",
    columns: [
      { key: "capability", label: "Capability" },
      { key: "result", label: "Result" },
      { key: "source", label: "Source" },
    ],
    rows,
    caption: test.signedInAs
      ? `Tested as ${test.signedInAs}. A missing capability disables the feature that needs it.`
      : "A missing capability disables the feature that needs it.",
  };
}

// The footer of all three surfaces: collapsed to "connected" when all is well,
// open with the sign-in card when it is not.
export function composeConnection(status: ConnectionStatus): CanvasBoardView {
  const chip = instanceChip(status.profile);
  const header = {
    status: phasePill(status),
    ...(chip ? { chip } : {}),
    defaultCollapsed: status.phase === "connected",
  };
  if (!status.profile) {
    return {
      view: "board",
      header,
      sections: [
        {
          kind: "rows",
          items: [{ glyph: "neutral", text: "Finish the steps on the ADME Access tab." }],
        },
      ],
    };
  }
  const sections: Section[] = [];
  if (status.phase === "signin") sections.push(signinCard(status));
  if (status.phase === "profile-error" && status.error) {
    sections.push({ kind: "rows", items: [{ glyph: "error", text: status.error }] });
  }
  sections.push({
    kind: "actions",
    wrap: true,
    items: [retestAction(status.phase !== "connected"), profileForm(status.profile, false)],
  });
  sections.push(profileCard(status.profile));
  const table = capabilityTable(status);
  if (table) sections.push(table);
  if (status.phase !== "connected") {
    sections.push({
      kind: "rows",
      boxed: true,
      items: [{ text: "Changes", trailing: "paused until Re-test passes" }],
    });
  }
  return { view: "board", header, sections };
}

// The connect journey shown on the ADME Access header before the rib works.
export function composeFirstRun(status: ConnectionStatus): CanvasBoardView {
  const sections: Section[] = [
    {
      kind: "journey",
      title: "Connect",
      items: [
        {
          title: "Sign in with Azure CLI",
          text: "Run az login in a terminal. The rib uses that sign-in and stores no secret.",
        },
        {
          title: "Describe the instance",
          text: "Six values, none secret. They are saved as the instance profile and stamped on every change.",
        },
        {
          title: "Test connection",
          text: "About 7 read-only calls. The result records what this sign-in can and cannot do.",
        },
      ],
    },
    {
      kind: "cards",
      title: "Step 1: sign in",
      items: [
        {
          title: "Azure CLI",
          mono: true,
          fields: [{ label: "Command", value: signinCommand(status.profile), copyable: true }],
          footnote: "Use the tenant that holds the ADME instance.",
        },
      ],
    },
  ];
  if (status.error) {
    sections.push({ kind: "rows", items: [{ glyph: "error", text: status.error }] });
  }
  sections.push({
    kind: "actions",
    title: "Step 2: instance profile",
    items: [profileForm(status.profile, true)],
  });
  const table = capabilityTable(status);
  if (table) sections.push({ ...table, title: "Step 3: what this sign-in can do" });
  return {
    view: "board",
    header: { status: phasePill(status) },
    sections,
  };
}
