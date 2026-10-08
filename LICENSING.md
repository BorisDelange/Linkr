# Licensing

Linkr is free software. Most of it is under the **GNU Affero General Public License,
version 3 or any later version** (AGPL-3.0-or-later); a few packages meant to be reused
outside Linkr are under the **Apache License 2.0**. This file says which applies where.

| Part | Licence | Text |
|---|---|---|
| The application: `apps/web`, `apps/api`, `docker/`, `scripts/` | AGPL-3.0-or-later | [`LICENSE`](LICENSE) |
| The bundled plugins: `packages/default-plugins` | AGPL-3.0-or-later | [`LICENSE`](LICENSE) |
| The MCP server and its skills: `packages/linkr-mcp` | AGPL-3.0-or-later | [`LICENSE`](LICENSE) |
| The export format (schemas, validator, CLI): `packages/linkr-format` | Apache-2.0 | [`packages/linkr-format/LICENSE`](packages/linkr-format/LICENSE) |
| The script client libraries: `packages/linkr-py`, `packages/linkr-r` | Apache-2.0 | [`packages/linkr-py/LICENSE`](packages/linkr-py/LICENSE), [`packages/linkr-r/LICENSE`](packages/linkr-r/LICENSE) |

Any file not covered by a more specific `LICENSE` in one of its parent directories is
under AGPL-3.0-or-later.

## Why the AGPL

Linkr is mostly used as a networked service: one server, many users in a browser. Under
the plain GPL, someone could modify Linkr and run it as a service without ever sharing
their changes, because nothing is "distributed". The AGPL closes that gap: if you run a
**modified** version of Linkr for users over a network, you must offer those users its
source code (AGPL section 13). Running Linkr unmodified creates no obligation beyond
the GPL's.

## Why Apache 2.0 for the format and the client libraries

`linkr-format` describes how Linkr entities are exported. Other tools should be able to
read and write that format, whatever their own licence. `linkr-py` and `linkr-r` are
imported by analysis scripts; researchers must stay free to publish those scripts under
any licence. Apache 2.0 rather than MIT for its explicit patent grant.

## Additional permission for plugins

As an additional permission under section 7 of the GNU Affero General Public License,
version 3, the copyright holders of Linkr grant you the following:

> A **Linkr plugin** is a work made of a plugin manifest (`plugin.json`) and the files it
> declares — script templates, attachments, documentation — that interacts with Linkr only
> through the plugin interface: the manifest format, the configuration schema, and the
> data and context Linkr passes to the plugin when it runs.
>
> A Linkr plugin is not, by reason of being loaded, configured or run by Linkr, a work
> based on Linkr. You may create, use, distribute and publish a Linkr plugin under terms
> of your choice, provided it does not itself include code from Linkr covered by the
> AGPL.

This permission does not extend to the plugins in `packages/default-plugins`, which are
part of Linkr: a plugin derived from one of them — a copy, a modified version — includes
code covered by the AGPL and remains under the AGPL.

## Content made with Linkr

Linkr's licence does not cover what you make with it. Projects, dashboards, datasets,
SQL scripts, concept mappings, ETL pipelines and the other entities you create or export
belong to their authors, who choose their licence — each entity has a **Licence** tab for
that.

## Contributing

Contributions are accepted under the licence of the part they touch — see
[`CONTRIBUTING.md`](CONTRIBUTING.md#licence).
