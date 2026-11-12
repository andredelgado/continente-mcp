// Records how much the project is used, from what npm and GitHub already publish about it, into CSV
// files plus a README with weekly charts. Nothing here reads anything about the people using the
// server: npm downloads, repository views and clones, referring sites and extension downloads are
// the counts npm and GitHub keep anyway. GitHub drops its traffic data after 14 days, so the scheduled
// "Usage stats" workflow runs this daily and commits the files to the `stats` branch.
//
//   node scripts/usage-stats.ts <directory>
//
// Environment: GITHUB_REPOSITORY (owner/name), GITHUB_TOKEN (release downloads), and TRAFFIC_TOKEN, a
// fine-grained token with read access to the repository's Administration, which views, clones and
// referrers need. Without TRAFFIC_TOKEN those are skipped. Each file is merged by date, so a rerun
// replaces the day's values and a partial day is completed by later runs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = 'continentept-mcp';
const EXTENSION = 'continente-mcp.mcpb';
const repository = process.env.GITHUB_REPOSITORY ?? 'andredelgado/continente-mcp';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/usage-stats.ts <directory>');
mkdirSync(directory, { recursive: true });

type Row = Record<string, string | number>;
const today = new Date().toISOString().slice(0, 10);
const problems: string[] = [];

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
function mergeCsv(name: string, columns: string[], keys: string[], fresh: Row[]): Row[] {
  const key = (row: Row) => keys.map(column => row[column]).join('\u0000');
  const merged = new Map(readCsv(name).map(row => [key(row), row]));
  for (const row of fresh) merged.set(key(row), row);
  const rows = [...merged.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  // Commas would break the columns; referrers are host names, so this only guards odd values.
  const cell = (value: string | number | undefined) => String(value ?? '').replaceAll(',', ' ');
  writeFileSync(join(directory!, name), [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\n') + '\n');
  return rows;
}

async function collect(name: string, task: () => Promise<void>) {
  try { await task(); } catch (error) { problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

const day = (timestamp: string) => timestamp.slice(0, 10);

await collect('npm downloads', async () => {
  // The first run fills in everything since the package was created; later runs refresh the last month.
  const known = readCsv('npm-downloads.csv').length > 0;
  let start = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  if (!known) {
    const created = day((await getJson<{ time: { created: string } }>(`https://registry.npmjs.org/${PACKAGE}`)).time.created);
    if (created < start) start = created;
  }
  const rows: Row[] = [];
  // The downloads API answers at most 18 months per request.
  for (let from = new Date(start); from.toISOString().slice(0, 10) <= today; from = new Date(from.getTime() + 500 * 86400000)) {
    const to = new Date(Math.min(from.getTime() + 499 * 86400000, Date.now())).toISOString().slice(0, 10);
    const range = await getJson<{ downloads: { day: string; downloads: number }[] }>(
      `https://api.npmjs.org/downloads/range/${from.toISOString().slice(0, 10)}:${to}/${PACKAGE}`);
    rows.push(...range.downloads.map(entry => ({ date: entry.day, downloads: entry.downloads })));
  }
  mergeCsv('npm-downloads.csv', ['date', 'downloads'], ['date'], rows);
});

const trafficToken = process.env.TRAFFIC_TOKEN;
if (!trafficToken) console.log('TRAFFIC_TOKEN is not set, so repository views, clones and referrers are skipped.');
else {
  await collect('repository traffic', async () => {
    type Daily = { timestamp: string; count: number; uniques: number };
    const base = `https://api.github.com/repos/${repository}/traffic`;
    const views = await getJson<{ views: Daily[] }>(`${base}/views`, trafficToken);
    const clones = await getJson<{ clones: Daily[] }>(`${base}/clones`, trafficToken);
    const byDate = new Map<string, Row>();
    const entry = (date: string) => byDate.get(date) ?? byDate.set(date, { date, views: 0, unique_visitors: 0, clones: 0, unique_cloners: 0 }).get(date)!;
    for (const view of views.views) Object.assign(entry(day(view.timestamp)), { views: view.count, unique_visitors: view.uniques });
    for (const clone of clones.clones) Object.assign(entry(day(clone.timestamp)), { clones: clone.count, unique_cloners: clone.uniques });
    mergeCsv('github-traffic.csv', ['date', 'views', 'unique_visitors', 'clones', 'unique_cloners'], ['date'], [...byDate.values()]);
    // Referrers only come as a total for the last 14 days, so each day records that window.
    const referrers = await getJson<{ referrer: string; count: number; uniques: number }[]>(`${base}/popular/referrers`, trafficToken);
    mergeCsv('referrers.csv', ['date', 'referrer', 'views', 'unique_visitors'], ['date', 'referrer'],
      referrers.map(referrer => ({ date: today, referrer: referrer.referrer, views: referrer.count, unique_visitors: referrer.uniques })));
  });
}

await collect('extension downloads', async () => {
  const releases = await getJson<{ tag_name: string; assets: { name: string; download_count: number }[] }[]>(
    `https://api.github.com/repos/${repository}/releases?per_page=100`, process.env.GITHUB_TOKEN);
  // Download counts only ever grow, so each day records the running total per release.
  mergeCsv('extension-downloads.csv', ['date', 'release', 'downloads'], ['date', 'release'], releases.flatMap(release =>
    release.assets.filter(asset => asset.name === EXTENSION).map(asset => ({ date: today, release: release.tag_name, downloads: asset.download_count }))));
});

/** Sums per ISO week (from Monday) of the weeks wholly covered by the rows, the most recent `count` of them. */
function weekly(rows: Row[], column: string, count: number): { week: string; total: number }[] {
  const values = new Map(rows.map(row => [String(row.date), Number(row[column]) || 0]));
  const weeks: { week: string; total: number }[] = [];
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
  for (; weeks.length < count; monday.setUTCDate(monday.getUTCDate() - 7)) {
    const days = Array.from({ length: 7 }, (_, offset) => new Date(monday.getTime() + offset * 86400000).toISOString().slice(0, 10));
    if (!days.every(date => values.has(date))) break;
    weeks.unshift({ week: days[0]!.slice(5), total: days.reduce((sum, date) => sum + values.get(date)!, 0) });
  }
  return weeks;
}

function chart(title: string, label: string, weeks: { week: string; total: number }[]): string {
  if (weeks.length < 2) return `${title}: not enough complete weeks recorded yet.\n`;
  return ['```mermaid', 'xychart-beta', `  title "${title}"`, `  x-axis [${weeks.map(week => `"${week.week}"`).join(', ')}]`,
    `  y-axis "${label}"`, `  bar [${weeks.map(week => week.total).join(', ')}]`, '```', ''].join('\n');
}

const npm = readCsv('npm-downloads.csv');
const traffic = readCsv('github-traffic.csv');
const extension = readCsv('extension-downloads.csv');
/** The total over the last `days` full days, or a dash while the files do not cover all of them yet. */
const sum = (rows: Row[], column: string, days: number) => {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  if (!rows.some(row => String(row.date) <= since)) return '—';
  return rows.filter(row => String(row.date) >= since && String(row.date) < today).reduce((total, row) => total + (Number(row[column]) || 0), 0);
};
const latest = String(extension.at(-1)?.date ?? '');
const extensionTotal = extension.filter(row => row.date === latest).reduce((total, row) => total + Number(row.downloads), 0);
writeFileSync(join(directory, 'README.md'), [
  '# Usage stats', '',
  `Updated ${today} by the Usage stats workflow on \`main\`. The counts are what npm and GitHub publish; nothing is collected from the server or its users.`, '',
  '| | Last 7 days | Last 30 days |', '| --- | --- | --- |',
  `| npm downloads | ${sum(npm, 'downloads', 7)} | ${sum(npm, 'downloads', 30)} |`,
  ...(traffic.length ? [`| Repository views | ${sum(traffic, 'views', 7)} | ${sum(traffic, 'views', 30)} |`,
    `| Repository clones | ${sum(traffic, 'clones', 7)} | ${sum(traffic, 'clones', 30)} |`] : []),
  '', `Claude Desktop extension downloads, all releases: ${extensionTotal}.`, '',
  'npm counts every download, including CI runs, mirrors and repeated `npx` installs, so read them as a trend rather than a number of users. Daily unique visitors cannot be added up into unique visitors for a longer period.', '',
  chart('npm downloads per week', 'downloads', weekly(npm, 'downloads', 26)),
  ...(traffic.length ? [chart('Repository views per week', 'views', weekly(traffic, 'views', 26))] : []),
  'Files: `npm-downloads.csv`, `github-traffic.csv`, `referrers.csv` (the 14-day window as recorded each day), `extension-downloads.csv` (running totals per release).', '',
].join('\n'));

if (problems.length) { console.error(`Some counts could not be read:\n${problems.join('\n')}`); process.exitCode = 1; }
else console.log(`Usage stats written to ${directory}.`);
