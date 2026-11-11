// tools/make-package.mjs（公開用パッケージの作成）と、公開版で権限がないときの auto-update.js の動きのテスト。
//   node --test "tools/package.test.mjs"

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  EXCLUDED_LISTS,
  MAX_DESCRIPTION,
  MIN_CHROME_VERSION,
  buildPublicManifest,
  collectPackageFiles,
  compareFiles,
  filterMeta,
  filterPopups,
  findPlaceholders,
  forbiddenNames,
  inspectPackage,
  isExcludedRulesFile,
  makePackage,
  makeZip,
  readDirFiles,
  readZip,
} from './make-package.mjs';

const realManifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'adban-package-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const write = async (root, path, content) => {
  const abs = join(root, ...path.split('/'));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content);
};

// 開発用のフォルダーに似せた、小さな見本
async function makeFixture(root) {
  const manifest = {
    ...realManifest,
    version: '9.9.9',
    declarative_net_request: {
      rule_resources: [
        { id: 'base', enabled: true, path: 'rules/base.json' },
        { id: 'peterlowe', enabled: true, path: 'rules/peterlowe.json' },
      ],
    },
  };
  await write(root, 'manifest.json', JSON.stringify(manifest, null, 2));
  for (const f of ['background.js', 'popup-blocker.js', 'auto-update.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'package.json']) {
    await write(root, f, `// ${f}\n`);
  }
  await write(root, 'content/cosmetic.js', '// c\n');
  await write(root, 'lib/filters.js', '// l\n');
  await write(root, 'filters/base.txt', '||ads.example.com^\n');
  await write(root, 'rules/base.json', '[]\n');
  await write(root, 'rules/base.cosmetic.json', '{}\n');
  await write(root, 'rules/peterlowe.json', '[]\n');
  await write(root, 'rules/peterlowe.cosmetic.json', '{}\n');
  await write(root, 'rules/scriptlets/peterlowe.0.js', '//\n');
  await write(root, 'rules/scriptlets/base.0.js', '//\n');
  await write(root, 'rules/.tmp-build/x.json', '[]\n');
  await write(root, 'rules/meta.json', `${JSON.stringify({ lists: [{ id: 'base', hash: 'aaa' }, { id: 'peterlowe', hash: 'bbb' }] })}\n`);
  await write(root, 'rules/popups.json', `${JSON.stringify({ v: 1, lists: { base: { b: {} }, peterlowe: { b: {} } } })}\n`);
  // 入れてはいけないもの
  await write(root, 'tools/make-package.mjs', '//\n');
  await write(root, 'tools/e2e/out/2026/report.json', '{}\n');
  await write(root, 'tools/foo.test.mjs', '//\n');
  await write(root, '_metadata/verified_contents.json', '{}\n');
  await write(root, 'node_modules/x/index.js', '//\n');
  await write(root, 'dist/old.zip', 'x');
  await write(root, 'update-filters.log', 'x');
  await write(root, 'options/debug.log', 'x');
  await write(root, 'options/options.js', '// o\n');
  await write(root, '.git/config', 'x');
}

// ---- zip ----

test('zip を作って読み戻すと、一覧・中身が同じで、パスの区切りは「/」', () => {
  const files = new Map([
    ['manifest.json', Buffer.from('{"a":1}\n')],
    ['rules/a.json', Buffer.from('[1,2,3,4,5,6,7,8,9]'.repeat(500))], // よく縮む
    ['resources/random.bin', randomBytes(2000)], // 縮まない（stored になる）
    ['空.txt', Buffer.alloc(0)],
    ['日本語/ファイル.txt', Buffer.from('あいう')],
  ]);
  const zip = makeZip(files);
  const back = readZip(zip);
  assert.deepEqual([...back.keys()].sort(), [...files.keys()].sort());
  for (const [name, data] of files) assert.ok(back.get(name).equals(data), name);
  assert.ok(![...back.keys()].some((n) => n.includes('\\')));
  assert.ok(zip.length < 2000 + 400 + 9500, '縮むファイルは小さくなる');
});

test('同じ中身からは同じ zip ができる（日時を固定している）', () => {
  const files = new Map([['b.txt', Buffer.from('b'.repeat(100))], ['a.txt', Buffer.from('a'.repeat(100))]]);
  assert.ok(makeZip(files).equals(makeZip(new Map([...files].reverse()))));
});

test('zip の中身が壊れていたら、読み戻しで気づく', () => {
  const zip = makeZip(new Map([['a.txt', Buffer.from('hello world hello world')]]));
  const broken = Buffer.from(zip);
  broken[40] ^= 0xff; // ローカルヘッダーのあとの本文を 1 バイト壊す
  assert.throws(() => readZip(broken));
  assert.throws(() => readZip(Buffer.from('これは zip ではありません')), /終端/);
});

test('zip: Node の zlib 以外の読み手（PowerShell の .NET）でも読める形（ヘッダーの必須の項目）', () => {
  const zip = makeZip(new Map([['a/b.txt', Buffer.from('x')]]));
  assert.equal(zip.readUInt32LE(0), 0x04034b50); // PK\x03\x04
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800); // UTF-8 のファイル名
  assert.equal(zip.subarray(30, 30 + 5).toString(), 'a/b.t'); // 区切りは「/」
});

