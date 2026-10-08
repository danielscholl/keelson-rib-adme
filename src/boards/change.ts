// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import { bindingOf } from "../plan/model.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { measuredAccess } from "./access.ts";
import { SIGNIN_REASON } from "./connection.ts";
import { grantableSubprojects, PREVIEW_SEIS_GRANT_ACTION, SEIS_ROLE_OPTIONS } from "./seismic.ts";

export const PREVIEW_ADD_PEOPLE_ACTION = "preview-add-people";
export const PREVIEW_ADD_APP_ACTION = "preview-add-app";
export const PREVIEW_REMOVE_ACTION = "preview-remove-person";
export const PREVIEW_FIX_ACTION = "preview-fix-users";
export const PREVIEW_CLEANUP_ACTION = "preview-cleanup-duplicate";
export const EXPLAIN_ACTION = "explain-access";
export const PREVIEW_RESEND_ACTION = "preview-resend-invite";

const ROLE_OPTIONS = ["Viewer", "Editor", "Admin"].map((r) => ({ value: r, label: r }));

export function composeChange(rt: Runtime): CanvasBoardView {
  const profile = rt.profile;
  const measured = measuredAccess(rt);
  if (!profile || !measured) return EMPTY_BOARD;
  const signedOut = rt.status.phase !== "connected";
  const gate = signedOut ? { disabled: true, reason: SIGNIN_REASON } : {};
  const binding = { ...bindingOf(profile) };
  const preview = {
    submitLabel: "Preview plan",
    submitTone: "brand" as const,
    pendingLabel: "Planning…",
  };
  const cohorts = rt.tracker.cohorts.map((c) => ({ value: c.name, label: c.name }));
  const people = measured.model.people.map((p) => ({ value: p.id, label: p.name }));
  const subprojects = grantableSubprojects(rt);
  const items: CanvasActionItem[] = [
    {
      type: PREVIEW_ADD_PEOPLE_ACTION,
      label: "Add people",
      defaultOpen: true,
      ...preview,
      binding,
      ...gate,
      fields: [
        {
          name: "emails",
          label: "Emails, one per line",
          multiline: true,
          required: true,
          placeholder: "name@partner.example",
        },
        ...(cohorts.length > 0
          ? [
              {
                name: "cohort",
                label: "Cohort",
                options: cohorts,
                placeholder: "no cohort",
                half: true,
              },
            ]
          : []),
        { name: "passEnds", label: "Pass ends", placeholder: "YYYY-MM-DD (optional)", half: true },
        {
          name: "role",
          label: "Role",
          options: ROLE_OPTIONS,
          segmented: true,
          required: true,
          defaultValue: "Editor",
        },
      ],
    },
    {
      type: PREVIEW_SEIS_GRANT_ACTION,
      label: "Grant seismic",
      ...preview,
      binding,
      ...gate,
      ...(subprojects.length === 0 || people.length === 0
        ? { disabled: true, reason: "read the subprojects in the Seismic section first" }
        : {}),
      fields: [
        ...(people.length > 0
          ? [{ name: "id", label: "Person", options: people, required: true }]
          : [{ name: "id", label: "Person", placeholder: "nobody has entitlements" }]),
        ...(subprojects.length > 0
          ? [{ name: "subproject", label: "Subproject", options: subprojects, required: true }]
          : [{ name: "subproject", label: "Subproject", placeholder: "not read yet" }]),
        {
          name: "role",
          label: "Role",
          options: SEIS_ROLE_OPTIONS,
          segmented: true,
          required: true,
          defaultValue: "viewer",
        },
      ],
    },
    {
      type: PREVIEW_REMOVE_ACTION,
      label: "Remove person",
      ...preview,
      binding,
      ...gate,
      ...(people.length === 0 ? { disabled: true, reason: "nobody has entitlements" } : {}),
      fields:
        people.length > 0
          ? [{ name: "id", label: "Person", options: people, required: true }]
          : [{ name: "id", label: "Person", placeholder: "nobody has entitlements" }],
    },
    {
      type: PREVIEW_ADD_APP_ACTION,
      label: "Add application",
      ...preview,
      binding,
      ...gate,
      fields: [
        { name: "appId", label: "App id", required: true, placeholder: "application (client) id" },
        {
          name: "role",
          label: "Role",
          options: ROLE_OPTIONS,
          segmented: true,
          required: true,
          defaultValue: "Viewer",
        },
      ],
    },
    {
      type: EXPLAIN_ACTION,
      label: "Why 401/403",
      submitLabel: "Explain",
      submitTone: "brand",
      pendingLabel: "Checking…",
      binding,
      ...(people.length === 0 ? { disabled: true, reason: "nobody has entitlements" } : {}),
      fields:
        people.length > 0
          ? [{ name: "id", label: "Person", options: people, required: true }]
          : [{ name: "id", label: "Person", placeholder: "nobody has entitlements" }],
    },
  ];
  return {
    view: "board",
    ...(signedOut ? { header: { status: { label: "sign-in needed", tone: "error" } } } : {}),
    sections: [{ kind: "actions", tabs: true, items }],
  };
}
