// tools/build-filters.mjs の build() の確認: 一時ディレクトリに作った小さなリストだけを使う（ネットワーク・本物の rules/ は使わない）
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { build } from './build-filters.mjs';

const LISTS = [
  { id: 'a', name: 'リスト A', url: 'https://example.invalid/a.txt' },
  { id: 'b', name: 'リスト B', url: 'https://example.invalid/b.txt' },
];
const TEXT = {
  a: '||ads.example.com^\nexample.com##.banner\nexample.org##+js(set-constant, adblock, false)\n',
  b: '||tracker.example.net/t/one.js\n',
};

let dir;
const quiet = { log() {}, warn() {} };
const run = (texts, options = {}) =>
  build({
    root: dir,
    lists: LISTS,
    readText: async (list) => {
      const t = texts[list.id];
      if (t instanceof Error) throw t;
      return t;
    },
    ...quiet,
    ...options,
  });
const readText = (rel) => readFile(join(dir, rel), 'utf8');
const readMeta = async () => JSON.parse(await readText('rules/meta.json'));
const exists = (rel) => stat(join(dir, rel)).then(() => true, () => false);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'adban-build-test-'));
  await mkdir(join(dir, 'rules'), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('初回は全リストを書き出し、meta.json に hash を持ち、一時ディレクトリを残さない', async () => {
  const result = await run(TEXT);
  assert.equal(result.changed, true);
  const meta = await readMeta();
  assert.deepEqual(meta.lists.map((l) => l.id), ['a', 'b']);
  for (const l of meta.lists) assert.match(l.hash, /^[0-9a-f]{64}$/);
  for (const f of ['a.json', 'a.cosmetic.json', 'b.json', 'b.cosmetic.json', 'popups.json']) assert.ok(await exists(`rules/${f}`), f);
  assert.equal(JSON.parse(await readText('rules/a.json')).length, 1);
  assert.equal(await exists('rules/.tmp-build'), false);
  assert.ok((await readdir(join(dir, 'rules'))).every((n) => !n.startsWith('_')), '_ で始まる名前がない');
});

test('スクリプレットの表は分割ファイルに書かれ、リストから消えると古いファイルも消える', async () => {
  await run(TEXT);
  assert.ok(await exists('rules/a.scriptlets.json'));
  const shards = (await readdir(join(dir, 'rules/scriptlets'))).filter((n) => n.startsWith('a.'));
  assert.ok(shards.length > 0);
  await run({ ...TEXT, a: '||ads.example.com^\n' });
  assert.equal(await exists('rules/a.scriptlets.json'), false);
  assert.deepEqual((await readdir(join(dir, 'rules/scriptlets'))).filter((n) => n.startsWith('a.')), []);
});

test('取得内容が前回と同じなら何も書き換えず、updated も変わらない', async () => {
  let t = 1_000;
  const now = () => new Date((t += 1_000_000));
  await run(TEXT, { now });
  const before = await readText('rules/meta.json');
  const beforeStat = await stat(join(dir, 'rules/meta.json'));
  const result = await run(TEXT, { now });
  assert.equal(result.changed, false);
  assert.equal(await readText('rules/meta.json'), before);
  assert.equal((await stat(join(dir, 'rules/meta.json'))).mtimeMs, beforeStat.mtimeMs);
});

test('一部のリストだけ変わったら、そのリストの updated・hash だけが変わる', async () => {
  let t = 1_000;
  const now = () => new Date((t += 1_000_000));
  await run(TEXT, { now });
  const before = await readMeta();
  await run({ ...TEXT, b: '||tracker.example.net/t/one.js\n||other.example.net/t/two.js\n' }, { now });
  const after = await readMeta();
  const [a0, b0] = before.lists;
  const [a1, b1] = after.lists;
  assert.deepEqual(a1, a0);
  assert.notEqual(b1.hash, b0.hash);
  assert.notEqual(b1.updated, b0.updated);
  assert.equal(b1.rules, 2);
  assert.equal(JSON.parse(await readText('rules/b.json')).length, 2);
});

test('一部のリストの取得に失敗しても、ほかは更新され、失敗したリストは前回の内容のまま', async () => {
  await run(TEXT);
  const result = await run({ a: new Error('HTTP 500'), b: '||new.example.net^\n' });
  assert.equal(result.failed, 1);
  assert.equal(result.changed, true);
  const meta = await readMeta();
  assert.equal(meta.lists.find((l) => l.id === 'a').rules, 1);
  assert.equal(meta.lists.find((l) => l.id === 'b').rules, 1);
  assert.equal((await readText('rules/a.json')).includes('ads.example.com'), true);
  assert.equal((await readText('rules/b.json')).includes('new.example.net'), true);
});

test('すべて取得に失敗したら何も書かない', async () => {
  await run(TEXT);
  const before = await readText('rules/meta.json');
  const result = await run({ a: new Error('x'), b: new Error('y') });
  assert.equal(result.failed, 2);
  assert.equal(result.changed, false);
  assert.equal(await readText('rules/meta.json'), before);
});

test('変換の途中で例外になったら rules/ は元のまま（途中まで書かない）', async () => {
  await run(TEXT);
  const names = await readdir(join(dir, 'rules'));
  const before = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readText(`rules/${n}`)));
  await assert.rejects(run({ a: '||changed.example.com^\n', b: 12345 }));
  const names2 = await readdir(join(dir, 'rules'));
  assert.deepEqual(names2, names);
  const after = await Promise.all(names2.filter((n) => n.endsWith('.json')).map((n) => readText(`rules/${n}`)));
  assert.deepEqual(after, before);
});

test('--force なら取得内容が同じでも書き直す', async () => {
  await run(TEXT);
  const result = await run(TEXT, { force: true });
  assert.equal(result.changed, true);
});

test('--offline は file のあるリストだけを変換する', async () => {
  await mkdir(join(dir, 'filters'), { recursive: true });
  await writeFile(join(dir, 'filters/base.txt'), '||ads.example.com^\n');
  const lists = [{ id: 'base', name: '基本', file: 'filters/base.txt' }, ...LISTS];
  const result = await build({ root: dir, lists, offline: true, readText: undefined, ...quiet });
  assert.equal(result.changedLists, 1);
  assert.deepEqual((await readMeta()).lists.map((l) => l.id), ['base']);
  assert.equal(await exists('rules/a.json'), false);
});