// ---- 公開版の manifest.json ----

test('公開版の manifest: alarms・idle・peterlowe を外し、minimum_chrome_version を設定する。ほかは変えない', () => {
  const pub = buildPublicManifest(realManifest);
  assert.ok(!pub.permissions.includes('alarms'));
  assert.ok(!pub.permissions.includes('idle'));
  assert.deepEqual(
    pub.permissions,
    realManifest.permissions.filter((p) => p !== 'alarms' && p !== 'idle'),
  );
  assert.ok(pub.permissions.includes('declarativeNetRequestFeedback'), 'ポップアップの件数（getMatchedRules）に要る');
  assert.ok(pub.permissions.includes('webNavigation'), 'popup-blocker.js が使う');
  assert.equal(pub.minimum_chrome_version, MIN_CHROME_VERSION);
  assert.equal(pub.version, realManifest.version);
  const ids = pub.declarative_net_request.rule_resources.map((r) => r.id);
  assert.ok(!ids.includes('peterlowe'));
  assert.deepEqual(ids, realManifest.declarative_net_request.rule_resources.map((r) => r.id).filter((id) => !EXCLUDED_LISTS.includes(id)));
  assert.deepEqual(pub.content_scripts, realManifest.content_scripts);
  assert.deepEqual(pub.background, realManifest.background);
});

test('公開版の manifest: 元の manifest は書き換えない', () => {
  const before = JSON.stringify(realManifest);
  buildPublicManifest(realManifest);
  assert.equal(JSON.stringify(realManifest), before);
  assert.ok(realManifest.permissions.includes('alarms'), '開発用の manifest は alarms を持ったまま');
});

test('description は 132 文字以内（ストアの上限）。超えると作れない', () => {
  assert.ok([...realManifest.description].length <= MAX_DESCRIPTION);
  assert.throws(() => buildPublicManifest({ ...realManifest, description: 'あ'.repeat(MAX_DESCRIPTION + 1) }), /132/);
  assert.doesNotThrow(() => buildPublicManifest({ ...realManifest, description: 'あ'.repeat(MAX_DESCRIPTION) }));
});

test('meta.json・popups.json から外したリストの項目だけを除く（ほかの項目は変えない）', () => {
  const meta = { lists: [{ id: 'base', hash: 'a', rules: 1 }, { id: 'peterlowe', hash: 'b' }, { id: 'ubo', hash: 'c' }], extra: 1 };
  assert.deepEqual(filterMeta(meta), { lists: [meta.lists[0], meta.lists[2]], extra: 1 });
  const popups = { v: 1, lists: { ubo: { b: 1 }, peterlowe: { b: 2 } } };
  assert.deepEqual(filterPopups(popups), { v: 1, lists: { ubo: { b: 1 } } });
});

