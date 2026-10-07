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
import type { Discovery, Instance } from "../discover.ts";
import { instanceName, type Profile } from "../profile.ts";

type Section = CanvasBoardView["sections"][number];
type Pill = NonNullable<NonNullable<CanvasBoardView["header"]>["status"]>;

export const SAVE_PROFILE_ACTION = "save-profile";
export const RETEST_ACTION = "retest-connection";
export const DISCOVER_ACTION = "discover-instances";
export const CONNECT_ACTION = "connect-instance";
export const USE_ROSTER_ACTION = "use-roster-group";
export const FIND_AUDIT_ACTION = "find-audit-log";

export function findAuditAction(brand: boolean): CanvasActionItem {
  return {
    type: FIND_AUDIT_ACTION,
    label: "Find the audit log",
    pendingLabel: "Looking…",
    ...(brand ? { tone: "brand" } : {}),
  };
}

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

const PROFILE_FIELDS: {
  name: keyof Profile;
  label: string;
  placeholder: string;
  unset?: string;
}[] = [
  { name: "host", label: "Host", placeholder: "contoso-adme.energy.azure.com" },
  { name: "partition", label: "Partition", placeholder: "opendes" },
  {
    name: "entitlementsDomain",
    label: "Entitlements domain",
    placeholder: "read from the instance when left empty",
    unset: "?",
  },
  { name: "tenantId", label: "Tenant id", placeholder: "Entra tenant GUID" },
  { name: "admeAppId", label: "ADME app id", placeholder: "app registration GUID" },
  {
    name: "rosterGroupId",
    label: "Roster group id",
    placeholder: "Entra group GUID, optional",
    unset: "not set",
  },
  {
    name: "logWorkspaceId",
    label: "Audit log workspace id",
    placeholder: "Log Analytics workspace GUID, optional",
    unset: "not set",
  },
];

export function profileForm(profile: Profile | undefined, expanded: boolean): CanvasActionItem {
  return {
    type: SAVE_PROFILE_ACTION,
    label: profile ? "Edit profile" : "Enter it by hand",
    submitLabel: "Test connection",
    submitTone: "brand",
    pendingLabel: "Testing…",
    ...(expanded ? { expanded: true } : {}),
    fields: PROFILE_FIELDS.map((f) => ({
      name: f.name,
      label: f.label,
      placeholder: f.placeholder,
      required: f.unset === undefined,
      half: f.name !== "host",
      ...(profile?.[f.name] ? { defaultValue: profile[f.name] } : {}),
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
        fields: PROFILE_FIELDS.map((f) => {
          const value = profile[f.name];
          return value
            ? { label: f.label, value, copyable: true }
            : { label: f.label, value: f.unset ?? "?" };
        }),
      },
    ],
  };
}

function rosterSuggestion(status: ConnectionStatus): Section | undefined {
  const suggestion = status.test?.rosterSuggestion;
  if (!suggestion || status.profile?.rosterGroupId) return undefined;
  return {
    kind: "cards",
    title: "Roster group",
    items: [
      {
        title: suggestion.name,
        mono: true,
        fields: [{ label: "Group id", value: suggestion.id, copyable: true }],
        actions: [
          { type: USE_ROSTER_ACTION, label: "Use this group", payload: { id: suggestion.id } },
        ],
        footnote:
          "An Entra group with the instance's name. ADME never reads it; the rib keeps it for tracking.",
      },
    ],
  };
}

function instanceCard(
  instance: Instance,
): NonNullable<Extract<Section, { kind: "cards" }>["items"]>[number] {
  const many = instance.partitions.length > 1;
  return {
    title: instance.name,
    mono: true,
    ...(instance.state && instance.state !== "Succeeded"
      ? { pill: { label: instance.state.toLowerCase(), tone: "warn" as const } }
      : {}),
    fields: [
      { label: "Host", value: instance.host },
      ...(instance.location ? [{ label: "Region", value: instance.location }] : []),
      {
        label: many ? "Partitions" : "Partition",
        value: instance.partitions.join(", ") || "?",
      },
    ],
    actions: instance.partitions.map((partition) => ({
      type: CONNECT_ACTION,
      label: many ? `Connect to ${partition}` : "Connect",
      tone: "brand" as const,
      payload: { instance: instance.id, partition },
    })),
  };
}

function instancePicker(discovery: Discovery): Section {
  const title = "Step 2: pick the instance";
  if (discovery.state === "found" && discovery.instances.length > 0) {
    return { kind: "cards", title, items: discovery.instances.map(instanceCard) };
  }
  const item =
    discovery.state === "failed"
      ? { glyph: "error" as const, text: `Could not list ADME instances: ${discovery.error}` }
      : discovery.state === "found"
        ? {
            glyph: "neutral" as const,
            text: "This sign-in can see no ADME instance in Azure. Enter it by hand.",
          }
        : discovery.state === "looking"
          ? { glyph: "neutral" as const, text: "Looking for ADME instances in Azure…" }
          : { glyph: "neutral" as const, text: "Look again lists the ADME instances in Azure." };
  return { kind: "rows", title, items: [item] };
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
    items: [
      retestAction(status.phase !== "connected"),
      ...(status.profile.logWorkspaceId ? [] : [findAuditAction(false)]),
      profileForm(status.profile, false),
    ],
  });
  sections.push(profileCard(status.profile));
  const roster = rosterSuggestion(status);
  if (roster) sections.push(roster);
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
export function composeFirstRun(
  status: ConnectionStatus,
  discovery: Discovery = { state: "idle" },
): CanvasBoardView {
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
          title: "Pick the instance",
          text: "Found through your Azure sign-in. Its values, none secret, are saved as the instance profile and stamped on every change.",
        },
        {
          title: "Test connection",
          text: "About 8 read-only calls. The result records what this sign-in can and cannot do.",
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
  const listed = discovery.state === "found" && discovery.instances.length > 0;
  sections.push(instancePicker(discovery), {
    kind: "actions",
    wrap: true,
    items: [
      { type: DISCOVER_ACTION, label: "Look again" },
      profileForm(
        status.profile,
        !listed && discovery.state !== "looking" && discovery.state !== "idle",
      ),
    ],
  });
  const table = capabilityTable(status);
  if (table) sections.push({ ...table, title: "Step 3: what this sign-in can do" });
  return {
    view: "board",
    header: { status: phasePill(status) },
    sections,
  };
}
