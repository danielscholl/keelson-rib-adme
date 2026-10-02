# Copilot code review: @keelson/rib-adme

A [Keelson](https://github.com/danielscholl/keelson) rib, Bun + TypeScript,
that administers one Azure Data Manager for Energy instance. It can change who
has access to that instance, so the review weight sits on the write path.
`AGENTS.md` has the architecture; `design/spec.md` the screens.

## How to review

Be terse and cite `file:line`. A few high-signal findings beat breadth. This is
single-operator local software: skip speculative scale, multi-tenant and
micro-optimization concerns. No poems, jokes or emoji.

## Comments

Do not ask for docstrings or comment coverage. Flag a comment only when it
narrates the PR or restates the code; a missing comment is not a finding.

## Invariants to flag when a change breaks them

- **No secret is stored, logged or published.** Tokens from
  `az account get-access-token` (`src/az.ts`, `src/client.ts`) live for one
  batch in memory. Flag a token reaching a log, the store, a board frame, a
  snapshot, an error message, or any URL other than the ADME or Graph call it
  was fetched for.
- **Every change is a plan first.** Forms submit a preview and never mutate.
  Apply (`src/plan/apply.ts`) re-runs the dry run and aborts on any
  difference. Flag a write to ADME or Graph outside an applied plan, or an
  Apply path that skips the re-check.
- **An add never creates a removal.** Flag plan-building code
  (`src/plan/`) that can emit a removal step from an add request, or that
  continues after a collision instead of halting.
- **Mutating actions are bound.** Each carries host, partition and tenant in
  its binding, revalidated against the live profile before any write. Flag a
  new mutating action without the binding or the check.
- **Composers are pure.** Board composers map measured state to a board. Flag
  exec, HTTP or disk access added to a composer; those live in the client and
  store modules.
- **Fail closed.** Every key validates through `expectView`; an unmeasured
  value is `null` and draws as "?", never as 0. Flag a default of 0, `[]` or
  "ok" standing in for a failed or missing read.
- **Encoding.** Names, ids and fields from ADME or Graph are untrusted. Flag
  one spliced into a request path or query without encoding, into an exec
  argument list unchecked, or into a filesystem path.
- **Sample data only.** The repo is public. Flag fixtures, tests, docs or
  screenshots that carry what looks like a real host, tenant id, GUID, email
  or person instead of the cast in `design/spec.md` (contoso-adme, Pilot,
  Vendor, alpha to golf).
- **Attach only through the `Rib` contract** from `@keelson/shared`. Flag
  reaching into harness internals.

## What not to flag

- Missing docstrings or comments.
- Tests in `test/` using `bun:test`, fakes in `test/harness.ts`, or fixture
  shapes copied from real API responses with scrubbed values.
- The absence of an abstraction; this repo waits for a second caller.