test('外したリストの rules/ のファイルを見分ける', () => {
  for (const p of ['rules/peterlowe.json', 'rules/peterlowe.cosmetic.json', 'rules/peterlowe.scriptlets.json', 'rules/scriptlets/peterlowe.3.js']) {
    assert.ok(isExcludedRulesFile(p), p);
  }
  for (const p of ['rules/easylist.json', 'rules/meta.json', 'rules/scriptlets/ubo.3.js', 'resources/peterlowe.js']) {
    assert.ok(!isExcludedRulesFile(p), p);
  }
});

// ---- 禁止された名前・点検 ----

test('先頭が「_」の名前（Chrome が拒否する）を見つける', () => {
  assert.deepEqual(forbiddenNames(['a.js', '_metadata/x.json', 'rules/_tmp/a.json', 'rules/_x.json', 'a_b/c_.js']), [
    '_metadata/x.json',
    'rules/_tmp/a.json',
    'rules/_x.json',
  ]);
});

test('inspectPackage: 問題のあるパッケージを見つける', () => {
  const good = buildPublicManifest(realManifest);
  const files = (extra = {}, manifest = good) =>
    new Map([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...good.declarative_net_request.rule_resources.map((r) => [r.path, Buffer.from('[]')]), ...Object.entries(extra).map(([k, v]) => [k, Buffer.from(v)])]);
  assert.deepEqual(inspectPackage(files()), []);
  assert.match(inspectPackage(files({ '_metadata/a.json': '' })).join(), /_/);
  assert.match(inspectPackage(files({ 'tools/check.mjs': '' })).join(), /tools/);
  assert.match(inspectPackage(files({ 'update.log': '' })).join(), /log/);
  assert.match(inspectPackage(files({ 'rules/peterlowe.json': '[]' })).join(), /peterlowe/);
  assert.match(inspectPackage(files({}, { ...good, permissions: [...good.permissions, 'alarms'] })).join(), /alarms/);
  assert.match(inspectPackage(files({}, { ...good, minimum_chrome_version: '99' })).join(), /minimum_chrome_version/);
  const noRules = files();
  noRules.delete(good.declarative_net_request.rule_resources[0].path);
  assert.match(inspectPackage(noRules).join(), /ファイルがありません/);
  assert.match(inspectPackage(new Map([['manifest.json', Buffer.from('{')]])).join(), /JSON/);
});

// ---- パッケージの作成 ----

test('パッケージ: 許可リストのものだけが入り、tools・_metadata・ログ・peterlowe は入らない', async () => {
  await withTempDir(async (root) => {
    await makeFixture(root);
    const files = await collectPackageFiles(root);
    const names = [...files.keys()];
    assert.deepEqual(names, [
      'LICENSE',
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'auto-update.js',
      'background.js',
      'content/cosmetic.js',
      'filters/base.txt',
      'lib/filters.js',
      'manifest.json',
      'options/options.js',
      'popup-blocker.js',
      'rules/base.cosmetic.json',
      'rules/base.json',
      'rules/meta.json',
      'rules/popups.json',
      'rules/scriptlets/base.0.js',
    ]);
    assert.deepEqual(forbiddenNames(names), []);
    const meta = JSON.parse(files.get('rules/meta.json'));
    assert.deepEqual(meta.lists, [{ id: 'base', hash: 'aaa' }], 'ハッシュなど、ほかの項目は元のまま');
    assert.deepEqual(Object.keys(JSON.parse(files.get('rules/popups.json')).lists), ['base']);
    const manifest = JSON.parse(files.get('manifest.json'));
    assert.equal(manifest.version, '9.9.9');
    assert.deepEqual(manifest.declarative_net_request.rule_resources.map((r) => r.id), ['base']);
    assert.deepEqual(inspectPackage(files), []);
  });
});

