// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { composeLegal } from "../boards/legal.ts";
import { LEGAL_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";

export const legalModule: RegionModule = {
  composers: { [LEGAL_KEY]: composeLegal },
};
