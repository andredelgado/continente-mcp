# Contributing

Thanks for helping improve Continente MCP. Bug reports and pull requests are welcome.

## Contributors

Thank you to everyone who has contributed code:

- **Miguel Costa** ([@Lozano-Miguel](https://github.com/Lozano-Miguel)): the recommended
  price (PVPR) in search and product results
  ([#4](https://github.com/andredelgado/continente-mcp/pull/4)).
- **Diogo Almeida** ([@almeiduh](https://github.com/almeiduh)): the browser boundary that
  blocks payment and checkout, and the Cartão Continente coupon tools
  ([#11](https://github.com/andredelgado/continente-mcp/pull/11), merged as
  [#18](https://github.com/andredelgado/continente-mcp/pull/18) and
  [#19](https://github.com/andredelgado/continente-mcp/pull/19)).
- **André Fonseca** ([@andre0xFF](https://github.com/andre0xFF)): the Docker image and its
  smoke check ([#20](https://github.com/andredelgado/continente-mcp/pull/20)).

Thanks also to everyone who reported bugs, suggested features and tried early versions. When
your pull request is merged, add yourself here in the same pull request, or the maintainer
will.

## Setup

Use Node.js 22 or newer.

```sh
npm ci
npm run build
npm run setup        # downloads Chromium for the browser tests
```

## Checks

```sh
npm run typecheck    # source, tests and tooling
npm test             # offline suite; never contacts the website
npm run test:browser # real Chromium against local fixtures only
npm run test:package # packs, installs and starts the published tarball
npm audit --omit=dev
npm run build:bundle # builds the Claude Desktop extension, build/continente-mcp.mcpb
npm run check:site   # signed-out checks against the live website (public pages only)
```

CI runs all of these on Linux (Node 22 and 24) and on macOS and Windows (Node 24).

A scheduled workflow runs `check:site` every Monday. When the website changes in a way the
parsers no longer understand, it opens an issue labelled `site-check`, and closes it once the
check passes again. Start it by hand from the Actions tab after a parser change.

Tests never touch a real account. Browser tests serve every request from local fixtures and
block anything else. Fixtures in `test/fixtures/` are small synthetic pages that use the
same selectors as the live site; they must not contain real customer, order or session data.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/mcp/` | Tool definitions, schemas, result envelopes, text output, server instructions and the prompt |
| `src/services/` | Shopping rules: search ranking, favorites cache, cart verification, order scans |
| `src/domain/` | Validated types for identifiers, money, quantities, errors and outcomes |
| `src/parsers/` | Pure functions that turn website HTML/JSON into domain values |
| `src/clients/` | Website navigation, HTTP requests and login |
| `src/session/` | Browser lifetime, request deadlines, cancellation and the serial queue |
| `src/stores/` | Atomic, private cookie and favorites files |
| `src/config.ts`, `src/runtime.ts`, `src/cli.ts` | Settings, wiring and the command line |

Website data enters as `unknown` and is validated by a parser before services use it.
Services return `Result<T, ToolError>`; only the MCP layer formats output. Keep stdout for
protocol messages only.

## Guidelines

- **Cart safety comes first.** Every cart change must be confirmed by reading the cart back.
  Anything that fails after a request may have been sent must report
  `mutation.outcome: "unknown"` and must never be retried automatically. Add a regression test
  that counts writes when touching this path.
- **Never guess.** Unknown prices, quantities, units and completeness stay explicitly
  unknown rather than defaulting to a plausible value.
- **Fix at the boundary.** When the website changes, update the parser and its fixture, and
  add a test for the new markup.
- **The tool contract is pinned.** `test/contract/tools.json` holds every tool's name, title,
  hints, input and output schemas, plus the prompts and resources (descriptions left out). When
  a change to these is deliberate, run `npm run contract:update`, review the diff, and note the
  change in `CHANGELOG.md`; the test fails until you do.
- The `basket-planner` prompt text in `src/mcp/guide.ts` must match the body of
  `skills/basket-planner/SKILL.md`. Edit both together; a test fails when they differ.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for pull request titles
  (`fix:`, `feat:`, `docs:`, ...). Pull requests are squash-merged.
- Note user-facing changes under `Unreleased` in `CHANGELOG.md`. Don't bump the version in feature pull requests.

## Releasing

Maintainers only.

1. Open a `chore: release X.Y.Z` pull request that runs `npm version X.Y.Z --no-git-tag-version`
   and moves the `Unreleased` entries in `CHANGELOG.md` under the new version.
2. After it is merged, create a GitHub release with tag `vX.Y.Z` on that commit, using the
   changelog entries as its notes. Mark it as a prerelease for `-rc` and similar versions.
3. Publishing the release runs the test matrix and publishes the same version to npm with
   provenance (`latest`, or `next` for prereleases), attaches `continente-mcp.mcpb` to
   the release, and updates the MCP Registry listing from `server.json` (stable releases
   only). The workflow fills in the version and the extension checksum for the listing.
4. Once the release is published, run `npm run sync:server-json` and commit the result
   (`chore: list X.Y.Z in server.json`), so the repository's `server.json` shows the same
   version, extension URL and checksum as the listing.

Never reuse or overwrite a published version.

## Usage stats

Maintainers only. The Usage stats workflow runs daily and commits to the `stats` branch what
npm and GitHub already publish about the project: npm downloads, repository views, clones and
referrers, and extension downloads, as CSV files with a README of weekly charts. GitHub keeps
traffic for only 14 days, so the branch is the history. Nothing is collected from the server
or the people using it.

Views, clones and referrers need the `TRAFFIC_TOKEN` repository secret: a fine-grained personal
access token for this repository only, with read-only Administration access. Without it the
workflow records npm and extension downloads only. To try it locally, run
`node scripts/usage-stats.ts <directory>` with `TRAFFIC_TOKEN` set.
