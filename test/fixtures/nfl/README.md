# NFL test fixtures

## `source_2026.json.gz`

nflverse release data for the 2026 season as retrieved on 2026-10-02 (Weeks
1 to 3 played): schedule, play-by-play, weekly player and team stats, weekly
rosters, injuries, and each team's latest depth-chart snapshot, limited to the
columns the builder reads. The file's `provenance` block records each source
URL, retrieval time and SHA-256.

Data: nflverse (https://github.com/nflverse/nflverse-data), CC-BY 4.0.

Rebuild with `node etl/nfl/build.mjs --season 2026` then
`node etl/nfl/tools/make-fixtures.mjs`.

## `odds-synthetic.mjs`

Generates a provider-shaped odds feed for the tests: real players and games
from the fixture above, made-up deterministic prices, and the structure the
2026-10-02 probe observed (DraftKings single lines, FanDuel ladders, a live
game, markets outside the V1 allowlist). No sportsbook or provider data is in
this repository.

## `odds_probe.json.gz` (not committed)

The raw rows the read-only probe captured. They are the provider's data, are
ignored by git, and exist only on a machine where the probe was run. One test,
`test/nfl-odds-capture.test.mjs`, uses them when present and is skipped
otherwise.
