// ページ側（MAIN world）で動く content script の「拡張機能のエラー」対策のテスト。  node --test "tools/*.test.mjs"
// ページが呼んだ fetch の失敗などで、stack の先頭がこれらのファイルのフレームになると、Chrome は
// 先頭のフレームの URL が chrome-extension:// のときにその拡張機能のエラーとして記録する。
// ファイルの最後の `//# sourceURL=` で、フレームの URL を拡張機能のものでなくしておく。
// 名前に拡張機能の名前（adban）を入れない。ページが e.stack を読んだときに、ブロッカーの手がかりになってしまうため。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const FILES = {
  'content/scriptlets.js': 'inline-0.js',
  'content/yt-main.js': 'inline-1.js',
};
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

for (const [file, sourceUrl] of Object.entries(FILES)) {
  test(`${file} は最後に sourceURL（${sourceUrl}）を持つ`, () => {
    const lines = read(file).split(/\r?\n/).filter((l) => l.trim() !== '');
    assert.equal(lines.at(-1), `//# sourceURL=${sourceUrl}`);
  });

  test(`${file} の sourceURL は拡張機能の URL ではなく、実際の stack に反映される`, () => {
    // 末尾の sourceURL が効くことを、V8 で実際に動かして確かめる（vm でも同じ V8 の仕組み）
    const source = `(() => { try { null.x; } catch (e) { return e.stack; } })();\n${read(file).split(/\r?\n/).filter((l) => l.startsWith('//# sourceURL=')).join('\n')}`;
    const stack = vm.runInNewContext(source, {}, { filename: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' + file });
    assert.match(stack, new RegExp(sourceUrl.replace('.', '\\.')));
    assert.doesNotMatch(stack, /chrome-extension:\/\//);
  });
}

test('sourceURL の行は 1 つだけ（複数あると最後のものが使われ、意図がわかりにくい）', () => {
  for (const file of Object.keys(FILES)) {
    assert.equal(read(file).split(/\r?\n/).filter((l) => l.startsWith('//# sourceURL=')).length, 1, file);
  }
});