test('パッケージ: 展開済みのディレクトリと zip を書き出し、zip を読み戻すと一致する', async () => {
  await withTempDir(async (root) => {
    await makeFixture(root);
    const out = join(root, 'dist');
    const result = await makePackage({ srcRoot: root, outDir: out });
    assert.deepEqual(result.problems, []);
    assert.equal(result.zipPath, join(out, 'adban-9.9.9.zip'));
    const dirFiles = await readDirFiles(result.packageDir);
    const zipFiles = readZip(await readFile(result.zipPath));
    assert.deepEqual(compareFiles(dirFiles, zipFiles), []);
    assert.deepEqual([...dirFiles.keys()], [...result.files.keys()]);
    // 開発用の manifest.json は変わらない
    const devManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.ok(devManifest.permissions.includes('alarms'));
    assert.ok(devManifest.declarative_net_request.rule_resources.some((r) => r.id === 'peterlowe'));
  });
});

test('パッケージ: 作り直すと、前に作ったパッケージの残りが消える（dist は入れない）', async () => {
  await withTempDir(async (root) => {
    await makeFixture(root);
    const out = join(root, 'dist');
    await write(out, 'package/stale.js', 'x');
    const result = await makePackage({ srcRoot: root, outDir: out, zip: false });
    assert.equal(result.zipPath, null);
    assert.ok(!(await readdir(result.packageDir)).includes('stale.js'));
    assert.ok(![...(await readDirFiles(result.packageDir)).keys()].some((p) => p.startsWith('dist/')));
  });
});

test('パッケージ: 必須のファイルがなければ作らない', async () => {
  await withTempDir(async (root) => {
    await makeFixture(root);
    await rm(join(root, 'LICENSE'));
    await assert.rejects(() => makePackage({ srcRoot: root, outDir: join(root, 'dist') }), /LICENSE/);
  });
});

test('compareFiles: 一覧と中身の違いを見つける', () => {
  const a = new Map([['x', Buffer.from('1')], ['y', Buffer.from('2')]]);
  const b = new Map([['x', Buffer.from('1')], ['y', Buffer.from('3')], ['z', Buffer.from('4')]]);
  const problems = compareFiles(a, b, 'A', 'B').join('\n');
  assert.match(problems, /中身が違う: y/);
  assert.match(problems, /A にない: z/);
  assert.deepEqual(compareFiles(a, a), []);
});

