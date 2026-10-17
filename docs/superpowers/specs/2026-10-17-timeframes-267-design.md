# 2.6.7: custom timeframes, independent indicator history and favorites

Status: approved by the user on 2026-10-17. The user subsequently authorized autonomous implementation, validation, commits and publication in both repositories, including `/trading`, Historify, changelogs, releases and the website.

## User intent and delivery order

Users should be able to choose useful chart and indicator timeframes even when their
data provider offers only a few native intervals. A daily EMA with length 200 must
have its own daily history when displayed on a five-minute chart. Frequently used
timeframes should remain available as saved shortcuts.

The user explicitly requires this order:

1. Implement the SDK and local yfinance reference host.
2. Test the reference host locally, including actual rendered charts.
3. Only after those checks pass, implement the integration in OpenAlgo `/trading` and Historify charts.
4. Validate the consumer against the packed 2.6.7 candidate.

Starting SDK commit: `f1afd4d6c7dee4706ce8000523423a2984bf2ab6` (2.6.6).
Starting consumer commit: `8c1ce004c629e761e86f8b3fe1289543c358bf87`.
Both working trees were clean when this design started. The latest checked consumer
CI run, `39017343731`, succeeded. Recheck both states before implementation.

The accepted feature scope is custom timeframes, independent higher-timeframe
indicator history and saved timeframe favorites. Watchlist color labels remain a
separate OpenAlgo feature. Forming higher-timeframe indicator values were not
selected; confirmed values remain the behavior of the built-in timeframe option.
The custom chart's current candle may still update while forming.

## Existing implementation to reuse

| Concern | Existing source | Implication |
| --- | --- | --- |
| Interval registration and calendar periods | `src/feed/intervals.ts` | Reuse the token and calendar rules; a registered interval alone does not supply history. |
| Higher-timeframe built-ins | `src/indicators/timeframe.ts` | The current wrapper folds loaded chart bars and cannot supply independent warmup history. |
| Requested data lifecycle | `src/indicators/requested-indicator.ts`, `src/indicators/requested-context.ts` | Reuse cancellation, status, stale-result rejection and availability alignment. |
| Provider contract and replay guards | `src/model/indicator-registry.ts`, `src/core/chart-studies.ts` | Keep legacy raw-bar providers valid; snapshots explicitly declare confirmation and availability. |
| Cache and concurrency | `src/feed/cache.ts`, `src/feed/request-pool.ts` | Keep caches bounded and share requests with independent consumer cancellation. |
| Reference host calendar folding | `examples/yfinance/src/intervals.js`, `examples/yfinance/src/feed.js` | Replace duplicate host folding with shared behavior where compatible. |
| Widget preferences | `src/widget/widget-storage.ts`, `src/widget/rail.ts` | Follow existing persistence and storage-failure behavior for timeframe favorites. |
| Consumer history and capabilities | `frontend/src/lib/trading/terminal.ts`, `frontend/src/lib/trading/intervals.ts` in OpenAlgo | Broker-native capabilities and chart-selectable intervals must become separate concepts. |
| Consumer exchange calendar | `frontend/src/lib/trading/sessionHours.ts` in OpenAlgo | Use actual exchange sessions and exceptions for aggregation and availability. |
| Stored-data aggregation | `database/historify_db.py` in OpenAlgo | Historify already has custom intraday and calendar aggregation; do not create a second database implementation. |

## Architecture decision

Use a provider-neutral aggregation layer in the SDK, enabled by the host. Hosts
provide native capabilities, source history access and exchange/session facts.
Chart rendering remains transport-independent. Both chart history and indicator
history use the same resolved source and bucket rules.

Alternatives considered:

- Host-only aggregation would duplicate rules between the reference host and
  `/trading`, and other SDK consumers could not reuse it.
- A backend-only change would not fix independent SDK consumers or the reference
  host and would broaden this release into a public broker API change.
- The selected shared SDK layer keeps broker discovery and limits in the host,
  while sharing the calculation and validation that must agree everywhere.

The broker-facing REST history contract and broker plugins remain unchanged in
this scope. `/trading` resolves a custom request to supported native requests and
uses the shared SDK layer. Server-wide custom intervals for every API consumer
would be a separate feature.

## Custom chart and indicator timeframes

### Source selection

- Prefer the native requested interval when it is available and has the required
  session and data variant. Preserve existing native chart behavior.
- Otherwise select a compatible smaller interval. Prefer the coarsest compatible
  source that covers the required history; use a finer source if alignment requires it.
