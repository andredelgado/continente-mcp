# Usage stats

Updated 2026-11-21 by the Usage stats workflow on `main`. The counts are what npm and GitHub publish; nothing is collected from the server or its users.

| | Last 7 days | Last 30 days |
| --- | --- | --- |
| npm downloads | 667 | 2832 |
| Repository views | 259 | — |
| Repository clones | 597 | — |

A dash means coverage is incomplete. Each total covers full UTC days through yesterday.

Claude Desktop extension downloads, all releases: 346.

Docker image downloads from ghcr.io, all versions: 114 (as of 2026-11-21).

npm counts every download, including CI runs, mirrors and repeated `npx` installs, and ghcr.io counts every image pull, so read them as a trend rather than a number of users. Daily unique visitors cannot be added up into unique visitors for a longer period.

## GitHub reach and referrers

GitHub’s rolling 14-day window, recorded on 2026-11-21 (UTC).

Unique repository visitors: 265. Unique cloners: 335.

| Top referring sites | Views | Unique visitors |
| --- | ---: | ---: |
| reddit.com | 88 | 65 |
| github.com | 65 | 14 |
| com.reddit.frontpage | 31 | 22 |
| Google | 26 | 24 |
| t.co | 16 | 13 |
| teams.public.onecdn.static.microsoft | 16 | 15 |
| Bing | 4 | 2 |
| ecosia.org | 2 | 2 |
| DuckDuckGo | 1 | 1 |
| npmjs.com | 1 | 1 |

```mermaid
xychart-beta
  title "npm downloads per week"
  x-axis ["10-12", "10-19", "10-26", "11-02", "11-09"]
  y-axis "downloads"
  bar [1400, 140, 833, 491, 815]
```

Repository views per week: not enough complete weeks recorded yet.

Files: `npm-downloads.csv`, `github-traffic.csv`, `github-traffic-windows.csv` and `referrers.csv` (14-day snapshots), `extension-downloads.csv` (running totals per release), `image-downloads.csv` (running totals of the Docker image).