test('実際の開発用フォルダー: 公開版に変換できる（description・権限・ルールセット）', async () => {
  const files = await collectPackageFiles(new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.deepEqual(inspectPackage(files), []);
  assert.deepEqual(forbiddenNames([...files.keys()]), []);
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.ok(manifest.declarative_net_request.rule_resources.every((r) => files.has(r.path)));
  assert.ok(files.has('LICENSE') && files.has('THIRD_PARTY_NOTICES.md'));
});

// ---- 問題の報告の URL（lib/support.js）の目印 ----

const supportSource = (support, source, privacy) =>
  `export const SUPPORT_URL = '${support}';\nexport const SOURCE_URL = '${source}';\nexport const PRIVACY_URL = '${privacy}';\n`;

test('findPlaceholders: 目印が残っていれば名前を返し、置き換え済みなら空', () => {
  const left = new Map([['lib/support.js', Buffer.from(supportSource('__SUPPORT_URL__', 'https://example.com/src', '__PRIVACY_URL__'))]]);
  assert.deepEqual(findPlaceholders(left), ['__SUPPORT_URL__', '__PRIVACY_URL__']);
  const done = new Map([['lib/support.js', Buffer.from(supportSource('https://example.com/i', 'https://example.com/s', 'https://example.com/p'))]]);
  assert.deepEqual(findPlaceholders(done), []);
  assert.deepEqual(findPlaceholders(new Map()), []);
});

test('パッケージ: lib/support.js に目印が残っていると作れない（置き換え方を案内する）', async () => {
  await withTempDir(async (root) => {
    await makeFixture(root);
    await write(root, 'lib/support.js', supportSource('__SUPPORT_URL__', '__SOURCE_URL__', '__PRIVACY_URL__'));
    const out = join(root, 'dist');
    await assert.rejects(
      makePackage({ srcRoot: root, outDir: out }),
      (e) => /__SUPPORT_URL__/.test(e.message) && /実際の URL に置き換え/.test(e.message) && /--allow-placeholder/.test(e.message),
    );
    // 失敗したときは、パッケージを書き出さない
    await assert.rejects(readdir(join(out, 'package')));
  });
});

test('パッケージ: --allow-placeholder 相当（allowPlaceholder）なら、目印のままでも作れる（残った目印を返す）', async () => {
  await withTempDir(async (root) => {
    await makeFixture(root);
    await write(root, 'lib/support.js', supportSource('__SUPPORT_URL__', 'https://example.com/s', '__PRIVACY_URL__'));
    const result = await makePackage({ srcRoot: root, outDir: join(root, 'dist'), allowPlaceholder: true });
    assert.deepEqual(result.placeholders, ['__SUPPORT_URL__', '__PRIVACY_URL__']);
    assert.deepEqual(result.problems, []);
  });
});

test('パッケージ: 目印を実際の URL に置き換えてあれば、そのまま作れる', async () => {
  await withTempDir(async (root) => {
    await makeFixture(root);
    await write(root, 'lib/support.js', supportSource('https://example.com/i', 'https://example.com/s', 'https://example.com/p'));
    const result = await makePackage({ srcRoot: root, outDir: join(root, 'dist') });
    assert.deepEqual(result.placeholders, []);
    assert.ok(result.files.has('lib/support.js'));
  });
});

// ---- 権限がないとき（公開版）の auto-update.js ----

async function importAutoUpdate(chromeStub) {
  globalThis.chrome = chromeStub;
  try {
    // 毎回新しく読み込む
    return await import(`${pathToFileURL(join(import.meta.dirname, '..', 'auto-update.js')).href}?t=${Math.random()}`);
  } finally {
    delete globalThis.chrome;
  }
}

test('auto-update.js: alarms・idle がなくても（公開版）読み込みで例外を出さず、何もしない', async () => {
  const calls = [];
  const stub = {
    runtime: {
      id: 'x',
      getURL: (p) => p,
      onMessage: { addListener: () => calls.push('onMessage') },
    },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} } },
  };
  const mod = await importAutoUpdate(stub);
  assert.equal(mod.UPDATE_SUPPORTED, false);
  assert.deepEqual(calls, [], 'メッセージの待ち受けも作らない');
  globalThis.chrome = stub;
  try {
    assert.deepEqual(await mod.checkForUpdate(), { status: 'unsupported' });
  } finally {
    delete globalThis.chrome;
  }
});

test('auto-update.js: alarms・idle があれば（開発用）これまでどおり待ち受けと周期を作る', async () => {
  const calls = [];
  const stub = {
    runtime: { id: 'x', getURL: (p) => p, onMessage: { addListener: () => calls.push('onMessage') } },
    alarms: {
      create: (name) => calls.push(`create:${name}`),
      get: async () => undefined,
      onAlarm: { addListener: () => calls.push('onAlarm') },
    },
    idle: { queryState: async () => 'idle' },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} } },
  };
  const mod = await importAutoUpdate(stub);
  assert.equal(mod.UPDATE_SUPPORTED, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.includes('onAlarm'));
  assert.ok(calls.includes('onMessage'));
  assert.ok(calls.includes('create:adban-update-check'));
});
