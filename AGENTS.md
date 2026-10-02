# AGENTS.md

Project guidance for coding agents working in this repository. It records what
stays true across changes: the contract, the commands, the patterns and the
invariants. Inventories (which keys, regions and actions exist) live in the code.

## What this is

`@keelson/rib-adme` is a rib for [Keelson](https://github.com/danielscholl/keelson)
that administers one Azure Data Manager for Energy (ADME) instance: who has
access, what data is in it, and who can reach each seismic subproject. The
design is in `design/README.md`; the screen-by-screen spec is `design/spec.md`.
When code and spec disagree, fix one of them; neither overrides the other.

## Commands

Bun. Everything is workspace-local.

```bash
bun install
bun test                 # composer and builder coverage
bun run typecheck        # tsc --noEmit
bun run check            # Biome lint + format (required before a PR)
bun run check:fix

keelson rib add "$PWD"   # install into the keelson home, then `keelson restart`
```

A PR needs `bun run check`, `bun run typecheck` and `bun test` green.

## Architecture

- One `Rib` object exported from `src/index.ts`, three surfaces (ADME Access,
  ADME Data, ADME Seismic) and three drawer inspectors, each region bound to a
  `rib:adme:*` key in `src/keys.ts`.
- Everything is an in-process composer. No workflows, no cadence: the rib
  drives refresh itself, and timers run only shortly after operator activity.
- The rib calls ADME and Microsoft Graph directly with tokens from the
  operator's Azure CLI sign-in (`az account get-access-token` through
  `ctx.getExec()`), fetched again before each batch.
- Composers are pure functions from measured state to a board. Side effects
  (exec, HTTP, disk) live in the client and store modules, never in a composer.

## Invariants

- **No secret is stored, logged or published.** Tokens live only for one batch
  in memory. The connection profile is non-secret.
- **Every change is a plan first.** Forms submit "Preview plan" and never
  mutate. Apply re-runs the dry run and aborts when anything changed.
- **An add never creates a removal.** A collision after an invitation halts
  the plan.
- **Mutating actions are bound.** Each carries host, partition and tenant in
  its binding, revalidated in the rib before anything is written.
- **Fail closed.** Every key registers a validator (`expectView`); an
  unmeasured value is `null` and draws as "?", never as 0.
- **Public repo, sample data only.** Committed fixtures, tests and docs use the
  scrubbed cast from `design/spec.md` (contoso-adme, Pilot, Vendor, alpha to
  golf). Real instance names, people and ids never enter the repo.
- **Attach only through the `Rib` contract** from `@keelson/shared`.

## Comments

Default to none. Add one only for a non-obvious why: a hidden constraint, a
workaround, an order dependency. One short line. No PR narration.

## Conventions

- Conventional commits; the PR title is the squash subject, checked by the PR
  Title workflow. release-please builds the version and CHANGELOG from those
  subjects, so `feat` and `fix` are for changes an operator would notice.
- PR body: What, Why now, and Notes for review only when needed
  (`.github/pull_request_template.md`).
- Contribution flow is in `CONTRIBUTING.md`; vulnerability reports follow
  `SECURITY.md`.
- No abstractions ahead of a concrete second caller.
