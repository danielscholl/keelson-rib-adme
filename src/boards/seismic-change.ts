// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import type { Identity } from "../access/model.ts";
import { bindingOf } from "../plan/model.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { displayOrder, type SeismicModel } from "../seismic/model.ts";
import { accessNote, reachOf } from "../seismic/reach.ts";
import { measuredAccess } from "./access.ts";
import { SIGNIN_REASON } from "./connection.ts";
import {
  measuredSeismic,
  PREVIEW_SEIS_COPY_ACTION,
  PREVIEW_SEIS_GRANT_ACTION,
  PREVIEW_SEIS_REVOKE_ACTION,
  SEIS_REACH_ACTION,
  SEIS_ROLE_OPTIONS,
  seismicState,
  selectedSubproject,
} from "./seismic.ts";

type Section = CanvasBoardView["sections"][number];
type Field = NonNullable<CanvasActionItem["fields"]>[number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Option = { value: string; label: string };

function personField(name: string, label: string, options: Option[], first?: string): Field {
  if (options.length === 0) return { name, label, placeholder: "nobody has entitlements" };
  return {
    name,
    label,
    options,
    required: true,
    ...(first && options.some((o) => o.value === first) ? { defaultValue: first } : {}),
  };
}

function holders(model: SeismicModel, people: Identity[]): Option[] {
  return people
    .filter((p) => (model.grants[p.id] ?? []).length > 0)
    .map((p) => ({ value: p.id, label: p.name }));
}

export function composeSeismicChange(rt: Runtime): CanvasBoardView {
  const profile = rt.profile;
  const access = measuredAccess(rt);
  const seismic = measuredSeismic(rt);
  if (!profile || !access || !seismic) return EMPTY_BOARD;
  const { model } = seismic;
  const signedOut = rt.status.phase !== "connected";
  const gate = signedOut ? { disabled: true, reason: SIGNIN_REASON } : {};
  const binding = { ...bindingOf(profile) };
  const preview = {
    submitLabel: "Preview plan",
    submitTone: "brand" as const,
    pendingLabel: "Planning…",
  };
  const everyone = access.model.people.map((p) => ({ value: p.id, label: p.name }));
  const granted = holders(model, access.model.people);
  const subprojects = displayOrder(model).map((s) => ({
    value: s.name,
    label: s.name,
    ...(s.acl === "default" ? { hint: "default ACL" } : {}),
  }));
  const selected = selectedSubproject(rt, model)?.name;
  const subprojectField: Field =
    subprojects.length > 0
      ? {
          name: "subproject",
          label: "Subproject",
          options: subprojects,
          required: true,
          ...(selected ? { defaultValue: selected } : {}),
        }
      : { name: "subproject", label: "Subproject", placeholder: "no subprojects" };
  const roleField: Field = {
    name: "role",
    label: "Role",
    options: SEIS_ROLE_OPTIONS,
    segmented: true,
    required: true,
    defaultValue: "viewer",
  };
  const empty = (options: Option[], reason: string) =>
    options.length === 0 || subprojects.length === 0 ? { disabled: true, reason } : {};
  const revokeFrom = granted.length > 0 ? granted : everyone;
  const items: CanvasActionItem[] = [
    {
      type: PREVIEW_SEIS_GRANT_ACTION,
      label: "Grant",
      defaultOpen: true,
      ...preview,
      binding,
      ...empty(everyone, "nobody has entitlements"),
      ...gate,
      fields: [personField("id", "Person", everyone), subprojectField, roleField],
    },
    {
      type: PREVIEW_SEIS_REVOKE_ACTION,
      label: "Revoke",
      ...preview,
      binding,
      ...empty(revokeFrom, "nobody has entitlements"),
      ...gate,
      fields: [personField("id", "Person", revokeFrom), subprojectField, roleField],
    },
    {
      type: PREVIEW_SEIS_COPY_ACTION,
      label: "Copy grants from person",
      ...preview,
      binding,
      ...(granted.length === 0 ? { disabled: true, reason: "nobody holds a seismic grant" } : {}),
      ...gate,
      fields: [
        granted.length > 0
          ? personField("from", "From", granted)
          : { name: "from", label: "From", placeholder: "nobody holds a seismic grant" },
        personField("to", "To", everyone),
      ],
    },
  ];
  return {
    view: "board",
    ...(signedOut ? { header: { status: { label: "sign-in needed", tone: "error" } } } : {}),
    sections: [{ kind: "actions", tabs: true, items }],
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function composeSeismicReach(rt: Runtime): CanvasBoardView {
  const profile = rt.profile;
  const access = measuredAccess(rt);
  const seismic = measuredSeismic(rt);
  if (!profile || !access || !seismic) return EMPTY_BOARD;
  const { model } = seismic;
  const people = access.model.people;
  const chosen = people.find((p) => p.id === seismicState(rt).reach);
  const form: Section = {
    kind: "actions",
    items: [
      {
        type: SEIS_REACH_ACTION,
        label: "Show reach",
        expanded: true,
        fields: [
          personField(
            "id",
            "Person",
            people.map((p) => ({ value: p.id, label: p.name })),
            chosen?.id,
          ),
        ],
        ...(people.length === 0 ? { disabled: true, reason: "nobody has entitlements" } : {}),
      },
    ],
  };
  if (!chosen) {
    return {
      view: "board",
      sections: [
        form,
        {
          kind: "rows",
          items: [{ glyph: "neutral", text: "Pick a person to list the paths they can open." }],
        },
      ],
    };
  }
  const reach = reachOf(model, chosen);
  const sections: Section[] = [form];
  const notes: Row[] = [];
  if (chosen.cause === "missing-users") {
    notes.push({
      glyph: "error",
      text: `${chosen.name} is not in users@, so every call returns 401 until that is fixed.`,
    });
  }
  if (model.partial) {
    notes.push({
      glyph: "warn",
      text: "Some ACL groups could not be read, so this list may be incomplete.",
    });
  }
  if (notes.length > 0) sections.push({ kind: "rows", items: notes });
  sections.push({
    kind: "rows",
    title: `Reachable paths · ${reach.length}`,
    items:
      reach.length > 0
        ? reach.map((r) => ({
            chip: { label: r.role, tone: r.role === "admin" ? "accent" : "neutral" },
            text: r.path,
            trailing: r.via === "default" ? `via ${r.group ?? "data.default"}` : "direct grant",
          }))
        : [{ glyph: "neutral", text: "No subproject is open to this person." }],
  });
  if (reach.length > 0) {
    sections.push({
      kind: "cards",
      items: [
        {
          title: `Send to ${chosen.name}`,
          prose: true,
          fields: [
            {
              label: "Access note",
              value: accessNote(reach, model.tenant, profile.host),
              copyable: true,
            },
          ],
          footnote: "Copy only. The rib does not send mail.",
        },
      ],
    });
  }
  return {
    view: "board",
    header: { chip: `${chosen.name} · ${plural(reach.length, "path", "paths")}` },
    sections,
  };
}
