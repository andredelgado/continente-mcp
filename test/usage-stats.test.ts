import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('stats report counts covered days and matches uniques and referrers by snapshot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'continente-stats-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  const save = (file: string, data: string) => writeFileSync(join(dir, file), data);
  // Upgrade from the previous schema, including a partial day and a referrer from yesterday.
  save('github-traffic.csv', 'date,views,unique_visitors,clones,unique_cloners\n2026-10-01,15,2,3,1\n2026-11-12,95,6,21,1\n');
  save('npm-downloads.csv', 'date,downloads\n2026-08-05,23\n2026-11-09,10\n');
  save('referrers.csv', 'date,referrer,views,unique_visitors\n2026-11-11,older.example,3,1\n');

  const today = Date.parse('2026-11-12T06:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: today });
  const days = Array.from({ length: 30 }, (_, i) =>
    ({ day: new Date(today - (i + 1) * 86400000).toISOString().slice(0, 10), downloads: 0 }));
  const paths = new Map<string, unknown>([
    ['/continentept-mcp', { time: { created: '2026-08-01' } }],
    ['/traffic/views', { uniques: 4, views: [
      { timestamp: '2026-11-05', count: 10, uniques: 3 }, { timestamp: '2026-11-06', count: 12, uniques: 3 },
      { timestamp: '2026-11-12', count: 95, uniques: 3 },
    ] }],
    ['/traffic/clones', { uniques: 0, clones: [] }],
    ['/traffic/popular/referrers', [{ referrer: 'one.example', count: 8, uniques: 4 }]],
    ['/releases', []],
  ]);
  let downloads = days.filter(row => row.day !== '2026-11-09');
  // The ghcr.io package page, which shortens a large count in its text but keeps it whole in the title.
  let imagePage = '<span class="d-block">Total downloads</span>\n  <h3 title="1,234">1.2k</h3>';
  const ranges: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const { pathname, hostname } = new URL(url);
    if (hostname === 'github.com') return pathname.endsWith('/pkgs/container/continente-mcp') ? new Response(imagePage) : new Response(null, { status: 404 });
    if (hostname === 'api.npmjs.org') {
      ranges.push(pathname);
      return Response.json({ downloads });
    }
    const path = pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    return paths.has(path) ? Response.json(paths.get(path)) : new Response(null, { status: 503 });
  });
  const argv = process.argv;
  const token = process.env.TRAFFIC_TOKEN;
  const exitCode = process.exitCode;
  t.after(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    if (token === undefined) delete process.env.TRAFFIC_TOKEN;
    else process.env.TRAFFIC_TOKEN = token;
  });
  process.argv = [process.execPath, 'usage-stats', dir];
  process.env.TRAFFIC_TOKEN = 'fixture';
  const collector = new URL('../tools/usage-stats.js', import.meta.url);
  let run = 0;
  async function record(expectedExit = 0) {
    process.exitCode = 0;
    await import(`${collector.href}?run=${++run}`);
    assert.equal(process.exitCode, expectedExit);
    return read('README.md');
  }

  let report = await record();
  // The package was created on Saturday 1 August: the backfill starts that Monday, so the first week is whole.
  assert.ok(ranges[0]?.includes('2026-07-27:2026-11-11'));
  assert.match(report, /npm downloads \| — \| —/);
  assert.match(report, /Repository views \| 22 \| —/);
  assert.match(report, /Repository clones \| 0 \| —/);
  assert.match(report, /Unique repository visitors: 4\. Unique cloners: 0/);
  assert.match(report, /one\.example \| 8 \| 4/);
  assert.doesNotMatch(report, /older\.example/);
  assert.match(read('github-traffic.csv'), /2026-11-11,0,0,0,0,2026-11-12/);
  assert.match(read('github-traffic.csv'), /2026-10-01,15,2,3,1,\n/);
  assert.equal(read('image-downloads.csv'), 'date,downloads\n2026-11-12,1234\n');
  assert.match(report, /Docker image downloads from ghcr\.io, all versions: 1234 \(as of 2026-11-12\)/);

  paths.delete('/traffic/popular/referrers');
  // A changed page layout records nothing, rather than a wrong count.
  imagePage = '<h3>1.2k</h3>';
  report = await record(1);
  assert.match(report, /one\.example \| 8 \| 4/);
  assert.equal(read('image-downloads.csv'), 'date,downloads\n2026-11-12,1234\n');
  imagePage = '<span>Total downloads</span><h3 title="1240">1.2k</h3>';

  downloads = days;
  paths.set('/traffic/popular/referrers', []);
  report = await record();
  assert.match(report, /npm downloads \| 0 \| 0/);
  assert.match(report, /no referrers/);
  assert.doesNotMatch(read('referrers.csv'), /one\.example/);
  assert.match(read('referrers.csv'), /older\.example/);
  assert.deepEqual(read('github-traffic-windows.csv').trim().split('\n').slice(1), ['2026-11-12,4,0,0']);

  t.mock.timers.setTime(today + 86400000);
  delete process.env.TRAFFIC_TOKEN;
  report = await record();
  assert.equal(read('image-downloads.csv'), 'date,downloads\n2026-11-12,1240\n2026-11-13,1240\n');
  // The legacy entry for Nov 12 was collected while the day was still in progress.
  assert.match(report, /Repository views \| — \| —/);
  assert.match(report, /recorded on 2026-11-12/);

  process.env.TRAFFIC_TOKEN = 'fixture';
  paths.delete('/traffic/popular/referrers');
  paths.set('/traffic/clones', { uniques: 1, clones: [
    { timestamp: '2026-11-11', count: 2, uniques: 1 }, { timestamp: '2026-11-12', count: 3, uniques: 1 },
  ] });
  report = await record(1);
  assert.match(report, /recorded on 2026-11-13/);
  assert.match(report, /Repository clones \| 5 \| —/);
  assert.match(report, /Referrer data is unavailable/);
  assert.match(read('github-traffic-windows.csv'), /2026-11-13,4,1,\n/);
});
