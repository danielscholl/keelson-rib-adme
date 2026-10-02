# Contributing to @keelson/rib-adme

The ADME rib is a [Keelson](https://github.com/danielscholl/keelson) rib: a
standalone package the harness discovers at runtime. `AGENTS.md` holds the
architecture and invariants; this file holds the checks and conventions every
pull request follows. Where it is silent, the
[keelson CONTRIBUTING guide](https://github.com/danielscholl/keelson/blob/main/CONTRIBUTING.md)
is the parent.

## Development environment

You need [Bun](https://bun.sh/) on PATH, and the Azure CLI signed in to a
tenant that holds an ADME instance if you want to exercise the rib live.

```bash
git clone https://github.com/danielscholl/keelson-rib-adme.git
cd keelson-rib-adme
bun install
```

`@keelson/shared` resolves from the keelson release tarball pinned in
`package.json`, so install, typecheck and tests need no keelson checkout. To
move to a newer harness, change that URL and the peer range together.

To run the rib inside your Keelson home:

```bash
keelson rib add "$PWD"   # copies the working tree; repeat after each change
keelson restart
```

Or link it into a keelson checkout and run its dev server:

```bash
bun run link:keelson     # defaults to ../keelson; override with KEELSON_DIR
cd ../keelson && KEELSON_RIBS=adme bun dev
```

## Required checks

CI runs the same commands, and a PR needs all three green:

```bash
bun run check       # Biome lint + format
bun run typecheck   # tsc --noEmit
bun test
```

`bun run check:fix` applies the safe fixes. CI also runs a canary against
keelson `main`; it is informational and does not block a merge.

## Sample data only

The repo is public. Fixtures, tests, screenshots, docs and issue text use the
scrubbed cast from `design/spec.md` (contoso-adme, Pilot, Vendor, alpha to
golf). Real instance hosts, partitions, tenant ids, people and object ids never
enter the repo, including in logs pasted into a PR or issue.

## Commits, PR titles and releases

PRs are squash-merged, and the PR title becomes the commit on `main`. It must
be a conventional commit (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`,
`chore:`, `test:`, `build:`, `ci:`); the PR Title check enforces it.

[release-please](https://github.com/googleapis/release-please) reads those
commits and keeps a release PR open with the version bump and CHANGELOG.
Merging that PR tags the release and publishes its notes. Use
`feat` for a change an operator can see, `fix` for a bug they would hit, and
`!` after the type for a change that breaks a saved profile or the data
directory. Everything else stays out of the CHANGELOG.

## Pull request hygiene

- One thing per PR. Split refactors out of feature work.
- The description says what changed and why now; add notes for review only
  where a reader would otherwise stop and ask.
- No abstractions ahead of a concrete second caller.
- Comments only for a non-obvious why, in one short line. What the PR changed
  belongs in the PR description, not the source.

## Security

Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes, not
as public issues.