- Fixed intervals require divisible durations and compatible boundaries. An hourly
  source can build two-hour bars only when it fits the chosen two-hour boundaries.
  Five-minute OHLC bars cannot build exact seven-minute bars.
- Calendar weeks, months and quarters use daily source bars with the same session
  and adjustment policy. A week is a calendar week, not five or seven observations.
- Support positive custom seconds, minutes and hours when a compatible source exists.
  Support weekly, monthly and quarterly calendar targets and their valid registered
  multiples. Minute `m` and month `M` remain distinct.
- Reject unsupported requests with a useful reason. Do not silently relabel a native
  timeframe, invent seconds history from minutes, or switch adjustment/session policy.
- Native capabilities, history retention and request-size limits are host facts.
  Cancellation, bounded pagination and a clear exhausted-history result are required.

### Candle construction

- Open is the first source open; high/low are the extrema; close is the last source
  close; volume is summed; open interest is the last available observation.
- Intraday buckets anchor to the exchange session open and stop at session end.
  A short final bucket is valid. Respect breaks, holidays, special sessions and
  overnight sessions supplied by the calendar. Do not infer a new session open
  from the first returned candle of a partial history request.
- Calendar periods follow the exchange calendar. Display-timezone changes must not
  silently change the exchange candles. Existing hosts with explicit calendar
  timezone behavior keep their declared behavior.
- Historical requests expand to complete source bucket boundaries, deduplicate and
  sort source observations, then trim the returned target window. Pagination must
  not drop or double-count a bucket crossing two pages.
- Historical and live paths share boundaries. Replacing an updated source candle
  replaces its contribution instead of adding its volume again. Preserve the
  existing cumulative-day-volume versus per-update-volume distinction.
- Do not fill missing traded data with fabricated OHLCV. An interrupted or truncated
  source response must not be presented as proven complete coverage.
- Cache only completed history, refresh the current tail, and separate identities
  by provider, instrument, source/target interval, session, adjustment and bucket policy.
  Reuse existing bounded cache/request-pool behavior; no unbounded retained series.

## Daily EMA 200 on an intraday chart

The built-in timeframe wrapper gains an independent-history path when the host
explicitly supplies the required snapshot/history capability. The setting remains
the existing `timeframe` setting; users need no second indicator or script.

1. Resolve the selected study timeframe through the same source-selection layer.
2. Request its own history before the earliest target chart bar, including the
   study's required warmup. Use actual returned observations, not calendar-day count,
   to determine whether the requirement is met.
3. Compute on those requested candles with the existing indicator formula and seed
   convention. Each supported built-in must declare or derive its required lookback;
   chained smoothers cannot borrow EMA's period as their own warmup rule.
4. Align only confirmed results whose declared availability is no later than the
   target chart observation. During a session, a daily EMA uses completed daily data.
5. Keep the requested series stable across chart-only viewport changes. Extending
   historical coverage may recompute recursive indicators; document seed-window
   sensitivity and compare equal input histories in parity tests.

The host must supply truthful availability metadata. Raw OHLC arrays alone do not
prove when a value became available. Daily/session completion uses explicit exchange
rules, not an assumed UTC midnight. Calendar completion uses calendar boundaries,
not a constant number of seconds.

Reuse the managed requested-indicator lifecycle. Symbol, exchange, interval, data
variant, provider and relevant calculation-setting changes invalidate stale work.
Removal cancels requests; style changes do not restart the same history load.
Request failures and insufficient history remain visible through existing data-status
and retry UI. Repeated price ticks must not trigger repeated full-history downloads.

Hosts without the new capability retain the current local-fold path and its
documented history limitation. Empty/chart timeframe keeps its current calculation.
Existing unsupported transformed and indicator-output sources keep their safeguards.

Replay must use the existing availability clock and provider `asOf` contract. A host
that cannot provide historical value versions must report the independent path as
unsupported during replay, rather than filter today's revised values and claim
historical correctness. No future daily close may appear on an earlier intraday bar.

## Saved timeframe favorites

- Provide an accessible favorite toggle in the timeframe menu and compact favorite
  shortcuts in the toolbar. Keep the full timeframe menu available.
- Persist favorites separately from the currently selected timeframe and pane data.
  Preserve insertion order, deduplicate equivalent entries and validate stored values.
- Preserve existing default shortcuts when no preference has been saved. An explicitly
  empty favorites list stays empty; it does not reset to defaults on reload.
- Favorites can include validated custom intervals. Keep saved preferences when a
  provider changes, but disable currently unsupported choices with a clear reason.
- Share favorites across panes in the same workspace. Changes should not switch an
  unfocused pane or rewrite its current interval.
