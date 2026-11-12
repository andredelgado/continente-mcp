# Usage stats

Updated 2026-11-12 by the Usage stats workflow on `main`. The counts are what npm and GitHub publish; nothing is collected from the server or its users.

| | Last 7 days | Last 30 days |
| --- | --- | --- |
| npm downloads | 566 | 3245 |

Claude Desktop extension downloads, all releases: 289.

npm counts every download, including CI runs, mirrors and repeated `npx` installs, so read them as a trend rather than a number of users. Daily unique visitors cannot be added up into unique visitors for a longer period.

```mermaid
xychart-beta
  title "npm downloads per week"
  x-axis ["10-12", "10-19", "10-26", "11-02"]
  y-axis "downloads"
  bar [1400, 140, 833, 491]
```

Files: `npm-downloads.csv`, `github-traffic.csv`, `referrers.csv` (the 14-day window as recorded each day), `extension-downloads.csv` (running totals per release).
