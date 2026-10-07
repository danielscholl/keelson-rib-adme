# keelson-rib-adme: design specification

This is the screen-by-screen specification for the first take of the rib. The mockup in [adme-access-desk.html](adme-access-desk.html) draws what is written here, and the screenshots in [screens/](screens/) are taken from it. Where this document and the mockup disagree, treat it as a bug in one of them and fix it; neither is meant to override the other.

Nothing is built yet and nothing was called live. Every name, count and id is sample data.

## Purpose and scope of the first take

The rib is an admin surface for one Azure Data Manager for Energy (ADME) instance inside Keelson. Access is the daily work on such an instance, so the layout is people first: the rib opens on an access desk that lists who needs attention and why, shows every person against roles and seismic grants by name, and routes every write through one previewed plan.

The first take has three tabs:

| Tab | Surface id | Badge | Covers |
|---|---|---|---|
| ADME Access | `access` | 5 | Managing people and applications. |
| ADME Data | `data` | 2 | Whether each service answers, legal tags, how much data is in the partition, record search. Read-only. |
| ADME Seismic | `seismic` | none | Seismic subprojects: who is in each by name, grant and revoke. |

How it runs:

- Everything is an in-process composer in the Keelson server. There are no workflows and no cadence.
- The rib works from the operator's Azure CLI sign-in and holds no secret. See [Sign-in and connection](#sign-in-and-connection).
- Every change is a dry-run plan first. Nothing is written until the plan is applied. See [The plan primitive](#the-plan-primitive).
- ADME Data creates, extends and deletes nothing in the first take.

Limits to keep in view:

- Shelling `az` through `ctx.getExec()` is unverified, and the whole design rests on it. Prove it with a spike before any board work.
- An identity collision (a new address that resolves to an existing guest) can be detected and halted, not prevented, once an invitation email has gone out.
- A rib publishes board snapshots; it does not author UI. Several layout choices below are workarounds for what boards cannot do yet. They are listed under [Host changes worth asking for](#host-changes-worth-asking-for).

## Sample data (cast)

All mockup data is sample data. The counts below are canonical: every screen must agree with them. People are fictional.

### Instance

| Item | Value |
|---|---|
| Host | `contoso-adme.energy.azure.com` |
| Partition | `opendes` |
| Entitlements domain | `opendes.dataservices.energy` |
| Entra tenant | Contoso, id shown as `1f2e…9a00` |
| ADME app id | `4c7d…2b18` |
| Roster group | `contoso-adme`, id `9d3a…5e42` |
| Signed in as | `ingrid.halvorsen@contoso.example` |
| "Now" | 2026-10-02 14:05 UTC |
| Last good sweep (used by the sign-in needed state) | 13:02Z |

Ids are always drawn truncated in that form.

### Identities

- Identities: 36 = 32 people + 4 applications.
- People by cohort (sums to 32): Pilot 29 (created 2026-09-28, pass ends 2026-10-28, 26 days left), Vendor 1 (created 2026-09-29, pass ends 2026-10-29, 27 days left), Permanent 2 (no pass).
- People by state (sums to 32): healthy 27, pending acceptance 3, broken 2.
- People by highest role (sums to 32): Editor 29, Admin 1, Ops 2. Viewers 0.
- Needs-you count, which is the ADME Access tab badge: 5 = 3 pending + 2 broken.
- Pilot composition: 24 healthy, 3 pending, 2 broken.
- Expected effective group counts: Editor 33, Admin 49, Ops 46. Seismic grants raise a person's expected count; the drawn values are in the table.
- People with at least one seismic grant: 9.

Named people. Use these with these facts, and refer to the rest as "… N more".

| Name | Email | Cohort | Role | State | Groups | Seismic |
|---|---|---|---|---|---|---|
| Ingrid Halvorsen | ingrid.halvorsen@contoso.example | Permanent | Ops | healthy (you) | 46 of 46 | all (tenant admin) |
| Tomas Reyes | tomas.reyes@contoso.example | Permanent | Ops | healthy | 46 of 46 | all (tenant admin) |
| Priya Nair | priya.nair@halden-geo.example | Pilot | Admin | healthy, accepted 2026-09-28 | 49 of 49 | alpha A, bravo A |
| Marcus Oyelaran | m.oyelaran@northfield.example | Pilot | Editor | healthy, accepted 2026-09-29 | 39 of 39 | alpha V, delta V |
| Lena Fischer | lena.fischer@rheinseis.example | Pilot | Editor | healthy, accepted 2026-09-28 | 33 of 33 | none |
| Hiro Tanaka | h.tanaka@kaiyo-data.example | Pilot | Editor | healthy, accepted 2026-09-29 | 35 of 35 | sleipner V |
| Sofia Marchetti | sofia.marchetti@adriatica.example | Pilot | Editor | healthy, accepted 2026-09-30 | 37 of 37 | echo A, foxtrot V |
| Ben Whitaker | ben.whitaker@northfield.example | Pilot | Editor | pending acceptance, invited 2026-09-28 (4 d ago) | 33 of 33 | none |
| Amara Diallo | amara.diallo@sahelgeo.example | Pilot | Editor | pending acceptance, invited 2026-09-28 (4 d ago) | 33 of 33 | none |
| Jonas Lindqvist | jonas.lindqvist@fjordline.example | Pilot | Editor | pending acceptance, invited 2026-09-30 (2 d ago) | 33 of 33 | none |
| Rachel Kim | rachel.kim@pacrim-energy.example | Pilot | Editor | broken: not in `users@`, every call returns 401 | 32 of 33 | none |
| Dmitri Volkov | d.volkov@baltica.example | Pilot | Editor | broken: duplicate member entry (email form and object id form are both in `users.datalake.editors`) | 34 of 33 | golf V |
| Elena Petrova | elena.petrova@vendor-partners.example | Vendor | Editor | healthy, accepted 2026-09-30 | 33 of 33 | charlie V |

Rachel Kim is the worked example for the person inspector, the "Why 401/403" explainer and the typed confirm. Her object id shows as `7c2e…41ab`, other mails `rkim@pacrim-energy.example`, Entra state Accepted 2026-09-29, created 2026-09-28.

The worked "Add people" plan adds two addresses to Pilot as Editor with no seismic: `kofi.mensah@volta-subsurface.example` (classified "will invite") and `r.kim@pacrim.example` (classified "existing guest": same home identity as Rachel Kim, so no invitation, blocked as a duplicate). The plan id is `4f2a`. It makes 4 changes and blocks 1 address.

### Applications

"Applications" is the UI word for service principals. Technical detail (keyed by appId, service principal) may appear in subtitles and reasons.

| Application | appId | Role | Note |
|---|---|---|---|
| `contoso-adme-root-app` | `4c7d…2b18` | root app, keyed by appId | flagged `legacy`: shared root app, being retired; 2.4M calls in 30 days come from it |
| `contoso-adme-tier-viewer` | `2d4c…9e13` | Viewer | |
| `contoso-adme-tier-editor` | `a07f…3b68` | Editor | |
| `contoso-adme-tier-admin` | `c5b2…70da` | Admin | |

### Seismic

Tenant `opendes`, 13 subprojects, service status ok. 2 are on the default ACL (`data.default.*`) and 11 have their own ACL. ACL groups look like `data.sdms.opendes.alpha.3f9a…e1.admin@opendes.dataservices.energy`. Dataset counts are not measured until a subproject is opened, and are drawn as "?".

| Subproject | ACL | Admins | Viewers | Legal tag |
|---|---|---|---|---|
| `alpha` | own | 3 | 4 | `opendes-public-usa-dataset` |
| `bravo` | own | 2 | 1 | `opendes-public-usa-dataset` |
| `charlie` | own | 1 | 2 | `opendes-public-usa-dataset` |
| `delta` | own | 1 | 3 | `opendes-public-norway` |
| `sleipner` | own | 1 | 2 | `opendes-public-norway` |
| `echo` | own | 2 | 1 | `opendes-public-usa-dataset` |
| `foxtrot` | own | 1 | 2 | `opendes-pilot-trial` |
| `golf` | own | 1 | 2 | `opendes-pilot-trial` |
| `golf2` | own | 1 | 0 | `opendes-pilot-trial` |
| `golf3` | own | 1 | 0 | `opendes-pilot-trial` |
| `volve` | default | all 32 editors, through `data.default.viewers` | | `opendes-public-norway` |
| `drogon` | default | all 32 editors, through `data.default.viewers` | | `opendes-public-norway` |
| `subproject-legacy` | own | 0 | 0 | `opendes-legacy-training` |

`subproject-legacy` is flagged "no members since creation; looks abandoned".

### Data

- Records 1,284,512, up 3,180 since yesterday, with a rising spark.
- Kinds 214.
- Legal tags 15 = 14 valid + 1 invalid. 1 valid tag expires within 30 days. The ADME Data tab badge is 2 = 1 invalid + 1 expiring.
- Schemas: not measured (the schema service is not probed).

Legal tags drawn:

| Tag | State | Detail |
|---|---|---|
| `opendes-legacy-training` | invalid | expired 2026-08-31; records affected not measured |
| `opendes-pilot-trial` | valid, expires 2026-10-24 (22 d) | countries US, classification Private; expires 4 days before the Pilot pass ends |
| `opendes-public-usa-dataset` | valid | expires 2099-12-31, Public Domain Data |
| `opendes-public-norway` | valid | expires 2099-12-31, Public Domain Data |
| … 11 more valid tags | valid | none expire within 30 days |

Top kinds (sums to 1,284,512):

| Kind | Records |
|---|---|
| `osdu:wks:work-product-component--WellLog:1.2.0` | 412,300 |
| `osdu:wks:master-data--Wellbore:1.1.0` | 198,450 |
| `osdu:wks:work-product-component--SeismicTraceData:1.3.0` | 96,210 |
| `osdu:wks:master-data--Well:1.2.0` | 88,104 |
| `osdu:wks:dataset--File.Generic:1.0.0` | 74,902 |
| `osdu:wks:reference-data--UnitOfMeasure:1.0.0` | 21,330 |
| 208 more kinds | 393,216 |

Services, from `GET /info` per service: 5 answered, 1 not permitted, 4 not probed.

| Service | Result |
|---|---|
| entitlements | ok, 0.28.2 |
| legal | ok, 0.28.0 |
| storage | ok, 0.28.1 |
| search | ok, 0.28.1 |
| seismic | ok (service status) |
| partition | 403, not permitted (service principal only) |
| schema, workflow, file, indexer | `?`, not probed |

## Tabs

The top bar reads: Chat, Workflows, a divider, ADME Access (badge 5), ADME Data (badge 2), ADME Seismic (no badge), Beads, Swarms. Only the three ADME tabs belong to this rib. The labels carry the rib name because the top bar has no overflow rule and other ribs sit beside them.

Conventions on every tab:

- A header region carries a status pill and a chip that reads "measured 14:05Z", because an in-process region gets no host "updated" label.
- The Connection region (`rib:adme:connection`) is the footer of all three tabs under one snapshot key.
- An unmeasured value is drawn as "?" and worded "not measured".
- Every form submits "Preview plan" and never mutates.

### ADME Access

Screens: [access.png](screens/access.png), [matrix.png](screens/matrix.png).

Heading "ADME access", subtitle "Who has access to the instance, and are they using it?" The tab is a viewer: it answers who has access, who is stuck, and how each organization is doing, and nothing on it changes access. Seismic grants are planned on ADME Seismic; everything else changes outside the rib for now.

Usage uses the access guide's four words. **Invited** has not accepted the invitation. **Not used** has made no data call in the audit log, which reaches back as far as the workspace retains it; the rib names that day ("no data call since 2026-09-20") rather than saying "never". **Active** made a data call in the last 7 days. **Idle** has made calls, but none in the last 7 days. Every word except Invited needs the audit log (see [Audit log](#audit-log)). Until the audit log is read, those values are drawn as unmeasured, never as 0.

**Header region `rib:adme:pulse`**, title "Access".

- Status "N to follow up" (caution), or "all in use" (ok). N counts people who cannot use their access, have not accepted, or made no call in the log, plus unknown principals. The tab badge counts the same N. Chip `contoso-adme · opendes · measured 14:05Z`. Live dot.
- Head segments, the adoption strip: Invited (info), Not used (warn), Idle (caution), Active (ok). Without the audit log the strip is Invited, Accepted, and a hatched "In use: not measured".
- One sentence: "32 people from 12 organizations. 3 used it this week; 3 not accepted yet and 25 accepted with no data call since 2026-09-20. 2 people cannot use it." Without the audit log it ends "Who uses it is not measured: set the audit log workspace in Connection."
- Head menu (⋯): Refresh now, Re-test connection.
- Stats, 5 tiles:
  1. People 32, sub "12 organizations · 2 Ops, 1 Admin, 29 Editor" (the cohort mix instead when cohorts are tracked), delta "+N this week" by grant date, spark of people with access over 14 days.
  2. Active this week, sub "made a data call in 7 days", spark of people calling per day over 14 days, delta against the week before. "?" without the audit log.
  3. Not accepted 3 (warn), sub "oldest invited 4 d ago".
  4. Accepted, not used (warn), sub "oldest granted N d ago". "?" without the audit log. Any age past a year reads in years, "6.8 y ago".
  5. Access gaps 2 (error), sub "1 missing users@ · 1 duplicate entry".
  6. Next pass ends, only when cohorts are tracked.

**Zone "Now"**, two columns.

Left: region `rib:adme:attention`, title "Follow up", byline "people who have access but cannot or do not use it yet". Status as the header, chip "oldest first". Rows only, and no row changes anything: clicking one opens the person inspector.

- "Cannot use it · 2": Rachel Kim, chip `401`, "Pacrim Energy · not in users@, every call returns 401"; Dmitri Volkov, chip `duplicate`, "Baltica · listed twice in users.datalake.editors".
- "Has not accepted the invitation · 3", oldest first: Ben Whitaker and Amara Diallo "invited 4 d ago", Jonas Lindqvist "invited 2 d ago". At most 12, then "… N more, all listed in People under Invited".
- "Accepted, no data call since 2026-09-20 · N", oldest grant first, at most 8. Without the audit log, one row says this is not measured and why.
- Deleted in Entra, Unknown principals and Roster drift, when found; then "Checks that found nothing".

Right: region `rib:adme:activity`, title "Activity", byline "data calls from the instance audit log", chip "last 14 days · measured 14:05Z".

- Chart (bars) "People who made a data call, per day", 14 days.
- Bars "Calls by organization, last 14 days", at most 10, each trailing "calls · N of M active".
- Without a workspace: one row naming OEPAuditLogs and the action "Find the audit log" (brand).

**Zone "Who has access"**, full width.

- `rib:adme:orgs`, title "Organizations", byline "one card per email domain · select one to filter People". A grid of cards, one per registrable email domain, most people first. Each card has the organization name (from the domain: halden-geo.example is "Halden Geo", xyz.example is "XYZ"), a pill for a gap or open invitations, a usage bar labelled "Usage" and captioned "N of M active", a People field naming everyone in their usage tone, and the domain as footnote. Clicking a card filters People to it in place; clicking it again clears the filter.

Then the region `rib:adme:people`, title "People", chip "32 of 32 · all", collapsed by default. Head menu: "Export who has access", which writes the access guide's "Who has access" table (Name, Email, Status, Granted, Last active) as Markdown to the data directory's `exports/`.

1. View chips: **Roster** (selected), Roles matrix, Seismic grants.
2. Filter chips: All (selected), Pilot 29, Vendor 1, Permanent 2, Applications 4, Invited 3, Gaps 2, and the selected organization when one is picked.
3. One view body at a time:
   - **Roster**: rows in sections. Each row has a tone dot (usage, or error for a gap), a role chip toned by role, the name, and a trailing string `email · usage`, for example "last call 2 d ago", "idle · last call 12 d ago", "not used · granted 9 d ago" or "invited 4 d ago". The group count appears only when it differs from the role ("32 of 33"). Rows open the person inspector. With the audit log read, sections are "Cannot use it", Active, Idle, Not used and Invited. Without it, sections are:
     - "Needs attention · 5": Rachel Kim (selected), Dmitri Volkov, Ben Whitaker, Amara Diallo, Jonas Lindqvist
     - "Permanent · 2": Ingrid Halvorsen (you), Tomas Reyes
     - "Pilot · 24 more": Priya Nair, Marcus Oyelaran, Lena Fischer, Hiro Tanaka, Sofia Marchetti, then a last row "… 19 more · all healthy · filter Pilot to list them"
     - "Vendor · 1": Elena Petrova
   - **Roles matrix**: one table per chunk, at most 15 rows each. Drawn: "Needs attention · 5" and "Pilot · 5 of 24", with the caption "Showing 10 of 32 · filter: all. M is member, O is owner." Columns: Person, Kind (guest or member), Entra (Accepted ok, Pending warn), Roster group, users@ (a check, or "✕ missing" in error tone for Rachel Kim), Viewers, Editors, Admins, Ops (badge M or O; an empty cell shows the table's null placeholder), Groups (for example 33/33; warn tone when off: Rachel Kim 32/33, Dmitri Volkov 34/33), Pass (2026-10-28). Dmitri Volkov's Editors cell carries M and a `duplicate` badge.
   - **Seismic grants**: one table, section "Subproject grants · 9 of 9 people" (at most 25 rows under the All filter). Rows: Marcus Oyelaran, Hiro Tanaka, Sofia Marchetti, Dmitri Volkov, Elena Petrova and one more Pilot member, then the tenant admins (anyone in `users.datalake.admins` or `users.datalake.ops`) marked "tenant admin": Priya Nair, Ingrid Halvorsen and Tomas Reyes. Columns: default (volve, drogon), alpha, bravo, charlie, delta, sleipner, echo, foxtrot, golf, golf2, golf3, at most 12 own-ACL columns. Cells are badge A (brand), V (info) or the null placeholder; every row shows its explicit ACL entries, tenant admins included. Caption: "9 of 32 people hold a subproject grant. Editors reach volve and drogon through data.default. A is admin, V is viewer." Two rows follow: "Tenant admins can list and manage every subproject; reading one still needs its ACL group" and "Not shown: subproject-legacy (no members)", which also names any people or subprojects left out by the caps.
   - Both table views end with a one-line "Open person" form (a select and an Open button), because table rows cannot be clicked.

**Not on the tab while it is a viewer.** Change access and Cohorts (with its Import cohorts form) still compose, but no surface shows them. Operation and Recent changes moved to ADME Seismic, the one tab that still plans a change. Their specs follow.

- `rib:adme:change`, title "Change access", byline "Nothing changes until you apply the plan." Tabbed actions: **Add people** (open), Grant seismic, Remove person, Add application, Why 401/403. The open "Add people" form has:
  - Emails, one per line (textarea, prefilled with the two worked-example addresses)
  - Cohort (select: Pilot, Vendor, Permanent; Pilot chosen)
  - Pass ends (text, `2026-10-28`)
  - Role (segmented: Viewer, Editor, Admin; Editor pressed)
  - Seismic subprojects (text, placeholder "alpha, bravo (optional)")
  - "Preview plan" (brand) and Cancel
- `rib:adme:operation`, title "Operation", byline "the plan being applied, one call at a time". Hidden when empty. Drawn in a running state: status "running 4 of 7", chip `plan 4f2a`, captioned bar "Add 2 people to Pilot · 4 of 7 calls", then rows "Steps · kofi.mensah@volta-subsurface.example":
  1. done: Re-run the dry run, nothing changed since 14:03Z
  2. done: POST graph /v1.0/invitations (email sent), 201
  3. done: Wait 10 s for directory replication
  4. running: POST graph /groups/9d3a…5e42/members/$ref, correlation id `keelson-adme-4f2a-4`
  5. queued: POST entitlements /groups/users@…/members
  6. queued: POST entitlements /groups/users.datalake.editors@…/members
  7. queued: GET entitlements /members/&lt;oid&gt;/groups, expect 33
- `rib:adme:recent`, title "Recent changes", byline "from the tracker, newest first", collapsible. Rows:
  - `dry run` "Add 2 people to Pilot", you · 14:03Z
  - `by agent` "Plan staged from chat: remove 1 person", 13:41Z
  - `applied` "Grant alpha viewer to Marcus Oyelaran", you · 11:20Z
  - `event` "Sofia Marchetti accepted the invitation", 2026-09-30
  - `paused` "Add 1 person to Vendor, sign-in lapsed at step 3", 2026-09-29
  - `applied` "Add 29 people to Pilot", you · 2026-09-28

  The `by agent` row shows how an agent-staged plan would be listed. The agent tools that stage one are later work.

Because an inspector replaces whatever the drawer showed, a running plan stays visible in the Operation region, and Recent changes lists every plan that is staged, paused or applied.

- `rib:adme:cohorts`, title "Cohorts", byline "32 people in 3 cohorts". A grid of 3 cards:
  - Pilot: pill "29 people", composition bar 2 broken, 3 pending, 24 healthy; pass ends "26 d"; created 2026-09-28; action "Export roster".
  - Vendor: pill "1 person", bar 1 healthy; pass ends "27 d"; created 2026-09-29; action "Export roster".
  - Permanent: pill "2 people", bar 2 healthy; role Ops; pass none; action "Export roster".

  No card offers cohort removal. That is later work.

**Applications**, full width, collapsed by default.

- `rib:adme:principals`, title "Applications", byline "4 apps with entitlements in opendes", status "1 legacy" (caution). Stacked cards with mono titles for the 4 applications, each with a copyable appId and a role. The root app card has a caution edge, pill `legacy` and the reason from the cast table.

**Footer**: Connection, collapsed.

### ADME Data

Screen: [data.png](screens/data.png).

Heading "Data and governance", subtitle "Which services answer, which legal tags hold, how much data is in opendes, and a record search. Read only."

This tab is read-only in the first take. There is no "Extend expiry" and no create or delete of legal tags.

**Header region `rib:adme:data-pulse`**, title "Data". Status "1 tag invalid · 1 expiring" (caution). Chip `opendes · measured 14:05Z`. Stats, 5 tiles:

1. Records 1,284,512, delta up 3,180, sub "since yesterday", spark.
2. Kinds 214, sub "from search aggregateBy kind".
3. Legal tags valid 14, sub "of 15 tags".
4. Invalid or expiring 2 (caution), sub "1 invalid, 1 within 30 days".
5. Schemas "?", sub "schema service not probed".

**Zone "Records"**, one full-width region `rib:adme:records`, title "Records", chip "kind: osdu:wks:master-data--Well:* · 88,104 hits". A columns section with weights 1:2.

- Left column:
  - "Find records", tabbed actions: **By kind** (open), By id, Lucene, By ACL group, By legal tag. The open form has Kind (text, `osdu:wks:master-data--Well:*`), Query (text, placeholder `data.FacilityName:"NO 15/9*" (Lucene, optional)`), "Search" (brand) and Cancel.
  - Bars "Top kinds · share of 1,284,512 records": the 6 kinds and "208 more kinds" from the cast, mono labels, trailing counts. The `Well` bar is accented because it matches the active query.
- Right column:
  - Section title "88,104 records · kind osdu:wks:master-data--Well:* · page 1 of 3,525". The active query sits in the region chip and this title because an always-open form does not show the query just run.
  - 8 selectable rows. Each: chip `compliant` (ok), the record id in mono (`opendes:master-data--Well:8690` and so on), trailing `NO 15/9-F-1 · modified 2026-09-30 · v3`.
  - Caption "Showing 8 of 25 on this page · 25 per page, paged by the server".
  - Actions: "Prev" (disabled, reason "first page"), "Next 25", "Clear".

**Zone "Governance"**, two columns.

- `rib:adme:legal`, title "Legal tags", status "2 need a look" (caution), chip "15 tags". Segments "14 valid · 1 invalid". Cards in two sections, none with an action:
  - "Needs a look · 2":
    - `opendes-legacy-training`, error edge, pill `invalid`. Fields: expired 2026-08-31, records affected "not measured", name (copyable). Why invalid: "the contract expiry date has passed. Records that carry only this tag are dropped from search and cannot be read until the tag is valid again."
    - `opendes-pilot-trial`, warn edge, pill `expires`. Fields: expires in "22 d", on 2026-10-24, countries US, classification Private. Note: "Expires 4 days before the Pilot pass ends on 2026-10-28."
  - "Valid, no expiry within 30 days · 13": `opendes-public-usa-dataset` and `opendes-public-norway` (pill `valid`, expires 2099-12-31, Public Domain Data), then "… 11 more valid tags · none expire within 30 days".
- `rib:adme:services`, title "Services", byline "GET /info per service", chip "5 answered · 1 not permitted · 4 not probed", collapsible.
  - Grid "Probe result, by service": entitlements, legal, storage, search and seismic `ok`; partition `403` (caution); schema, workflow, file and indexer `?` (neutral).
  - Rows "Versions from GET /info, and the sweep": entitlements 0.28.2, legal 0.28.0, storage 0.28.1, search 0.28.1, partition "403, not permitted (service principal only)", "API calls, last sweep" 12, and "Audit log · OEPAuditLogs · 2.4M calls in 30 days (from the tracker, not measured here)".

**Footer**: Connection, collapsed.

### ADME Seismic

Screen: [seismic.png](screens/seismic.png).

Heading "Seismic store", subtitle "Subprojects in tenant opendes, and who is in each, by name."

**Header region `rib:adme:seis-pulse`**, title "Seismic store", byline "tenant opendes". Status "13 subprojects · service ok" (ok). Chip `sd://opendes · measured 14:05Z`. Stats, 4 tiles:

1. Subprojects 13, sub "11 own ACL, 2 default".
2. People with grants 9, sub "of 32 people".
3. On default ACL 2, sub "volve, drogon".
4. No members 1 (caution), sub "subproject-legacy".

**Row, full width: `rib:adme:seis-subprojects`**, title "Subprojects", byline "select one to see its members · datasets are not measured until one is opened", status "13 of 13", chip "selected: alpha". A card grid 4 across with 13 cards, in this order: alpha, bravo, charlie, delta, sleipner, echo, foxtrot, golf, golf2, golf3, volve, drogon, subproject-legacy.

- Own-ACL cards: mono title, pill `own ACL`, an admins line and a viewers line (count, then people dots and names), Legal tag, Datasets "?". Applications appear among viewers by name (`tier-viewer`).
- `volve` and `drogon`: pill `default ACL` (info), Members "all 32 editors", ACL `data.default.viewers`.
- `subproject-legacy`: caution edge, pill `empty`, 0 admins, 0 viewers, and "Why flagged: no members since creation; looks abandoned."
- Clicking a card selects the subproject and recomposes the sibling region below; it does not open the drawer. `alpha` is selected.

**Row, two columns.**

Left: `rib:adme:seis-selected`, title "alpha", byline "selected subproject", status "3 admins · 4 viewers", chip `sd://opendes/alpha`. A columns section with weights 1:1.

- "Identifiers" card with copyable fields: sd path `sd://opendes/alpha`, admin group `data.sdms.opendes.alpha.3f9a…e1.admin@opendes.dataservices.energy`, viewer group `data.sdms.opendes.alpha.3f9a…e1.viewer@opendes.dataservices.energy`, legal tag `opendes-public-usa-dataset`, access policy `uniform`.
- Rows "Admins · 3": Priya Nair, Ingrid Halvorsen (you), Tomas Reyes. Rows "Viewers · 4": Marcus Oyelaran, then the applications `contoso-adme-tier-viewer`, `contoso-adme-tier-editor`, `contoso-adme-tier-admin`. Person rows are selectable and trail the person's mail domain; application rows trail "application".
- Actions: "Grant access…" and "Add myself as admin" (disabled, reason "you are already an admin").

Right: a stack of two regions.

- `rib:adme:seis-change`, title "Grant or revoke", byline "one plan, previewed before anything changes". Tabbed actions: **Grant** (open), Revoke, Copy grants from person. The Grant form has Person (select, Lena Fischer chosen), Subproject (select, alpha chosen), Role (segmented: Viewer pressed, Admin), "Preview plan" (brand) and Cancel.
- `rib:adme:seis-reach`, title "What a partner can reach", byline "listing subprojects is admin only, so partners need the paths", chip "Marcus Oyelaran · 4 paths".
  - A one-line form: Person (select, Marcus Oyelaran) and "Show reach".
  - Rows "Reachable paths · 4", each with chip `viewer`: `sd://opendes/volve` and `sd://opendes/drogon` (via data.default), `sd://opendes/alpha` and `sd://opendes/delta` (direct grant).
  - Card "Send to Marcus Oyelaran" with a copyable "Access note": "You can read four seismic subprojects in tenant opendes on contoso-adme.energy.azure.com: sd://opendes/volve, sd://opendes/drogon, sd://opendes/alpha and sd://opendes/delta. Your role in each is viewer. Listing subprojects is admin only, so open them by path."

**Row, two columns**, both hidden when empty: Operation and Recent changes (collapsed), as specified under ADME Access.

**Footer**: Connection, collapsed.

## Drawer inspectors

The canvas drawer holds one document and has no back stack. Each inspector has its own snapshot key and replaces whatever the drawer showed. Every click is a rib action: the rib stores the selection, recomposes the one drawer key that changed and opens the canvas.

### Person inspector `rib:adme:person`

Screen: [person.png](screens/person.png). Title "Person · Rachel Kim".

Header: status "401 on every call" (error), chip `rachel.kim@pacrim-energy.example`. A columns section with weights 1:2.

Left:

- Card "Identity" (error edge, pill `401`) with fields: Object id `7c2e…41ab`, Mail, Other mails `rkim@pacrim-energy.example` (these three copyable), Kind guest, Entra state "Accepted 2026-09-29", Created 2026-09-28, Roster group "in contoso-adme", and Cohort Pilot and Pass ends "26 d" only while a cohort is tracked.
- Card "Use": Status (Active, Idle, Not used or Invited, in its tone; "?" without the audit log), Organization, Access granted, Last data call ("none since 2026-09-20" when the log holds none), Calls in the last 14 days, and "Role allows", a plain sentence of what the role can do.
- Rows "Same home identity": chip `otherMails`, "r.kim@pacrim.example resolves to this account".
- Actions: "Why 401/403". The inspector reads only; it plans no change.

Right:

- Chart (bars) "Data calls per day", 14 days, when the person made a call in those days.
- "Access checks", rows in order:
  1. `pass` Entra account exists and is enabled
  2. `pass` Invitation accepted
  3. `pass` In roster group contoso-adme
  4. `fail` Member of users@opendes.dataservices.energy, trailing "not a member"
  5. `pass` Member of users.datalake.editors, trailing "MEMBER, by object id"
  6. `warn` Effective groups, trailing "32 of 33 expected for Editor"
- "Seismic": chip `viewer`, "volve, drogon via data.default", trailing "blocked until users@ is fixed".
- "Beyond or short of the role": one full-width row per group that is missing (chip `gap`, error) or held beyond the role (chip `extra`, info), so a long seismic group name is never cut short. For Rachel Kim: `users`, "expected for the role, not held".
- "Effective groups · 32": a grid of short group names. 13 member cells (editors, storage, stor.vw, search, legal, legal.usr, schema, schm.vw, file, wrkflow, entitle, data.vw, data.ow) and a last cell "19 more", which makes 32. Groups accepted as baseline lead the grid with badge `baseline`.
- "History", rows in order:
  - "Invited by you", 2026-09-28
  - "Added to users.datalake.editors", 2026-09-28
  - "Add to users@ failed: 401 (sign-in lapsed mid-batch)", 2026-09-28, with a detail disclosure that shows the request, the correlation id `keelson-adme-9c1d-31`, the raw HTTP 401 body as the service returned it, and "Batch paused at step 31 of 58. Resumed after az login; this call was not retried."
  - "Accepted the invitation", 2026-09-29

### Plan sheet `rib:adme:plan`

Screen: [plan.png](screens/plan.png). Title "Plan · add 2 people to Pilot".

Header: status "dry run · nothing changed" (neutral), chip `plan 4f2a · expires in 28 min`.

Sections, in order:

1. Journey "What apply does, in order": Resolve identity, Invite or reuse, Roster group, Entitlements, Verify.
2. Stats "Dry run result, 14:03Z", 4 tiles: Will change 4 (sub "all for kofi.mensah"); Already true 0 (sub "a 409 on apply counts here"); Blocked 1 (warn, sub "duplicate identity"); People 2 (sub "Editor · Pilot · no seismic").
3. Rows "Protected or excluded · 1": chip `blocked` (warn), `r.kim@pacrim.example`, "Same home identity as Rachel Kim (7c2e…41ab). No invite, no second account. Use her existing entry."
4. Cards "Steps per person · 2":
   - `kofi.mensah@volta-subsurface.example`, pill `will invite` (info), six step lines:
     1. POST graph /v1.0/invitations (sends an email)
     2. wait 10 s for directory replication
     3. POST graph /groups/9d3a…5e42/members/$ref
     4. POST entitlements /groups/users@…/members {email: &lt;oid&gt;, role: MEMBER}
     5. POST entitlements /groups/users.datalake.editors@…/members
     6. GET entitlements /members/&lt;oid&gt;/groups, expect 33

     Footnote "first-seen domain volta-subsurface.example".
   - `r.kim@pacrim.example`, pill `existing guest` (warn), warn edge, reason "collision: an invite to this address would return Rachel Kim's object id. The plan stops here by design and never removes an account."
5. Card "Dry run" with two copyable fields: Dry run CSV `plan-4f2a-dry-run.csv · 6 step lines, 1 blocked line` and Correlation id `keelson-adme-4f2a-<n>`.
6. Hint "Apply re-runs the dry run first and stops if anything changed since 14:03Z."
7. Actions: "Apply 4 changes" (brand, simple confirm), "Recheck", "Discard plan".

How the numbers relate: the 4 changes are steps 1, 3, 4 and 5 (one invitation and three membership writes). The wait and the verify read are step lines, not changes. The Operation region counts 7 calls because it adds the re-run of the dry run in front of the six step lines.

### Explainer `rib:adme:explain`

Screen: [explain.png](screens/explain.png). Title "Why 401/403 · Rachel Kim".

Header: the verdict as status, "401: not a member of users@" (error); chip "checked 14:05Z · 7 checks".

Sections, in order:

1. Segments under her email: 3 passed, 1 failed, 3 skipped.
2. Rows "Checks, in the order the platform applies them":
   1. `pass` Signed in to tenant Contoso as ingrid.halvorsen@contoso.example, trailing "tenant 1f2e…9a00"
   2. `pass` Request reaches the ADME app (4c7d…2b18), trailing "app id matches"
   3. `pass` data-partition-id is opendes, trailing "header present"
   4. `fail` Member of users@opendes.dataservices.energy, trailing "this is the cause", with a detail disclosure: the effective groups read returned 32 groups where 33 are expected for Editor, the missing group is `users@opendes.dataservices.energy`, and entitlements rejects any caller outside `users@` with 401 before roles are read
   5. `skipped` Role group grants the service role, "not reached"
   6. `skipped` Record ACL intersects effective groups, "not reached"
   7. `skipped` Seismic subproject ACL, "not reached"
3. Card "Fix": "Add Rachel Kim to users@", pill "1 change", two step lines (the POST to `users@` and the verify read expecting 33), the reason, and the action "Open person". The fix is described, not planned.
4. Card "Send to this person": a plain-text note for Rachel Kim with a copy button, and the line "Copy only. The rib does not send mail."
5. Rows "Recent answers · 2": `403` "Marcus Oyelaran on sd://opendes/bravo: not in the bravo subproject ACL", 11:18Z; `401` "Ben Whitaker: invitation not accepted, cannot sign in yet", 2026-09-30. These rows stand in for a back stack.

No check mentions tokens or minutes.

## Confirm dialogs

Two dialogs are drawn.

- **Simple confirm**, on Apply. Title "Apply 4 changes?". Body "1 invitation email is sent. 3 membership writes. The dry run is re-checked first." Buttons Cancel and "Apply 4 changes". On apply, a toast reads "Plan 4f2a started: 4 changes queued" and the Operation region appears.
- **Typed confirm**, on removing one person. Title "Remove Rachel Kim". Body "Removes Rachel Kim from users.datalake.editors and from the roster group contoso-adme (2 membership deletes). Her Entra guest account is kept, so she can be added again." The operator types `Rachel Kim` to enable "Remove person"; the dialog is drawn half typed with the button disabled.

Removals need a typed subject; adds get the simple confirm. Removing a whole cohort is not in the first take.

One open point: the host fires a confirm only on an action marked destructive, so a confirm on a routine Apply needs the host change listed at the end. Until then, decide once whether to wait for it or to treat the plan sheet as the review and let adds apply without a dialog.

## States

Three states are drawn. In the mockup they are selected by the buttons above the prototype window and keyed in the markup by `data-when` with the ids `connected`, `expired` and `firstrun`. The id `expired` is the sign-in needed state. The running Operation region is keyed separately by `data-op-when="running"`.

### Connected

The default. Everything above describes this state. The Connection footer is collapsed and shows only the status pill "connected" (ok) and the chip `contoso-adme · opendes`.

A "measured 14:05Z" chip names the time of the reading. A reading from an earlier day also names the day, "measured 2026-09-27 22:13Z". This matters for seismic, which is read on first use rather than on every sweep, so a reading cached before a restart never passes as today's.

### Sign-in needed

Screen: [expired.png](screens/expired.png).

There is one sign-in state and it is worded "sign-in needed" everywhere.

- Every header status reads "sign-in needed" (error), and the Change access region carries the same pill.
- The page keeps showing the last sweep. Chips read "cached from 13:02Z" in place of "measured 14:05Z". Stats stay at their cached values, and the fifth Access tile stays Applications 4.
- The Access header gains a section "Sign in again" with one card: `az login`, pill `needed`, a copyable command `az login --tenant 1f2e…9a00`, and the line "Run this in a terminal, then Re-test. Until then this page shows the last sweep and changes are paused."
- Every control that would change something or needs a live read is disabled with the reason "sign-in needed: run az login, then Re-test". That covers Plan the fix, Plan the cleanup, Resend invitation, Add people, Preview plan, Apply, Grant access, Grant, Revoke, Copy grants from person, Verify all, and on ADME Data the By kind tab, Search and Next 25. "Why 401/403" stays enabled.
- The Connection footer is open and holds: the same "Sign in again" card; actions "Re-test connection" (brand) and "Verify all" (disabled); and rows "Instance profile (no secrets)": Host, Partition, Entitlements domain, Tenant "Contoso · 1f2e…9a00", ADME app id, Roster group "contoso-adme · 9d3a…5e42", and "Changes: paused until Re-test passes". An entitlements domain that has not been read yet shows "?", and a roster group that is not set shows "not set". While it is not set and exactly one Entra group carries the instance's name, a "Roster group" card offers that group with "Use this group".
- A running plan pauses at its step and resumes after sign-in. History and Recent changes describe a past pause as "sign-in lapsed at step 3" or "sign-in lapsed mid-batch".

### First run

Screen: [firstrun.png](screens/firstrun.png).

The ADME Access tab shows only the header region, composed as the connect flow. All other regions are hidden. Status "not connected", byline "connect this rib to one ADME instance".

- Journey "Connect":
  1. Sign in with Azure CLI. "Run az login in a terminal. The rib uses that sign-in and stores no secret."
  2. Pick the instance. "Found through your Azure sign-in. Its values, none secret, are saved as the instance profile and stamped on every change."
  3. Test connection. "About 8 read-only calls. The result records what this sign-in can and cannot do."
- "Step 1: sign in": a card "Azure CLI" with pill `signed in` and the copyable `az login --tenant 1f2e…9a00`.
- "Step 2: pick the instance": one card per ADME instance the sign-in can see in Azure, with Host, Region and Partition, and "Connect" (brand). An instance with several partitions shows one "Connect to <partition>" each. While the lookup runs the step reads "Looking for ADME instances in Azure…"; a failed lookup shows the reason.
- Under the list: "Look again", and "Enter it by hand", a form with Host, Partition, Entitlements domain (optional), Tenant id, ADME app id and Roster group id (optional), then "Test connection" (brand). The form opens by itself when the lookup fails or finds nothing.
- "Step 3: what this sign-in can do": the capability matrix the test writes.

  | Capability | Result | Source |
  |---|---|---|
  | List my own groups | yes | entitlements /groups |
  | List every group | ? | /groups/all, not probed |
  | Invite guests | yes | Graph /invitations |
  | Read deleted users | yes | Graph /directory/deletedItems |
  | List seismic subprojects | yes | seismic /subproject/tenant/opendes |
  | Partition API | 403 | service principals only |
  | Count records by kind | ? | search aggregateBy kind, not probed |

A missing capability disables the feature that needs it, with a reason.

On ADME Data and ADME Seismic the header status reads "not connected, finish the steps on the ADME Access tab", every stat tile reads "?" with "not measured", and the other regions are hidden.

## The plan primitive

There is one mutation path. Every form submits "Preview plan" and never mutates.

- **A plan** is rib-held state with an id and a hash. It expires after 30 minutes.
- **Classification comes first.** The plan sheet classifies each address as existing guest, restorable from deleted items, will invite, or ambiguous, before any invitation is sent. The role control is Viewer, Editor or Admin, and a plan always adds `users@` as well as the role group, since without it every call returns 401.
- **Apply**:
  1. Re-runs the dry run and aborts if anything changed. Nothing is written on a stale plan.
  2. Saves a pre-image.
  3. Runs as a registered op with serial writes. Each call carries the correlation id `keelson-adme-<planId>-<n>`, which joins to the service audit log.
  4. Treats a 409 as already true.
  5. Pauses on a 401 and resumes after `az login` and Re-test. Completed steps are kept.
  6. Retries a 5xx twice, then pauses.
- **Verify** compares the effective group count with the expected count (33 for Editor).
- **Collision halt.** After an invitation, the returned object id and createdDateTime are compared with known accounts. A match halts the plan. An add never generates a removal.
- **Removals** need a typed subject. A person removal deletes the entitlement memberships and the roster group membership and keeps the Entra guest.
- **Tracker.** Every applied plan appends to the tracker, with JSON and CSV export, so an access guide can be regenerated from it.
- Every mutating action stamps host, partition and tenant in its binding and is revalidated in the rib.

Limits:

- The collision is detected after the invitation email has gone out. Classifying by `mail` and `otherMails` first catches the cases Graph can see; a new address on the same home identity is visible only when the object id comes back.
- Expected group counts change with platform releases. Derive the count from a peer with the same grants rather than a constant, and allow a per-person baseline so a known one-off stops counting as an access gap.
- The tracker is a second source of truth: cohort, pass end date and history live only in the rib's data dir.
- Identity resolution for a cohort can take tens of seconds and the action timeout is unknown. "Preview plan" should return at once and recompose.

## Sign-in and connection

The rib uses the operator's Azure CLI sign-in. It runs in-process in the Keelson server and stores no credential. The connection profile is up to six non-secret values: host, partition, entitlements domain, tenant id, ADME app id and, optionally, roster group id.

The operator does not type them. On first run the rib asks Azure Resource Graph, through `az rest`, for every `Microsoft.OpenEnergyPlatform/energyServices` resource the sign-in can read. That covers all subscriptions, not only the selected one, and needs no `az` extension. The chosen instance supplies host, tenant id, ADME app id and partition. Test connection reads the entitlements domain from the operator's own groups. The roster group is optional: when exactly one Entra group carries the instance's name, the Connection footer offers it and the operator confirms. An operator who has data access but no Azure role on the instance sees an empty list and enters the values by hand.

Before each batch of calls the rib asks `az` for a token again through `ctx.getExec()`:

```
# Token for ADME: the resource is the ADME app id, not the instance URL
az account get-access-token --resource <ADME app id>

# Token for Graph
az account get-access-token --resource https://graph.microsoft.com
```

Every ADME request sends `Authorization: Bearer` and `data-partition-id: opendes`. The rib calls ADME services (entitlements, legal, storage, search, seismic) and Entra Graph (users, invitations, deleted items, the roster group) directly. ADME does not read the roster group; it is kept for tracking only.

Because the token is fetched again before each batch, token lifetime is never the operator's concern, and the UI shows nothing about tokens: no token tile, no countdown, no token wording in any check. While the connection works the footer says "connected" and names the instance and partition. The only other state the operator sees is "sign-in needed", described under [States](#states).

Limits:

- Shelling `az` through `ctx.getExec()` is unverified. Resolve it with a spike before any board work: one composer that signs in through `az` for both resources and makes one read against ADME and one against Graph.
- Seismic reads may not behave as assumed. The subproject list returning ACL group names, reading other subprojects' members as tenant admin, and `GET /groups/all` are untested. Test connection probes each and writes the capability matrix; the fallback parses `data.sdms.*` from the operator's own groups and may be incomplete.
- Aggregate by kind, the schema service and the partition API are not exercised. The partition API returns 403 to a user sign-in. Until each is probed the tiles read "?".
- One Connection key on three surfaces is assumed to work. If it does not, three keys share one composer.
- Names, emails and object ids are plain text in snapshot frames and the data dir. Selection is rib-held and global, so two browser windows share one drawer target and one view. Both are acceptable for a single operator on a local workbench and should be stated in the rib's docs.

### Audit log

Active, Idle and Not used come from the instance's audit log: the `OEPAuditLogs` table in the Log Analytics workspace the instance's diagnostic setting sends to. The profile gains a seventh, optional, non-secret value, the workspace id (its customer id GUID).

- **Finding it.** "Find the audit log" (on the Activity region and in the Connection footer) asks Resource Graph for the instance by host, reads its diagnostic settings, and reads the workspace's customer id, all through `az rest`. It can also be entered by hand in the profile form.
- **Reading it.** One tier-1 read per sweep, with a token for `https://api.loganalytics.io`:

  ```
  OEPAuditLogs
  | where TimeGenerated > ago(90d)
  | where DataPartitionId =~ "opendes"
  | where isnotempty(Puid)
  | summarize calls = count() by id = tolower(Puid), day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd')
  ```

  `Puid` is read as the caller's object id, the id entitlements lists people by.
- **Fail closed.** The rib's own sweep calls as the operator, so a log with no call from the operator is not trusted, and usage stays unmeasured with that reason. A workspace the sign-in cannot read fails this read only; the rest of the rib stays connected.
- **Limits.** The window is 90 days, so someone whose last call is older reads as Not used. Whether `Puid` holds the object id for every caller is unverified against a live workspace; the trust check above catches the case where it does not.

## Performance plan

Calls are tiered so that opening a tab never triggers the expensive reads.

| Tier | When | Calls | What is read |
|---|---|---|---|
| 0 | Every paint | 0 | The disk cache of the last sweep, with a "cached from HH:MMZ" chip |
| 1 | On open, and on Refresh now | about 12 | `users@` members, 4 role group member lists, roster group members (Graph), legal tags valid and invalid, search total and aggregate by kind, seismic status and subproject list |
| 2 | When a People table view or the ADME Seismic tab is opened | 22 to 26 | Member lists of the 22 `data.sdms` groups, inverted into the matrix; Graph `$batch` for names and acceptance state, 20 per batch |
| 3 | On demand only | 1 per person | Effective groups when an inspector opens or after a mutation; "Verify all" runs as a registered op |

The tier 1 figure counts the 12 service reads. Token fetches are not counted as calls.

- Timers run only for 15 minutes after the last operator action, and never while signed out.
- Record lists page server-side, 25 per frame.
- Names are cached in the data dir.
- The matrix is built by inverting group member lists, not by one effective-groups read per person.

## Build slices, later, not planned yet

The first take is built in three slices, in this order. Each slice is usable without the next.

| Slice | Scope | What it proves |
|---|---|---|
| 1. Connection and ADME Data, read-only | Services reachable and their versions, record counts by kind, legal tags with expiry, record search. | The `az` sign-in path, with nothing that can change the instance. |
| 2. ADME Access | People and applications, Follow up, the three people views, the person inspector, the plan engine for add, remove and fix, Why 401/403, tracker export. | The plan engine on real writes: dry run, Apply, verify, tracker. |
| 3. ADME Seismic | Subprojects with members by name, grant and revoke through the same plan engine, what a partner can reach. | The same plan engine on the UUID-named seismic groups. |

Later:

- Legal tag create and extend.
- Cohort removal with pre-image and undo.
- Agent tools (`adme_plan_*`) and an ask policy on `adme_plan_apply`, so agents stage a plan and a person applies it.
- The roster document.
- A record inspector with versions and an ACL explanation.

Not planned yet:

- Schemas.
- Workflows.
- A group nesting graph and a general entitlement-group browser.
- The audit log feed.
- Multiple instances.
- Reindex.
- Creating or deleting subprojects.
- Dataset browsing.

## Host changes worth asking for

None is assumed by the first take. Each removes a workaround used above.

| Host change | What it would replace |
|---|---|
| A masked or typeahead form field | Person and subproject selects, which stop working at a few hundred entries |
| A confirm that is not destructive | Marking a routine add as destructive to get a dialog |
| Sticky table header and clickable table rows | 15-row chunks and the "Open person" form under each table |
| Region max-height with scroll | A long ADME Access tab when the People region is on a table view |
| A drawer back stack | "Recent answers" rows and the inline Operation region |
| Open-surface from drawer boards | Closing the inspector to jump to the ADME Seismic tab |
| Top bar overflow | The three-tab ceiling |
| A nav group, so one rib's surfaces nest under one tab | Repeating "ADME" in every tab label |
