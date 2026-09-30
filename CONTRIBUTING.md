# Contributing to OpenAlgo Charts

Report reproducible problems, improve examples and documentation, or send focused code
changes. Use the existing public API and repository conventions as the starting point.
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

Follow [compatibility and maintenance](COMPATIBILITY.md) for public API changes,
deprecation, persistence migrations, host boundaries and release evidence.

## Set up a checkout

Use an active LTS Node.js release satisfying the package's Node.js `>=20` engine,
and npm. From the repository root:

```sh
npm ci
npm run build
```

`npm run build:watch` rebuilds the library while editing. Website dependencies are
installed separately with `npm --prefix website ci`. Use synthetic fixtures for local
feed tests; keep credentials and recorded account data out of commits.

## Choose the relevant checks

For library or reference-demo code, run the complete local gate:

```sh
npm run verify
```

This runs lint, TypeScript, unit tests, the library build, demo tests, declaration
checks, bundle budgets and tree-shaking checks. Run a focused test while developing,
for example `npx vitest run tests/navigation-settings.test.ts`.

TypeScript runs twice. `npm run typecheck` uses `tsconfig.json`. `npm run
typecheck:strict` compiles `src` under `tsconfig.strict.json`, which adds
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and counts the errors
per tier by the path of the file each is in. It fails when a tier listed in
`scripts/strict-tiers.json` has an error, or when a tier with none is not listed yet,
so a tier that becomes clean joins the list in the same change. Code in a listed tier
must pass both flags. Prefer a fix that shows the compiler what the code already
guarantees (a checked index, a narrowed local, an optional property typed
`| undefined` where `undefined` is written) over a non-null assertion. A built-in
drawing tool ends in `satisfies AnchoredTool<N>` (`src/draw/types.ts`), which hands its
body the anchors the layer guarantees for `points: N`, so it reads them without one.

Write regression tests around observable behavior and realistic inputs. A bug test
should fail against the original behavior; avoid assertions that merely repeat the
implementation. Rendering and gesture changes also need a real browser check and
inspection of the resulting pixels. Trace new options through their effect on output.

```sh
npx playwright install chromium
npm run e2e
```

Build the library first. Playwright starts its fixture servers; the yfinance browser
scenario requires Python 3 and reports a skip when it is unavailable. Optional visual
parity checks compare against `dist-baseline/`: run `npm run baseline -- HEAD~1`, replacing
`HEAD~1` with a suitable known-good ref, then run the browser suite. Inspect intentional
visual changes before accepting a new comparison point.

For indicator performance or allocation changes, use `npm run bench` or `npm run soak`
as appropriate. [CI](.github/workflows/ci.yml) also checks skill coverage, browser
behavior, documentation builds and supply-chain constraints.

A prose-only change needs accurate links and examples. Run the website build when
editing its MDX or components; a root Markdown correction does not require new tests
or an unrelated screenshot refresh.

## Documentation and browser demos

Build the library, generate the API reference, then build the static website:

```sh
npm run build
npm run docs
npm --prefix website ci
npm --prefix website run build
npm --prefix website run preview
```

The preview serves `http://127.0.0.1:4174/openalgo-charts/`. For iterative editing,
`npm --prefix website run dev` serves the development site. Both development startup
and production builds sync current library bundles and standalone demos automatically.
Edit source demos and library code, then rebuild; generated copies are not source files.
Treat TypeDoc warnings as defects in API documentation or exported types.

With the static preview running, execute the relevant checks from another terminal:

```sh
node scripts/check-depth-demo.mjs
node scripts/check-profile-website.mjs
node scripts/check-navigation-website.mjs
```

For loading or drawing changes, run the managed-loading Playwright projects in
Chromium, Firefox and WebKit. Keep drawing previews visible past the newest candle
and assert that saved drawings never paint inside either price-axis strip.

For a drawing descriptor change, run `npx playwright test drawing-catalog`
against the built package. The catalogue sweep covers visible pixels, persistence,
pointer placement, touch placement, body and handle movement, and undo. Inspect
the screenshots as well as the assertions. Open `/examples/drawings/index.html`
for a sample of every tool; use `node scripts/check-drawing-demo.mjs` for the
website's embedded playground and standalone gallery. Keep registry, rail and
icon coverage in step, and preserve the version-2 drawing document.

