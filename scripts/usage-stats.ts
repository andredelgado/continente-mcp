// Records how much the project is used, from what npm and GitHub already publish about it, into CSV
// files plus a README with weekly charts. Nothing here reads anything about the people using the
// server: npm downloads, repository views and clones, referring sites, extension downloads and Docker
// image downloads are the counts npm and GitHub keep anyway. GitHub drops its traffic data after 14
// days, so the scheduled "Usage stats" workflow runs this daily and commits the files to the `stats`
// branch.
//
//   node scripts/usage-stats.ts <directory>
//
// Environment: GITHUB_REPOSITORY (owner/name), GITHUB_TOKEN (release downloads), and TRAFFIC_TOKEN, a
// fine-grained token with read access to the repository's Administration, which views, clones and
// referrers need. Without TRAFFIC_TOKEN those are skipped. Daily totals cover full UTC days.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = 'continentept-mcp';
const EXTENSION = 'continente-mcp.mcpb';
const IMAGE = 'continente-mcp';
const repository = process.env.GITHUB_REPOSITORY ?? 'andredelgado/continente-mcp';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/usage-stats.ts <directory>');
mkdirSync(directory, { recursive: true });

type Row = Record<string, string | number>;
const today = new Date().toISOString().slice(0, 10);
const problems: string[] = [];
const dayMs = 86400000;
const day = (timestamp: string) => timestamp.slice(0, 10);
function offsetDay(date: string, offset: number): string {
  return day(new Date(Date.parse(date) + offset * dayMs).toISOString());
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'usage-stats' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return await response.json() as T;
}

function readCsv(name: string): Row[] {
  const file = join(directory!, name);
  if (!existsSync(file)) return [];
  const [header, ...lines] = readFileSync(file, 'utf8').trim().split('\n');
  if (!header) return [];
  const columns = header.split(',');
  return lines.filter(Boolean).map(line => {
    const values = line.split(',');
    return Object.fromEntries(columns.map((column, index) => {
      const value = values[index] ?? '';
      return [column, /^\d+$/.test(value) ? Number(value) : value];
    }));
  });
}

