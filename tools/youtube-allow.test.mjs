// lib/youtube-allow.js（YouTube 自身の計測通信を許可する動的ルール）のテスト。  node --test "tools/*.test.mjs"
// ルールの形と、regexFilter が計測通信にだけマッチすることを確かめる。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { youtubeAllowRules } from '../lib/youtube-allow.js';

const IDS = { youtubeFirstParty: 3, youtubeGoogle: 4 };
const [first, google] = youtubeAllowRules(IDS);

test('youtubeAllowRules: action・priority・id・initiatorDomains が仕様どおり', () => {
  const rules = youtubeAllowRules(IDS);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((r) => r.id), [3, 4]);
  for (const r of rules) {
    assert.deepEqual(r.action, { type: 'allow' });
    assert.equal(r.priority, 1000);
    assert.deepEqual(r.condition.initiatorDomains, ['youtube.com', 'youtube-nocookie.com']);
  }
  assert.deepEqual(first.condition.requestDomains, ['youtube.com', 'youtube-nocookie.com']);
});

test('youtubeAllowRules: 実測でブロックされていた URL と、YouTube の検査に使われる URL にマッチする', () => {
  const firstRe = new RegExp(first.condition.regexFilter);
  const googleRe = new RegExp(google.condition.regexFilter);
  for (const url of [
    'https://www.youtube.com/api/stats/qoe?cpn=abc&event=streamingstats',
    'https://www.youtube.com/ptracking?pa=1&cpn=abc',
    'https://www.youtube.com/generate_204',
    // YouTube の検査（FgL / j2s）が使う api/stats/atr（nocookie 側は EasyPrivacy がブロックしていた）と、クエリ付きの qoe
    'https://www.youtube-nocookie.com/api/stats/atr?ns=yt&el=embedded',
    'https://www.youtube.com/api/stats/qoe?fmt=398&afmt=251&cpn=l7KDD5tP-G2_fOTq&el=detailpage&event=streamingstats',
    'https://www.youtube.com/api/stats/ads?ver=2&ns=1',
  ]) assert.ok(firstRe.test(url), url);
  for (const url of [
    'https://www.google.com/pagead/lvz?cid=1',
    'https://www.google.co.jp/pagead/lvz?cid=1',
    'https://www.google.com/pagead/1p-user-list/962985656/',
  ]) assert.ok(googleRe.test(url), url);
});

test('youtubeAllowRules: 無関係な URL にはマッチしない（regexFilter と requestDomains の両方で判定）', () => {
  // Chrome と同じく、requestDomains があればホストがそのドメインか子ドメインであることも条件にする
  const matches = (rule, url) => {
    const { hostname } = new URL(url);
    const { requestDomains, regexFilter } = rule.condition;
    const hostOk = !requestDomains || requestDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    return hostOk && new RegExp(regexFilter).test(url);
  };
  for (const url of [
    'https://www.youtube.com/get_midroll_info',
    'https://www.youtube.com/youtubei/v1/player/ad_break', // 広告の取得そのものは許可しない
    'https://googleads.g.doubleclick.net/pagead/id',
    'https://www.google.com/search?q=pagead/lvz',
    'https://evil.example/ptracking',
  ]) {
    for (const rule of youtubeAllowRules(IDS)) assert.ok(!matches(rule, url), `${rule.id}: ${url}`);
  }
});

test('youtubeAllowRules: ID は 1〜999 で重複しない', () => {
  const ids = youtubeAllowRules(IDS).map((r) => r.id);
  for (const id of ids) assert.ok(Number.isInteger(id) && id >= 1 && id <= 999, String(id));
  assert.equal(new Set(ids).size, ids.length);
});
