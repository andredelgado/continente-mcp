# Usage stats

Updated 2026-11-27 by the Usage stats workflow on `main`. The counts are what npm and GitHub publish; nothing is collected from the server or its users.

| | Last 7 days | Last 30 days |
| --- | --- | --- |
| npm downloads | 240 | 2514 |
| Repository views | 480 | — |
| Repository clones | 227 | — |

A dash means coverage is incomplete. Each total covers full UTC days through yesterday.

Claude Desktop extension downloads, all releases: 401.

Docker image downloads from ghcr.io, all versions: 270 (as of 2026-11-27).

npm counts every download, including CI runs, mirrors and repeated `npx` installs, and ghcr.io counts every image pull, so read them as a trend rather than a number of users. Daily unique visitors cannot be added up into unique visitors for a longer period.

## GitHub reach and referrers

GitHub’s rolling 14-day window, recorded on 2026-11-27 (UTC).

Unique repository visitors: 352. Unique cloners: 306.

| Top referring sites | Views | Unique visitors |
| --- | ---: | ---: |
| t.co | 203 | 188 |
| reddit.com | 60 | 45 |
| github.com | 37 | 15 |
| Google | 34 | 29 |
| teams.public.onecdn.static.microsoft | 7 | 7 |
| com.reddit.frontpage | 6 | 4 |
| ecosia.org | 4 | 4 |
| Bing | 2 | 2 |
| DuckDuckGo | 1 | 1 |
| com.twitter.android | 1 | 1 |

```mermaid
xychart-beta
  title "npm downloads per week"
  x-axis ["10-12", "10-19", "10-26", "11-02", "11-09", "11-16"]
  y-axis "downloads"
  bar [1400, 140, 833, 491, 815, 667]
```

```mermaid
xychart-beta
  title "Repository views per week"
  x-axis ["11-09", "11-16"]
  y-axis "views"
  bar [630, 232]
```

Files: `npm-downloads.csv`, `github-traffic.csv`, `github-traffic-windows.csv` and `referrers.csv` (14-day snapshots), `extension-downloads.csv` (running totals per release), `image-downloads.csv` (running totals of the Docker image).
