// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { CONNECTION_KEY, DATA_PULSE_KEY, PULSE_KEY, SEIS_PULSE_KEY } from "./keys.ts";

const HEADER_KEYS = new Set<string>([PULSE_KEY, DATA_PULSE_KEY, SEIS_PULSE_KEY, CONNECTION_KEY]);

// Before a connection exists only the header and footer say so; every other
// region publishes no sections, which hides it.
export function composeResting(key: string): CanvasBoardView {
  if (!HEADER_KEYS.has(key)) return { view: "board", sections: [] };
  return {
    view: "board",
    header: { status: { label: "not connected", tone: "neutral" } },
    sections: [
      {
        kind: "rows",
        items: [
          {
            glyph: "neutral",
            text:
              key === PULSE_KEY || key === CONNECTION_KEY
                ? "Connect this rib to one ADME instance."
                : "Not connected. Finish the steps on the ADME Access tab.",
          },
        ],
      },
    ],
  };
}
