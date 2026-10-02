# @keelson/rib-adme

A [keelson](https://github.com/danielscholl/keelson) rib for administering an
[Azure Data Manager for Energy](https://learn.microsoft.com/azure/energy-data-services/)
(ADME) instance: who has access, what data is in it, and who can reach each
seismic subproject.

**Status: design stage.** Nothing is built yet. The repository holds the design
and an interactive mockup; the rib code follows.

## What the first take covers

Three surfaces, one per tab:

- **ADME Access.** People and applications: who needs attention and why, every
  person against roles and seismic grants, and adding, fixing or removing
  access through a previewed plan.
- **ADME Data.** Read-only: which services answer, legal tags and their expiry,
  how much data is in the partition by kind, and a record search.
- **ADME Seismic.** Seismic subprojects with their members by name, and granting
  or revoking a person's access.

The rib works from the operator's Azure CLI sign-in and stores no secret. Every
change is a dry-run plan first; nothing is written until the plan is applied.

## Design

- [design/README.md](design/README.md): the design document.
- [design/adme-access-desk.html](design/adme-access-desk.html): the interactive
  mockup. Download it and open it in a browser. It draws the three tabs and the
  inspectors with the markup and styles Keelson's board renderer uses, on
  sample data.
- [design/spec.md](design/spec.md): the screen-by-screen specification the
  mockup is built from.

![ADME Access tab, sample data](design/screens/access.png)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
