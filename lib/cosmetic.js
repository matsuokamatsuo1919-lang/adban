// 要素隠しのデータ（rules/*.cosmetic.json と自分で追加したフィルター）をまとめ、
// ページごとに差し込む CSS を作る。service worker の中で使う。

import { entityChain, hostChain } from './hosts.js';
import { parseProcedural } from './filters.js';

export const hideRule = (selector) => `${selector}{display:none!important}`;

// 「選択子:style(宣言)」→ CSS のルール。宣言は lib/filters.js の isUsableStyle で確かめてある。
export const styleRule = (key) => {
  const m = /^(.+?):style\((.+)\)$/.exec(key);
  return m ? `${m[1]}{${m[2]}}` : '';
};

// 選択子 1 つにつき 1 ルールにする。まとめると、1 つでも無効な選択子があったときにルール全体が効かなくなるため。
const toCss = (selectors) => selectors.map(hideRule).join('\n');

export class CosmeticEngine {
  constructor(datasets) {
    this.classes = new Set();
    this.ids = new Set();
    const complex = new Set();
    this.specific = new Map();
    this.styles = new Map();
    this.procedural = new Map();
    this.programs = new Map(); // 手続き型の選択子（文字）→ プログラム（parseProcedural の結果）
    this.exceptions = new Map();
    this.genericHide = new Set();
    this.elemHide = new Set();

    for (const d of datasets) {
      if (!d) continue;
      for (const c of d.classes ?? []) this.classes.add(c);
      for (const i of d.ids ?? []) this.ids.add(i);
      for (const s of d.complex ?? []) complex.add(s);
      mergeInto(this.specific, d.specific);
      mergeInto(this.styles, d.styles);
      mergeInto(this.procedural, d.procedural);
      mergeInto(this.exceptions, d.exceptions);
      for (const h of d.genericHide ?? []) this.genericHide.add(h);
      for (const h of d.elemHide ?? []) this.elemHide.add(h);
    }
    this.complex = [...complex];
    this.complexCss = toCss(this.complex);
    this.contexts = new Map();
  }

  context(host) {
    let ctx = this.contexts.get(host);
    if (!ctx) {
      // example.* のようなエンティティの指定も、ホスト名の鍵として同じ表で引く
      const chain = [...hostChain(host), ...entityChain(host)];
      const exceptions = new Set();
      for (const h of chain) for (const s of this.exceptions.get(h) ?? []) exceptions.add(s);
      const elemHide = chain.some((h) => this.elemHide.has(h));
      const genericHide = elemHide || chain.some((h) => this.genericHide.has(h));
      const pick = (map) => {
        const out = new Set();
        if (!elemHide) for (const h of chain) for (const s of map.get(h) ?? []) if (!exceptions.has(s)) out.add(s);
        return [...out];
      };
      const styles = pick(this.styles);
      // :style() で見た目を指定している選択子は、後から届く class / id の隠すルールで上書きしない
      const styled = new Set(styles.map((key) => key.slice(0, key.indexOf(':style('))));
      const programs = pick(this.procedural).flatMap((key) => this.programsOf(key));
      ctx = { exceptions, elemHide, genericHide, specific: pick(this.specific), styles, styled, programs };
      if (this.contexts.size >= 200) this.contexts.clear();
      this.contexts.set(host, ctx);
    }
    return ctx;
  }

  programsOf(key) {
    if (!this.programs.has(key)) this.programs.set(key, parseProcedural(key)?.programs ?? []);
    return this.programs.get(key);
  }

  /** このホストで content/procedural.js に評価させる、手続き型のプログラムの配列。 */
  proceduralFor(host) {
    return this.context(host).programs;
  }

  /** ページを開いたときに入れる CSS（全サイト共通の複雑な選択子 + そのサイト向けの選択子と :style()）。 */
  pageCss(host) {
    const { exceptions, elemHide, genericHide, specific, styles } = this.context(host);
    if (elemHide) return '';
    const parts = [];
    if (!genericHide) {
      parts.push(exceptions.size ? toCss(this.complex.filter((s) => !exceptions.has(s))) : this.complexCss);
    }
    parts.push(toCss(specific));
    // :style() は隠すルールより後に置く（同じ強さなら後のものが勝つ）
    parts.push(styles.map(styleRule).filter(Boolean).join('\n'));
    return parts.filter(Boolean).join('\n');
  }

  /** ページで見つかった class / id のうち、隠す対象になっているものの CSS。 */
  tokenCss(host, classes, ids) {
    const { exceptions, genericHide, styled } = this.context(host);
    if (genericHide) return '';
    const selectors = [];
    const usable = (s) => !exceptions.has(s) && !styled.has(s);
    for (const c of classes) if (this.classes.has(c) && usable(`.${c}`)) selectors.push(`.${c}`);
    for (const i of ids) if (this.ids.has(i) && usable(`#${i}`)) selectors.push(`#${i}`);
    return toCss(selectors);
  }

  usesTokens(host) {
    return !this.context(host).genericHide;
  }
}

function mergeInto(map, object) {
  for (const [key, values] of Object.entries(object ?? {})) {
    if (!map.has(key)) map.set(key, new Set());
    const set = map.get(key);
    for (const v of values) set.add(v);
  }
}
