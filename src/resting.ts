// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { composeFirstRun, phasePill, signinCard } from "./boards/connection.ts";
import type { ConnectionStatus } from "./connection.ts";

// A header region for a surface whose measured board is not built yet, or
// cannot be measured in the current phase.
export function composeRestingHeader(
  status: ConnectionStatus,
  opts: { firstRunHere?: boolean; connectedText: string },
): CanvasBoardView {
  if (status.phase === "firstrun" || status.phase === "profile-error") {
    if (opts.firstRunHere) return composeFirstRun(status);
    return {
      view: "board",
      header: { status: { label: "not connected", tone: "neutral" } },
      sections: [
        {
          kind: "rows",
          items: [
            { glyph: "neutral", text: "Not connected. Finish the steps on the ADME Access tab." },
          ],
        },
      ],
    };
  }
  if (status.phase === "signin") {
    return { view: "board", header: { status: phasePill(status) }, sections: [signinCard(status)] };
  }
  return {
    view: "board",
    header: { status: phasePill(status) },
    sections: [{ kind: "rows", items: [{ glyph: "ok", text: opts.connectedText }] }],
  };
}

// Publishing no sections hides a region.
export const EMPTY_BOARD: CanvasBoardView = { view: "board", sections: [] };