- Handle blocked storage gracefully. Preserve old saved charts, layouts, templates,
  import/export and restore paths without requiring a migration from the user.
- Desktop and mobile use the same preference state. Controls must be keyboard
  reachable, have stable hit areas and avoid shifting when hovered or selected.
- Implement in the SDK widget and the reference host first. `/trading` owns separate
  React controls and receives its explicit integration only after the local gate.

## Validation gate A: SDK and local reference host

Write meaningful regression tests before changing behavior and demonstrate that the
daily EMA case fails against 2.6.6. Keep raw reports and screenshots outside the repo
under `/Users/openalgo/Charts/audit/release-2.6.7/`.

Required deterministic cases:

- Seven-minute candles from one-minute source, two-hour candles from compatible
  hourly source, and hourly fallback from smaller source when hourly is unavailable.
- Weekly/monthly/quarterly candles across holidays, leap day, quarter/year changes,
  timezone offsets and DST. Verify OHLCV and open interest against hand-computed bars.
- Reject five-minute-to-seven-minute and minute-to-second requests. Exercise valid
  seconds aggregation with deterministic data because the reference provider has no
  native seconds history.
- Session-end partial buckets, missing data, source corrections, duplicate pages,
  initial history cut inside a bucket, reconnect and history/live overlap.
- Daily EMA 200 on a short five-minute history compared numerically with a daily
  calculation over exactly the same requested history. Assert actual plotted values,
  pre-warmup gaps and daily availability, not just a nonempty indicator list.
- Insufficient history, source errors, stale responses, removal, rapid symbol and
  timeframe switches, multiple studies sharing data and storage failures.
- Replay before and after a daily result becomes available, including backwards seek;
  explicitly unsupported historical revisions must not produce a result.
- Favorite add/remove, empty state, reload, multiple panes, unavailable broker choices,
  custom interval restoration, keyboard use and compact/mobile widths.

Run targeted unit tests, reference-host tests and real Chromium, Firefox and WebKit
checks. Inspect screenshots of candles, indicator lines, menus and favorite controls.
Use fixture data for reproducible correctness; also check the local reference host
against live yfinance history where available and report any provider limitation.
Its one-minute history retention limits seven-minute chart depth; request a supported
window and show the limitation instead of promising unavailable history.

Gate A passes only when the implemented features have passing automated checks and
inspected local browser results. No OpenAlgo product implementation begins before it.
Leave the user's existing local server running; use separate ports for automated tests.

## Validation gate B: OpenAlgo /trading and Historify integration

After gate A, use an isolated consumer checkout with the packed SDK candidate.

- Resolve native capabilities from the existing intervals response, normalize aliases,
  and expose only native or derivable custom choices. Existing orders and broker
  authentication remain outside the change.
- Register the same independent-history provider for built-ins and chart requests,
  using the existing exchange calendar, shared feed/cache, cancellation and retry path.
- Integrate custom interval entry and favorites into the React toolbar, keyboard
  interval entry, indicator settings and workspace restoration.
- Verify live source updates, refresh after a close, reconnect, symbol switches,
  multiple panes and active-pane ownership. Never place real orders to test chart data.
- Run consumer trading tests, typecheck, production build, API/skill generation checks
  and the real `/trading` browser harness in all three browsers and supported themes.
- Integrate the same independent indicator history, custom interval choices and saved
  favorites into Historify charts using its existing stored-data feed. Verify daily EMA
  200 on five-minute stored history and matching custom candles. Reuse its database
  aggregation; any demonstrated parity defect gets a focused regression and correction.
- Follow the consumer's required Linux gthread and resource-lifecycle checks before
  committing consumer changes, including the local `fd-audit` skill where applicable.

## Compatibility, documentation and completion

Keep zero runtime dependencies, tier boundaries and existing public signatures valid.
Any additive public types and exports receive API docs, skill coverage and runnable
examples. Keep comparison names out of source, comments, tests and product docs.

Update the SDK version to 2.6.7, changelog, website release notes, examples and all
required current-version references only with the tested release candidate. Update
the consumer's chart-indicator skill and generated metadata with its dependency pin.
Update affected architecture diagrams and canonical documentation.

Run the repository's full verification, API generation without warnings, website
build, compatibility checks and required consumer checks. Measure bundle sizes from
the final build and run the release benchmark last on an idle machine. Do not reuse
2.6.6 measurements. Follow `CLAUDE.md` for release ordering and publication within
the user's authorization. Report implementation, local verification, consumer
integration and publication as separate states; planning is not implementation.