/** Write rows sorted by their key columns, after replacing existing rows that share a key. */
function mergeCsv(name: string, columns: string[], keys: string[], fresh: Row[], replaceDate?: string): void {
  const key = (row: Row) => keys.map(column => row[column]).join('\u0000');
  const merged = new Map(readCsv(name).filter(row => row.date !== replaceDate).map(row => [key(row), row]));
  for (const row of fresh) merged.set(key(row), row);
  const rows = [...merged.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  // Commas would break the columns; referrers are host names, so this only guards odd values.
  const cell = (value: string | number | undefined) => String(value ?? '').replaceAll(',', ' ');
  writeFileSync(join(directory!, name), [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\n') + '\n');
}

async function collect(name: string, task: () => Promise<void>) {
  try { await task(); } catch (error) { problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

await collect('npm downloads', async () => {
  // Backfill on first run or upgrade, and catch up after a prolonged collection outage.
  const last = readCsv('npm-downloads.csv').filter(row => row.observed_on).at(-1);
  let start = offsetDay(today, -31);
  if (!last) {
    const created = day((await getJson<{ time: { created: string } }>(`https://registry.npmjs.org/${PACKAGE}`)).time.created);
    // From the Monday of the week the package was created, so that first week charts as a full week.
    const createdWeek = offsetDay(created, -((new Date(`${created}T00:00:00Z`).getUTCDay() + 6) % 7));
    if (createdWeek < start) start = createdWeek;
  } else if (String(last.date) < start) start = String(last.date);
  const yesterday = offsetDay(today, -1);
  const rows: Row[] = [];
  // The downloads API answers at most 18 months per request.
  for (let from = start; from <= yesterday; from = offsetDay(from, 500)) {
    const end = offsetDay(from, 499);
    const to = end < yesterday ? end : yesterday;
    const range = await getJson<{ downloads: { day: string; downloads: number }[] }>(
      `https://api.npmjs.org/downloads/range/${from}:${to}/${PACKAGE}`);
    rows.push(...range.downloads.map(entry => ({ date: entry.day, downloads: entry.downloads, observed_on: today })));
  }
  mergeCsv('npm-downloads.csv', ['date', 'downloads', 'observed_on'], ['date'], rows);
});

const trafficToken = process.env.TRAFFIC_TOKEN;
if (!trafficToken) console.log('TRAFFIC_TOKEN is not set, so repository views, clones and referrers are skipped.');
else {
  await collect('repository traffic', async () => {
    type Daily = { timestamp: string; count: number; uniques: number };
    const base = `https://api.github.com/repos/${repository}/traffic`;
    const views = await getJson<{ uniques: number; views: Daily[] }>(`${base}/views`, trafficToken);
    const clones = await getJson<{ uniques: number; clones: Daily[] }>(`${base}/clones`, trafficToken);
    const viewsByDate = new Map(views.views.map(entry => [day(entry.timestamp), entry]));
    const clonesByDate = new Map(clones.clones.map(entry => [day(entry.timestamp), entry]));
    // Both endpoints succeeded. Within the 13 full UTC days inside the rolling window,
    // an omitted bucket is zero. Leave both partial boundary days alone.
    const daily = Array.from({ length: 13 }, (_, i) => {
      const date = offsetDay(today, -1 - i);
      const view = viewsByDate.get(date);
      const clone = clonesByDate.get(date);
      return { date, views: view?.count ?? 0, unique_visitors: view?.uniques ?? 0,
        clones: clone?.count ?? 0, unique_cloners: clone?.uniques ?? 0, observed_on: today };
    });
    mergeCsv('github-traffic.csv', ['date', 'views', 'unique_visitors', 'clones', 'unique_cloners', 'observed_on'], ['date'], daily);

    // Keep an earlier successful referrer snapshot if a same-day retry fails.
    let referrerCount = readCsv('github-traffic-windows.csv').find(row => row.date === today)?.referrer_count ?? '';
    await collect('referrers', async () => {
      const referrers = await getJson<{ referrer: string; count: number; uniques: number }[]>(`${base}/popular/referrers`, trafficToken);
      mergeCsv('referrers.csv', ['date', 'referrer', 'views', 'unique_visitors'], ['date', 'referrer'],
        referrers.map(ref => ({ date: today, referrer: ref.referrer, views: ref.count, unique_visitors: ref.uniques })), today);
      referrerCount = referrers.length;
    });
    mergeCsv('github-traffic-windows.csv', ['date', 'unique_visitors', 'unique_cloners', 'referrer_count'], ['date'],
      [{ date: today, unique_visitors: views.uniques, unique_cloners: clones.uniques, referrer_count: referrerCount }]);
  });
}

await collect('extension downloads', async () => {
  const releases = await getJson<{ tag_name: string; assets: { name: string; download_count: number }[] }[]>(
    `https://api.github.com/repos/${repository}/releases?per_page=100`, process.env.GITHUB_TOKEN);
  // Download counts only ever grow, so each day records the running total per release.
  mergeCsv('extension-downloads.csv', ['date', 'release', 'downloads'], ['date', 'release'], releases.flatMap(release =>
    release.assets.filter(asset => asset.name === EXTENSION).map(asset => ({ date: today, release: release.tag_name, downloads: asset.download_count }))));
});

await collect('Docker image downloads', async () => {
  // GitHub's packages API has no download count; only the package page shows it. The title keeps the exact
  // number when the text is shortened, and a page without it fails here rather than recording a guess.
  const url = `https://github.com/${repository}/pkgs/container/${IMAGE}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'usage-stats' } });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  const total = /Total downloads<\/span>\s*<h3 title="(\d[\d,]*)"/.exec(await response.text())?.[1];
  if (!total) throw new Error(`${new URL(url).pathname}: no download count on the page`);
  // A running total, like the extension's.
  mergeCsv('image-downloads.csv', ['date', 'downloads'], ['date'], [{ date: today, downloads: Number(total.replaceAll(',', '')) }]);
});

/** A legacy row without an observation date might have been collected mid-day. */
function dailyCounts(rows: Row[], column: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row[column];
    if (typeof value === 'number' && typeof row.observed_on === 'string' && row.observed_on > String(row.date)) {
      counts.set(String(row.date), value);
    }
  }
  return counts;
}

function periodTotal(counts: Map<string, number>, start: string, days: number): number | null {
  let total = 0;
  for (let i = 0; i < days; i++) {
    const value = counts.get(offsetDay(start, i));
    if (value === undefined) return null;
    total += value;
  }
  return total;
}

/** Sums per complete ISO week (from Monday), the most recent `count` of them. */
function weekly(counts: Map<string, number>, count: number): { week: string; total: number }[] {
  const weeks: { week: string; total: number }[] = [];
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
  for (; weeks.length < count; monday.setUTCDate(monday.getUTCDate() - 7)) {
    const start = day(monday.toISOString());
    const total = periodTotal(counts, start, 7);
    if (total === null) break;
    weeks.unshift({ week: start.slice(5), total });
  }
  return weeks;
}

function chart(title: string, label: string, weeks: { week: string; total: number }[]): string {
  if (weeks.length < 2) return `${title}: not enough complete weeks recorded yet.\n`;
  return ['```mermaid', 'xychart-beta', `  title "${title}"`, `  x-axis [${weeks.map(week => `"${week.week}"`).join(', ')}]`,
    `  y-axis "${label}"`, `  bar [${weeks.map(week => week.total).join(', ')}]`, '```', ''].join('\n');
}

function trafficSnapshot(): string[] {
  const latest = readCsv('github-traffic-windows.csv').at(-1);
  if (!latest) return [];
  const section = [
    '## GitHub reach and referrers', '',
    `GitHub’s rolling 14-day window, recorded on ${latest.date} (UTC).`, '',
    `Unique repository visitors: ${latest.unique_visitors}. Unique cloners: ${latest.unique_cloners}.`, '',
  ];
  if (latest.referrer_count === '') return [...section, 'Referrer data is unavailable for this snapshot.', ''];
  if (latest.referrer_count === 0) return [...section, 'GitHub reported no referrers for this window.', ''];
  const referrers = readCsv('referrers.csv').filter(row => row.date === latest.date)
    .sort((a, b) => Number(b.views) - Number(a.views));
  return [...section, '| Top referring sites | Views | Unique visitors |', '| --- | ---: | ---: |',
    ...referrers.map(ref => `| ${String(ref.referrer).replaceAll('|', '\\|')} | ${ref.views} | ${ref.unique_visitors} |`), ''];
}

const npm = dailyCounts(readCsv('npm-downloads.csv'), 'downloads');
const traffic = readCsv('github-traffic.csv');
const views = dailyCounts(traffic, 'views');
const clones = dailyCounts(traffic, 'clones');
const extension = readCsv('extension-downloads.csv');
const sum = (counts: Map<string, number>, days: number) => periodTotal(counts, offsetDay(today, -days), days) ?? '—';
const latest = String(extension.at(-1)?.date ?? '');
const extensionTotal = extension.filter(row => row.date === latest).reduce((total, row) => total + Number(row.downloads), 0);
const image = readCsv('image-downloads.csv').at(-1);
writeFileSync(join(directory, 'README.md'), [
  '# Usage stats', '',
  `Updated ${today} by the Usage stats workflow on \`main\`. The counts are what npm and GitHub publish; nothing is collected from the server or its users.`, '',
  '| | Last 7 days | Last 30 days |', '| --- | --- | --- |',
  `| npm downloads | ${sum(npm, 7)} | ${sum(npm, 30)} |`,
  ...(traffic.length ? [`| Repository views | ${sum(views, 7)} | ${sum(views, 30)} |`,
    `| Repository clones | ${sum(clones, 7)} | ${sum(clones, 30)} |`] : []),
  '', 'A dash means coverage is incomplete. Each total covers full UTC days through yesterday.',
  '', `Claude Desktop extension downloads, all releases: ${extensionTotal}.`, '',
  ...(image ? [`Docker image downloads from ghcr.io, all versions: ${image.downloads} (as of ${image.date}).`, ''] : []),
  'npm counts every download, including CI runs, mirrors and repeated `npx` installs, and ghcr.io counts every image pull, so read them as a trend rather than a number of users. Daily unique visitors cannot be added up into unique visitors for a longer period.', '',
  ...trafficSnapshot(),
  chart('npm downloads per week', 'downloads', weekly(npm, 26)),
  ...(traffic.length ? [chart('Repository views per week', 'views', weekly(views, 26))] : []),
  'Files: `npm-downloads.csv`, `github-traffic.csv`, `github-traffic-windows.csv` and `referrers.csv` (14-day snapshots), `extension-downloads.csv` (running totals per release), `image-downloads.csv` (running totals of the Docker image).', '',
].join('\n'));

if (problems.length) { console.error(`Some counts could not be read:\n${problems.join('\n')}`); process.exitCode = 1; }
else console.log(`Usage stats written to ${directory}.`);