Measure drawing paint, hit and drag work separately when changing performance.
Use identical data, viewport, DPR and drawing counts, and run timings without
concurrent builds or test workers. Bound curve/recursive work and include loaded
history with a changing forming bar. A faster result must preserve accurate
hit regions, level visibility, font changes and price-axis clipping.

These check depth grouping, profile/orderflow controls and screenshot fingerprints,
and current bundles plus time-axis dragging, two-axis plot panning, optional horizontal
panning and Reset view across website charts. They accept
an alternative preview base URL as the first argument. Inspect browser artifacts when
debugging failures. Other targeted checks are listed in [website/README.md](website/README.md).

When a source listed in
[the profile capture manifest](website/public/screenshots/market-profile-v2.1.1/captures.json)
changes, regenerate its screenshots and fingerprints from the newly built library:
start `node tests/e2e/serve.cjs`, then run
`node scripts/capture-profile-screenshots.mjs` in another terminal. Review the PNGs and
manifest together, rebuild the website, and rerun the profile check. Keep compressed
overviews and enlarged session close-ups faithful to their documented framing. The
capture directory identifies a capture generation, not the current package version.

## API contracts and agent skills

Keep the eight tier boundaries and zero runtime dependency model intact. Use registry
extensions and public tier exports; avoid deep imports that create separate registries.
Time is UTC seconds, while display zones are configurable. `DataLoadingController`
can own history, paging and recovery for a host; the host still owns display binding,
shared-feed lifetime, replay controls and broker execution.
See [ARCHITECTURE.md](ARCHITECTURE.md), [project conventions](CLAUDE.md), and
[host lifecycle guidance](.github/skills/openalgo-charts/references/host-integration.md).

Update the matching [skill reference](.github/skills/README.md) whenever an API, default
or supported workflow changes. Preserve useful migration guidance, including the
[2.0 drawing migration](docs/migrating-to-2.md), and remove contradictory older examples.
After building, run `npm run skills:coverage`. Also validate Markdown links and skill
frontmatter, then try realistic task prompts using only the affected skill references.
Export-name coverage alone cannot establish correct lifecycle advice or working examples.

## Issues and pull requests

For a bug, include the package version, browser or host, a minimal reproduction, and
expected versus actual behavior. Include relevant errors or screenshots. Feature
requests should explain the user workflow and the result the API should enable.

Keep a pull request focused. Describe the concrete problem, resulting behavior and
validation performed; identify meaningful limitations or skipped checks. Update the
related docs and runnable example when behavior changes. Use Conventional Commits,
such as `fix(navigation): preserve the preferred view` or `docs: explain local previews`.
Use generic behavior descriptions, keep comparison brands out of repository content,
and follow the plain-text writing rules in [CLAUDE.md](CLAUDE.md).

## Publishing a release

Maintainers use the authorized release workflow. Prepare the version, lockfile,
`src/version.ts`, changelog, website release notes, measured size/count claims and skill
updates before tagging; follow [the release process](CLAUDE.md#release-process-for-every-new-version) and
[the measured-facts checklist](CLAUDE.md#before-every-npm-publish).
Verify that package, source and built `version()` agree with the intended `vX.Y.Z` tag.

Push the verified tag, then manually dispatch [Release](.github/workflows/release.yml)
with that existing tag. A tag push alone does not publish. The job verifies the tagged
source and publishes with npm trusted publishing through OIDC and signed provenance,
using the configured `release` environment rather than a long-lived npm token.

Confirm the npm version and provenance, create or update the GitHub release for the
same tag using the changelog, and verify the separate
[Pages deployment](.github/workflows/deploy-docs.yml). Pages runs on matching source/site
changes or manual dispatch; npm publication does not create a GitHub release or deploy
the site itself. Keep published tags immutable. Follow-up documentation changes can be
ordinary commits; changes to a published package require a new version.
