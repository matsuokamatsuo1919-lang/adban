// 公開用パッケージ（Chrome ウェブストア・Microsoft Edge アドオンに出す zip）を作る。
//   node tools/make-package.mjs [--out <dir>] [--no-zip] [--allow-placeholder]
//
//   <out>/package/            … 展開済みのパッケージ（chrome://extensions の「パッケージ化されていない拡張機能を読み込む」で読み込める）
//   <out>/adban-<version>.zip … 同じ中身の zip（ストアに出すもの）
//   <out> の既定は dist/。
//
// 開発用のフォルダーはそのままでは配れない（tools/e2e/out の計測結果・テスト・開発用の自動更新・ライセンスの記載がないリストなどが混ざる）ので、
// 許可リスト方式で必要なファイルだけを集め、manifest.json は公開版に変換して出力する（開発用の manifest.json は変えない）。
//
// 公開版の manifest.json（buildPublicManifest）:
//   - alarms・idle の権限を外す（自動再読み込みは、パソコン側のビルドを使う開発用の仕組み。auto-update.js は権限がなければ何もしない）
//   - Peter Lowe's list（peterlowe）をルールセットから外す（リスト自体にライセンスの記載がなく、再配布してよいか確かめられないため）
//   - minimum_chrome_version を MIN_CHROME_VERSION にする
//   declarativeNetRequestFeedback は外さない（ポップアップの「ブロック件数」が chrome.declarativeNetRequest.getMatchedRules を使うため）。
//
// 公開版は、lib/support.js の URL の目印（SUPPORT_URL・SOURCE_URL・PRIVACY_URL の値）が実際の URL に置き換わっていないと作れない（findPlaceholders）。
//   --allow-placeholder を付けたときだけ、警告つきで作れる（検証用。ストアには出さないこと）。
//
// zip は外部のパッケージを使わず、Node の zlib で自前に作る（Compress-Archive はパスの区切りが「\」になることがあり、Chrome が拒否するため）。
//
// Copyright (C) 2026 ADBAN contributors. GNU General Public License v3.0 or later.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 公開版に入れないリスト（ライセンスの記載がないもの）
export const EXCLUDED_LISTS = ['peterlowe'];
// 公開版で外す権限
export const REMOVED_PERMISSIONS = ['alarms', 'idle'];
// 公開版の minimum_chrome_version。使っている機能がそろう版（README「公開用パッケージ」を参照）に余裕を見た値
export const MIN_CHROME_VERSION = '120';
// ストアの description の上限
export const MAX_DESCRIPTION = 132;

