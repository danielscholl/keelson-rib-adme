// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type ToolDefinition, z } from "@keelson/shared";
import { briefOf } from "./brief/inputs.ts";
import type { Runtime } from "./runtime.ts";

const MAX_CHARS = 16_000;

function payload(data: unknown): string {
  const compact = JSON.stringify(data);
  if (compact.length <= MAX_CHARS) return compact;
  return JSON.stringify({
    truncated: true,
    note: `result exceeded ${MAX_CHARS} characters`,
    head: compact.slice(0, MAX_CHARS - 200),
  });
}

// Read-only: the same words the console shows, so an agent and the tab never disagree.
export function admeTools(runtime: () => Runtime | undefined): ToolDefinition[] {
  return [
    {
      name: "adme_brief",
      description:
        "The ADME briefing in sentences, the same words the tab's console shows: a headline, a summary, the decisions ranked by class (BLOCKED: a role holder who cannot call; INCONSISTENT: listed twice or users@ with no role; IDENTITY: an id holding access that nothing names, or a labelled historical actor that still holds a role; GRANT: a seismic grant without instance access; LEGAL: a tag in use that is invalid or expires within 30 days; READ: a read that failed, is incomplete or is past its limit), each with its facts by source and next step, then onboarding (pending invitations, never a decision), adoption from the audit log, and every read's age and completeness. Start here when asked what needs attention on the ADME instance.",
      inputSchema: z.object({}),
      async execute(_input, ctx) {
        const rt = runtime();
        const content = rt
          ? payload(briefOf(rt))
          : JSON.stringify({ error: "adme is not bound yet" });
        ctx.emit({ type: "tool_result", toolUseId: "", content, ...(rt ? {} : { isError: true }) });
      },
    },
  ];
}
