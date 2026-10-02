# Security Policy

## Supported versions

The ADME rib is pre-1.0. Security fixes land on the latest `0.x` release only.

| Version              | Supported          |
|----------------------|--------------------|
| Latest `0.x` release | :white_check_mark: |
| Any older release    | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.** Report
privately through either channel:

- GitHub private vulnerability report:
  <https://github.com/danielscholl/keelson-rib-adme/security/advisories/new>
- Email **degnome@gmail.com** with the subject line `[rib-adme security]`

Include what you observed and its impact, the rib version, `keelson version`,
`az version`, your OS, and the smallest reproduction you have. Leave out real
instance names, people and ids; describe them by role.

New reports are acknowledged within **3 business days**, with a fix or
mitigation plan within **14 days** of acknowledgement, sooner when there is a
public proof of concept.

## Threat model

The rib runs inside the Keelson server with the operator's privileges. It
borrows the operator's Azure CLI sign-in to call ADME and Microsoft Graph, and
it can change who has access to an ADME instance. The model assumes the
operator trusts their own machine, the harness and the ribs they install.
Hostile input may arrive from ADME and Graph responses (display names, group
names, legal tag fields, record contents) and from board actions.

### In scope

- A token leaving the batch that fetched it: logged, written to disk, put in a
  board frame or snapshot, or sent anywhere but the ADME or Graph endpoint it
  was issued for.
- A write to ADME or Graph that did not come from an applied plan, or an Apply
  that proceeds after the dry run changed.
- A mutating action that reaches a host, partition or tenant other than the one
  bound into it, for example from a stale board after the profile changed.
- An add that produces a removal, or a plan that removes more than it shows.
- Injection through instance data: a name or field that reaches a shell, a
  filesystem path, or a request URL without being encoded.

### Out of scope

- The Keelson harness itself; report those at
  <https://github.com/danielscholl/keelson>.
- Behavior under a hostile rib, or with an attacker who already has local code
  execution or the operator's Azure CLI session.
- Names, emails and object ids shown in boards and stored in the rib's data
  directory. That is by design for a single-operator local workbench, as the
  README notes.
- ADME, Microsoft Graph or Azure CLI defects; report those to Microsoft.

## Disclosure

Once a fix is released, a GitHub security advisory is published crediting the
reporter (unless they prefer otherwise), with a CVE where warranted.