// 入れるもの（許可リスト）。これ以外は、あっても入れない
const TOP_FILES = ['manifest.json', 'background.js', 'popup-blocker.js', 'auto-update.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md'];
const REQUIRED_FILES = ['manifest.json', 'background.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const DIRS = ['content', 'lib', 'options', 'popup', 'icons', 'resources', 'rules'];
// filters/base.txt は rules/base.json の元（手で書いた ADBAN 基本フィルター。159 行）。GPL v3 で配るので、変換前の元も同梱する
const EXTRA_FILES = ['filters/base.txt'];
// ディレクトリの中でも入れないもの
const SKIP_NAMES = /^(\.|_|node_modules$)|\.log$|\.tmp$|~$/;

// ---- 公開版の manifest.json ----

export function buildPublicManifest(manifest) {
  const m = structuredClone(manifest);
  m.permissions = (m.permissions ?? []).filter((p) => !REMOVED_PERMISSIONS.includes(p));
  m.minimum_chrome_version = MIN_CHROME_VERSION;
  const dnr = m.declarative_net_request;
  if (dnr?.rule_resources) dnr.rule_resources = dnr.rule_resources.filter((r) => !EXCLUDED_LISTS.includes(r.id));
  if (typeof m.description !== 'string' || [...m.description].length > MAX_DESCRIPTION) {
    throw new Error(`description は ${MAX_DESCRIPTION} 文字以内にしてください（今は ${[...(m.description ?? '')].length} 文字）`);
  }
  return m;
}

// rules/meta.json から外したリストの項目を除く（ほかの項目は変えない）
export function filterMeta(meta) {
  return { ...meta, lists: meta.lists.filter((l) => !EXCLUDED_LISTS.includes(l.id)) };
}

// rules/popups.json から外したリストの項目を除く
export function filterPopups(popups) {
  const lists = Object.fromEntries(Object.entries(popups.lists ?? {}).filter(([id]) => !EXCLUDED_LISTS.includes(id)));
  return { ...popups, lists };
}

// 外したリストの rules/ のファイルか（peterlowe.json・peterlowe.cosmetic.json・peterlowe.scriptlets.json・scriptlets/peterlowe.<n>.js）
export const isExcludedRulesFile = (relPath) =>
  EXCLUDED_LISTS.some((id) => new RegExp(`^rules/(scriptlets/)?${id}\\.`).test(relPath));

// Chrome は先頭が「_」のファイル・フォルダーを（_metadata 以外）拒否する
export const forbiddenNames = (paths) =>
  paths.filter((p) => p.split('/').some((seg) => seg.startsWith('_')));

const JSON_LINE = (data) => `${JSON.stringify(data)}\n`;

// ---- ファイルの収集 ----

async function walk(dir, rel, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.test(entry.name)) continue;
    const abs = join(dir, entry.name);
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walk(abs, path, out);
    else if (entry.isFile()) out.push(path);
  }
}

// パッケージに入れるファイルを { パス（/ 区切り）→ Buffer } で返す。manifest.json・meta.json・popups.json は公開版に変換する
export async function collectPackageFiles(srcRoot) {
  const paths = [];
  for (const f of TOP_FILES) if (await exists(join(srcRoot, f))) paths.push(f);
  for (const f of EXTRA_FILES) if (await exists(join(srcRoot, f))) paths.push(f);
  for (const d of DIRS) if (await exists(join(srcRoot, d))) await walk(join(srcRoot, d), d, paths);
  for (const f of REQUIRED_FILES) if (!paths.includes(f)) throw new Error(`必須のファイルがありません: ${f}`);

  const files = new Map();
  for (const p of paths.sort()) {
    if (isExcludedRulesFile(p)) continue;
    const buf = await readFile(join(srcRoot, ...p.split('/')));
    if (p === 'manifest.json') files.set(p, Buffer.from(`${JSON.stringify(buildPublicManifest(JSON.parse(buf.toString('utf8'))), null, 2)}\n`));
    else if (p === 'rules/meta.json') files.set(p, Buffer.from(JSON_LINE(filterMeta(JSON.parse(buf.toString('utf8'))))));
    else if (p === 'rules/popups.json') files.set(p, Buffer.from(JSON_LINE(filterPopups(JSON.parse(buf.toString('utf8'))))));
    else files.set(p, buf);
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---- zip（stored / deflate。パスは「/」） ----

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01（同じ中身から同じ zip ができるよう固定）

export function makeZip(files) {
  const names = [...files.keys()].sort();
  if (names.length > 0xfffe) throw new Error('ファイルが多すぎます');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const data = files.get(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const flags = 0x0800; // 名前は UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 展開に必要な版
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 作った版
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  if (offset + centralBuf.length > 0xfffffffe) throw new Error('zip が 4GB を超えます');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// zip を読み戻して { パス → Buffer } にする。CRC・サイズが合わなければ例外
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip の終端が見つかりません');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip の中央ディレクトリが壊れています');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: ローカルヘッダーが壊れています`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const body = buf.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body);
    else throw new Error(`${name}: 未対応の圧縮方式 ${method}`);
    if (data.length !== size) throw new Error(`${name}: サイズが合いません`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC が合いません`);
    if (files.has(name)) throw new Error(`${name}: 同じ名前が 2 つあります`);
    files.set(name, data);
  }
  return files;
}

// ---- 問題の報告の URL（lib/support.js）の目印 ----

// lib/support.js に残っている、まだ実際の URL に置き換えていない目印の一覧（なければ空）
const PLACEHOLDER_RE = /__(?:SUPPORT|SOURCE|PRIVACY)_URL__/g;
export function findPlaceholders(files) {
  const buf = files.get('lib/support.js');
  if (!buf) return [];
  return [...new Set(buf.toString('utf8').match(PLACEHOLDER_RE) ?? [])];
}

export const placeholderMessage = (found) =>
  `lib/support.js に、実際の URL に置き換えていない目印が残っています: ${found.join(', ')}\n` +
  '公開版を作る前に、これらを実際の URL（サポート窓口・ソースコード・プライバシーポリシーのページ）に置き換えてください。' +
  '検証用に、目印のまま作るときだけ --allow-placeholder を付けます（ストアには出さないこと）。';

// ---- 点検・書き出し ----

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// パッケージの中身（{ パス → Buffer }）の簡単な点検。問題の一覧を返す（ルールの中身の点検は tools/check.mjs --root で行う）
export function inspectPackage(files) {
  const problems = [];
  const paths = [...files.keys()];
  for (const p of forbiddenNames(paths)) problems.push(`先頭が「_」の名前（Chrome が拒否します）: ${p}`);
  for (const p of paths) {
    if (p.includes('\\') || p.startsWith('/') || p.split('/').includes('..')) problems.push(`パスが不正です: ${p}`);
    if (/^(tools|dist|node_modules|\.git)\//.test(p)) problems.push(`入れてはいけないフォルダー: ${p}`);
    if (/\.(log|test\.mjs)$/.test(p)) problems.push(`入れてはいけないファイル: ${p}`);
    if (EXCLUDED_LISTS.some((id) => p.includes(`${id}.`))) problems.push(`公開版に入れないリストのファイル: ${p}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(files.get('manifest.json')?.toString('utf8'));
  } catch (e) {
    problems.push(`manifest.json が JSON として読めません: ${e.message}`);
    return problems;
  }
  for (const p of REMOVED_PERMISSIONS) if (manifest.permissions?.includes(p)) problems.push(`manifest.json に権限 ${p} が残っています`);
  const ids = manifest.declarative_net_request?.rule_resources?.map((r) => r.id) ?? [];
  for (const id of EXCLUDED_LISTS) if (ids.includes(id)) problems.push(`manifest.json に ${id} が残っています`);
  for (const r of manifest.declarative_net_request?.rule_resources ?? []) {
    if (!files.has(r.path)) problems.push(`manifest.json のルールセット ${r.id} のファイルがありません: ${r.path}`);
  }
  if ([...(manifest.description ?? '')].length > MAX_DESCRIPTION) problems.push(`description が ${MAX_DESCRIPTION} 文字を超えています`);
  if (manifest.minimum_chrome_version !== MIN_CHROME_VERSION) problems.push(`minimum_chrome_version が ${MIN_CHROME_VERSION} ではありません`);
  return problems;
}

// 展開済みのパッケージを書き出す（<out>/package/ を作り直す）
export async function writePackageDir(files, packageDir) {
  if (basename(packageDir) !== 'package') throw new Error('消してよいのは「package」という名前のフォルダーだけです');
  await rm(packageDir, { recursive: true, force: true });
  for (const [path, data] of files) {
    const abs = join(packageDir, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }
}

// 展開済みのディレクトリ → { パス → Buffer }
export async function readDirFiles(dir) {
  const paths = [];
  const walkAll = async (d, rel) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walkAll(join(d, entry.name), p);
      else paths.push(p);
    }
  };
  await walkAll(dir, '');
  return new Map(await Promise.all(paths.sort().map(async (p) => [p, await readFile(join(dir, ...p.split('/')))])));
}

// zip を読み戻して、展開済みのディレクトリと一覧・中身（SHA-256）が一致するか確かめる。問題の一覧を返す
export function compareFiles(a, b, labelA = 'A', labelB = 'B') {
  const problems = [];
  for (const p of a.keys()) if (!b.has(p)) problems.push(`${labelB} にない: ${p}`);
  for (const p of b.keys()) if (!a.has(p)) problems.push(`${labelA} にない: ${p}`);
  for (const [p, data] of a) if (b.has(p) && sha256(data) !== sha256(b.get(p))) problems.push(`中身が違う: ${p}`);
  return problems;
}

export async function makePackage({ srcRoot = defaultRoot, outDir = join(srcRoot, 'dist'), zip = true, allowPlaceholder = false } = {}) {
  const files = await collectPackageFiles(srcRoot);
  const placeholders = findPlaceholders(files);
  if (placeholders.length && !allowPlaceholder) throw new Error(placeholderMessage(placeholders));
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const problems = inspectPackage(files);
  const packageDir = join(outDir, 'package');
  await writePackageDir(files, packageDir);
  let zipPath = null;
  let zipBuf = null;
  if (zip) {
    zipPath = join(outDir, `adban-${manifest.version}.zip`);
    zipBuf = makeZip(files);
    await writeFile(zipPath, zipBuf);
    // 書き出したものを読み戻して、展開済みのものと比べる
    const fromZip = readZip(await readFile(zipPath));
    problems.push(...compareFiles(await readDirFiles(packageDir), fromZip, '展開済み', 'zip'));
  }
  return { files, manifest, packageDir, zipPath, zipSize: zipBuf?.length ?? 0, problems, placeholders };
}

// ---- コマンド ----

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : join(defaultRoot, 'dist'));
  const allowPlaceholder = args.includes('--allow-placeholder');
  let result;
  try {
    result = await makePackage({ srcRoot: defaultRoot, outDir, zip: !args.includes('--no-zip'), allowPlaceholder });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  const { files, manifest, problems } = result;

  const total = [...files.values()].reduce((t, b) => t + b.length, 0);
  console.log(`ADBAN ${manifest.version} の公開用パッケージを作りました。`);
  if (result.placeholders.length) console.warn(`警告: 目印が残っています（${result.placeholders.join(', ')}）。検証用です。ストアには出さないでください。`);
  console.log(`  展開済み: ${result.packageDir}（${files.size} ファイル、${fmtSize(total)}）`);
  if (result.zipPath) console.log(`  zip: ${result.zipPath}（${fmtSize(result.zipSize)}）`);

  // フォルダーごとの内訳
  const byDir = new Map();
  for (const [p, b] of files) {
    const top = p.includes('/') ? `${p.split('/')[0]}/` : '(直下)';
    const row = byDir.get(top) ?? { n: 0, size: 0 };
    row.n++;
    row.size += b.length;
    byDir.set(top, row);
  }
  console.log('  内訳:');
  for (const [d, r] of [...byDir].sort()) console.log(`    ${d.padEnd(12)} ${String(r.n).padStart(4)} ファイル  ${fmtSize(r.size)}`);
  console.log(`  権限: ${manifest.permissions.join(', ')}`);
  console.log(`  ルールセット: ${manifest.declarative_net_request.rule_resources.map((r) => r.id).join(', ')}`);

  // ルールの中身の点検（tools/check.mjs と同じ観点。パッケージの展開先に向けて動かす）
  const check = spawnSync(process.execPath, [join(defaultRoot, 'tools', 'check.mjs'), '--root', result.packageDir], { encoding: 'utf8' });
  const checkOk = check.status === 0;
  console.log(`  tools/check.mjs --root: ${checkOk ? '問題なし' : '問題あり'}`);
  if (!checkOk) problems.push(`tools/check.mjs --root が失敗しました:\n${check.stdout}${check.stderr}`);

  if (problems.length) {
    console.error(`\n問題が ${problems.length} 件あります:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\n問題は見つかりませんでした（禁止された名前なし・manifest 正常・zip の読み戻しが展開済みと一致）。');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
