// important.js —— mcbot 的「重要记忆」：钉住层，永不压缩、永不删除
//
// 跟 memory.js 的区别（关键就在这）：
//   memory.js  是流水账：留最近 10 条当上下文，10 天外的压成摘要，30 天连摘要一起删
//   important  是钉住的：单独一个文件 mc_important.json，完全不进 memory.js 的
//              compact / purgeOld 流程，只增不减（除非人手动 forget）
//
// 存两类东西：
//   facts     —— 人/事/物：谁、什么属性、什么值。同一个 (subject, attr) 后来再说一次就覆盖，
//                旧值进 prev（「小明的家：杭州（原：北京）」这样能看出改过）
//   relations —— 关系：A —rel→ B。朋友/好友/兄弟这类是对称的，存一条、两边都能查到
//
// 提炼走 LLM，但**不是每句话都提炼**：先用正则粗筛（「我叫」「我家在」「喜欢」「答应」这类），
// 或者玩家明说「记住这个」，才去问模型。不然每条聊天都发一次请求，token 会烧穿。
//
// 字段命名继续对齐 livingmemory（subject / attr / value / importance），将来接共享记忆零返工。

'use strict';
const fs = require('fs');
const path = require('path');

let MEM = null;                                   // 借 memory.js 的 scrub 抹密钥，没有就自己兜
try { MEM = require('./memory.js'); } catch (e) { MEM = null; }

const FILE = 'mc_important.json';
const BAK = 'mc_important.json.bak';              // 每次落盘前留一份，写坏了能回滚
const MAX_FACTS = 300;                            // 硬上限：满了拒收新的（宁可不记，不能偷偷丢老的）
const MAX_RELS = 300;
const MAX_PREV = 3;                               // 一个属性最多留 3 个历史值
const BLOCK_BUDGET = 520;                         // 塞 prompt 的字符预算
const MAX_VALUE = 40;                             // 单个 value 最长多少字
const EXTRACT_COOLDOWN = 90 * 1000;               // 同一个人 90 秒内最多提炼一次（强制除外）

let DIR = __dirname;
let DATA = null;                                  // 内存里的那一份，load() 惰性初始化
let EXTRACTOR = null;                             // LLM 提炼函数，由 play.js 注入
const lastExtract = new Map();                    // player -> 上次提炼时间戳

function setDir(d) { DIR = d || __dirname; DATA = null; }
function getDir() { return DIR; }
function setExtractor(fn) { EXTRACTOR = typeof fn === 'function' ? fn : null; }
function fp(name) { return path.join(DIR, name); }

function log(s) { try { console.log('[important] ' + s); } catch (_) {} }

// ===== 存取 =====

function emptyData() { return { version: 1, facts: [], relations: [] }; }

// 从盘上读坏数据也不该把 bot 搞崩：能救几条救几条，实在不行回滚 .bak
function normalize(o) {
  const d = emptyData();
  if (!o || typeof o !== 'object') return d;
  for (const f of Array.isArray(o.facts) ? o.facts : []) {
    if (!f || !f.subject || !f.attr || !f.value) continue;
    d.facts.push({
      id: String(f.id || ('f' + d.facts.length)),
      key: String(f.key || (f.subject + '|' + f.attr)).toLowerCase(),
      type: f.type || 'fact',
      subject: String(f.subject),
      attr: String(f.attr),
      value: String(f.value),
      ts: Number(f.ts) || 0,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.85,
      pinned: f.pinned !== false,                 // 默认都是钉住的
      source: String(f.source || ''),
      hits: Number(f.hits) || 1,
      prev: Array.isArray(f.prev) ? f.prev.slice(-MAX_PREV) : [],
    });
  }
  // 老文件里可能留着「家 / 住址」这种同义并存，读进来顺手归一 + 合并
  const fmap = new Map();
  for (const f of d.facts) {
    f.attr = normAttr(f.attr);
    f.key = (f.subject + '|' + f.attr).toLowerCase();
    const hit = fmap.get(f.key);
    if (!hit) { fmap.set(f.key, f); continue; }
    const [keep, drop] = (hit.ts || 0) >= (f.ts || 0) ? [hit, f] : [f, hit];
    keep.hits = (keep.hits || 1) + (drop.hits || 1);
    keep.prev = (keep.prev || []).concat([{ value: drop.value, ts: drop.ts }]).slice(-MAX_PREV);
    keep.confidence = Math.max(keep.confidence || 0.85, drop.confidence || 0.85);
    fmap.set(f.key, keep);
  }
  d.facts = [...fmap.values()];
  for (const r of Array.isArray(o.relations) ? o.relations : []) {
    if (!r || !r.a || !r.b || !r.rel) continue;
    d.relations.push({
      id: String(r.id || ('r' + d.relations.length)),
      key: String(r.key || (r.a + '|' + r.rel + '|' + r.b)).toLowerCase(),
      a: String(r.a),
      rel: String(r.rel),
      b: String(r.b),
      sym: !!r.sym,
      ts: Number(r.ts) || 0,
      source: String(r.source || ''),
      note: String(r.note || ''),
    });
  }
  const rmap = new Map();
  for (const r of d.relations) {
    r.rel = normRel(r.rel);
    r.sym = isSym(r.rel);
    r.key = (r.a + '|' + r.rel + '|' + r.b).toLowerCase();
    const revKey = (r.b + '|' + r.rel + '|' + r.a).toLowerCase();
    const hit = rmap.get(r.key) || (r.sym ? rmap.get(revKey) : null);
    if (!hit) { rmap.set(r.key, r); continue; }
    hit.ts = Math.max(hit.ts || 0, r.ts || 0);
    if (r.note) hit.note = r.note;
  }
  d.relations = [...rmap.values()];
  return d;
}

function load() {
  if (DATA) return DATA;
  for (const name of [FILE, BAK]) {               // 主文件坏了就吃备份
    try {
      const raw = fs.readFileSync(fp(name), 'utf8');
      DATA = normalize(JSON.parse(raw));
      if (name === BAK) log('主文件读不了，已用备份 ' + BAK);
      return DATA;
    } catch (e) { /* 接着试下一个 */ }
  }
  DATA = emptyData();
  return DATA;
}

// 落盘：先备份旧的，再原子写。失败只记日志，绝不抛（记忆不能拖垮游戏）
function save() {
  const d = load();
  try {
    if (fs.existsSync(fp(FILE))) {
      try { fs.copyFileSync(fp(FILE), fp(BAK)); } catch (e) {}
    }
    const tmp = fp(FILE) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1), 'utf8');
    fs.renameSync(tmp, fp(FILE));
    return true;
  } catch (e) {
    log('写盘失败：' + e.message);
    return false;
  }
}

// ===== 小工具 =====

function clean(s, max) {
  let t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  t = t.replace(/^[「『"'“”‘’(（]+|[」』"'“”‘’）)]+$/g, '').trim();
  t = t.replace(/[。！？!?，,；;：:]+$/, '').trim();
  if (max && t.length > max) t = t.slice(0, max);
  return t;
}

// 密钥一类的别进记忆（玩家在游戏里把 key 念出来也不该被记住）
function scrubVal(s) {
  if (MEM && typeof MEM.scrub === 'function') return MEM.scrub(s);
  return s;
}

let idSeq = 0;
function newId(p) { return p + Date.now().toString(36) + (idSeq++).toString(36); }

// 对称关系：互为「朋友」的两个人，反过来也成立，所以只存一条，查的时候两边都算
const SYM_REL = ['朋友', '好友', '好朋友', '兄弟', '姐妹', '闺蜜', '队友', '搭档', '邻居',
  '恋人', '情侣', '夫妻', '同学', '同事', '伙伴', '基友'];
function isSym(rel) { return SYM_REL.includes(String(rel || '')); }

// 属性同义词归一：模型今天说「家」明天说「住址」，不归一就会并存两条、
// 搬家了也覆盖不掉旧的。这里都折成同一个 attr，key 才对得上。
const ATTR_ALIAS = {};
function alias(canon, words) { for (const w of words) ATTR_ALIAS[w] = canon; }
alias('家', ['家在', '家在哪', '基地', '落脚点', '据点']);
// 现实世界的地理信息一律不记（泄一句就可能被扒到真人），
// 所以「住址 / 老家 / 城市」这些不归一、直接进黑名单扔掉。
const PRIVATE_ATTR = ['住址', '住处', '住宅', '地址', '住的地方', '住哪', '住在', '老家', '城市',
  '现实城市', '家乡', '籍贯', '学校', '公司', '单位', '工作单位', '手机', '手机号', '电话', '号码',
  '微信', 'QQ号', '真实姓名', '姓名', '身份证', '银行卡', '邮箱'];
// 值是现实地址的样子（「杭州市」「××小区」「××路 12 号」）也不收
const PRIVATE_VAL = /(?:市|省|县|区|镇|乡|村|街道|路|街|巷|号|小区|公寓|大厦|号楼|单元|室)(?:$|[\s，,。]|\d)|^[\u4e00-\u9fa5]{2,4}(?:市|省|县|区)$/;

function isPrivate(attr, value) {
  if (PRIVATE_ATTR.includes(String(attr || ''))) return true;
  return PRIVATE_VAL.test(String(value || ''));
}
alias('生日', ['出生日期', '生日日期', '哪天生日', '生日是哪天', '出生时间']);
alias('年龄', ['岁数', '几岁', '年纪']);
alias('喜欢', ['喜好', '爱好', '喜爱', '喜欢的东西', '最爱']);
alias('名字', ['昵称', '外号', '称呼', '全名']);
alias('工作', ['职业', '上班', '干什么的']);
alias('身份', ['真实身份', '是谁']);

function normAttr(attr) {
  const t = clean(attr, 16) || '备注';
  return ATTR_ALIAS[t] || ATTR_ALIAS[t.replace(/的/g, '')] || t;
}

// 关系同义词归一：好友 / 朋友 / 好朋友 是同一种，不然会存三条各说一遍
const REL_ALIAS = {};
function ralias(canon, words) { for (const w of words) REL_ALIAS[w] = canon; }
ralias('好友', ['朋友', '好朋友', '好哥们', '好友', '死党', '老友']);
ralias('师父', ['师傅', '老师傅']);
ralias('恋人', ['女朋友', '男朋友', '对象', '伴侣']);

function normRel(rel) {
  const t = clean(rel, 8) || '认识';
  return REL_ALIAS[t] || t;
}

// ===== facts：人 / 事 / 物 =====

function addFact(f) {
  const d = load();
  const subject = clean(f.subject, 24);
  const attr = normAttr(f.attr);
  if (!subject) return null;
  const value = scrubVal(clean(f.value, MAX_VALUE));
  if (!value) return null;
  if (isPrivate(attr, value)) { log(`现实信息不收：${subject}.${attr}=${value}`); return null; }

  const key = (subject + '|' + attr).toLowerCase();
  const now = Number(f.ts) || Math.round(Date.now() / 1000);
  const exist = d.facts.find(x => x.key === key);

  if (exist) {
    if (exist.value === value) {                  // 又说了一遍，等于确认：加分、刷新时间
      exist.hits = (exist.hits || 1) + 1;
      exist.ts = now;
      exist.confidence = Math.min(0.99, (exist.confidence || 0.85) + 0.02);
      save();
      return exist;
    }
    // 值变了：旧值进 prev，别直接抹掉（「原来在北京，现在搬杭州了」这种是有用的信息）
    exist.prev = (exist.prev || []).concat([{ value: exist.value, ts: exist.ts }]).slice(-MAX_PREV);
    exist.value = value;
    exist.ts = now;
    exist.confidence = Math.max(exist.confidence || 0.85, f.confidence || 0.85);
    if (f.source) exist.source = String(f.source);
    save();
    log(`${subject} 的${attr}改成「${value}」`);
    return exist;
  }

  if (d.facts.length >= MAX_FACTS) { log(`facts 满了（${MAX_FACTS}），这条没收：${subject}.${attr}`); return null; }
  const rec = {
    id: newId('f'), key, type: f.type || 'fact',
    subject, attr, value, ts: now,
    confidence: typeof f.confidence === 'number' ? f.confidence : 0.85,
    pinned: f.pinned !== false, source: String(f.source || ''),
    hits: 1, prev: [],
  };
  d.facts.push(rec);
  save();
  log(`记住：${subject} 的${attr} = ${value}`);
  return rec;
}

// ===== relations：关系 =====

function addRelation(r) {
  const d = load();
  const a = clean(r.a, 24);
  const b = clean(r.b, 24);
  const rel = normRel(r.rel);
  if (!a || !b || a === b) return null;

  const sym = isSym(rel);
  const key = (a + '|' + rel + '|' + b).toLowerCase();
  // 对称关系反着存过也算同一条（先存了「小明|好友|服主」，再来「服主|好友|小明」不该重复）
  const revKey = (b + '|' + rel + '|' + a).toLowerCase();
  const exist = d.relations.find(x => x.key === key || (sym && x.sym && x.key === revKey));
  const now = Number(r.ts) || Math.round(Date.now() / 1000);

  if (exist) { exist.ts = now; if (r.note) exist.note = clean(r.note, 40); save(); return exist; }
  if (d.relations.length >= MAX_RELS) { log(`relations 满了（${MAX_RELS}），这条没收：${a}-${rel}-${b}`); return null; }

  const rec = {
    id: newId('r'), key, a, rel, b, sym, ts: now,
    source: String(r.source || ''), note: clean(r.note, 40),
  };
  d.relations.push(rec);
  save();
  log(`记住关系：${a} ${sym ? '—' : '→'}${rel}${sym ? '—' : '→'} ${b}`);
  return rec;
}

// ===== 查 / 删 =====

function listFacts(subject) {
  const d = load();
  if (!subject) return d.facts.slice();
  const k = clean(subject, 24).toLowerCase();
  return d.facts.filter(x => x.subject.toLowerCase() === k);
}

// 某个人身上的所有关系：他主动的 + 别人对他（对称关系两边都算）
function listRelations(who) {
  const d = load();
  if (!who) return d.relations.slice();
  const k = clean(who, 24).toLowerCase();
  return d.relations.filter(r => r.a.toLowerCase() === k || (r.sym && r.b.toLowerCase() === k));
}

function forget(sel) {
  const d = load();
  const s = String(sel || '').trim();
  if (!s) return 0;
  const low = s.toLowerCase();
  const before = d.facts.length + d.relations.length;
  d.facts = d.facts.filter(f => f.id !== s && f.key !== low &&
    !(f.subject.toLowerCase() === low));
  d.relations = d.relations.filter(r => r.id !== s && r.key !== low &&
    !(r.a.toLowerCase() === low && r.b.toLowerCase() === low));
  const after = d.facts.length + d.relations.length;
  if (after !== before) save();
  return before - after;
}

// 老存档清扫：黑名单是后加的，之前存进去的现实信息（城市/住址/电话…）
// 得挑出来删掉。只认「属性在黑名单」或「值是地址样式」，不动别的。
// 「1-3 个汉字」当成名字放过，免得把「王路」这种 ID 当地址删了。
function addrLike(v) {
  const t = String(v || '').trim();
  if (!t) return false;
  if (/^[\u4e00-\u9fa5]{1,3}$/.test(t)) return false;
  return PRIVATE_VAL.test(t);
}

function scanPrivate() {
  const d = load();
  const out = [];
  for (const f of d.facts) {
    if (isPrivate(f.attr, f.value)) {
      out.push({ kind: 'fact', id: f.id, who: f.subject, what: f.attr, value: f.value, ts: f.ts });
      continue;
    }
    const old = (f.prev || []).find(pv => isPrivate(f.attr, pv.value));
    if (old) out.push({ kind: 'fact', id: f.id, who: f.subject, what: f.attr, value: old.value, ts: old.ts, old: true });
  }
  for (const r of d.relations) {
    if (addrLike(r.b)) out.push({ kind: 'rel', id: r.id, who: r.a, what: r.rel, value: r.b, ts: r.ts });
    else if (addrLike(r.note)) out.push({ kind: 'rel', id: r.id, who: r.a, what: r.rel, value: r.note, ts: r.ts, noteOnly: true });
  }
  return out;
}

// 真删。传 dry=true 只算不删。
function prunePrivate(dry) {
  const hits = scanPrivate();
  if (dry || !hits.length) return { removed: 0, hits };
  const badFact = new Set(hits.filter(h => h.kind === 'fact' && !h.old).map(h => h.id));
  const prevFix = new Set(hits.filter(h => h.kind === 'fact').map(h => h.id));
  const badRel = new Set(hits.filter(h => h.kind === 'rel' && !h.noteOnly).map(h => h.id));
  const noteRel = new Set(hits.filter(h => h.noteOnly).map(h => h.id));
  const d = load();
  for (const f of d.facts) {
    // 条目本身是地址就整条删；只是历史值脏，就只清历史值
    if (!prevFix.has(f.id)) continue;
    f.prev = (f.prev || []).filter(p => !isPrivate(f.attr, p.value));
  }
  d.facts = d.facts.filter(f => !badFact.has(f.id));
  for (const r of d.relations) if (noteRel.has(r.id)) delete r.note;
  d.relations = d.relations.filter(r => !badRel.has(r.id));
  save();
  return { removed: hits.length, hits };
}

function stats() {
  const d = load();
  const people = new Set();
  for (const f of d.facts) people.add(f.subject.toLowerCase());
  for (const r of d.relations) { people.add(r.a.toLowerCase()); if (r.sym) people.add(r.b.toLowerCase()); }
  return { facts: d.facts.length, relations: d.relations.length, people: people.size };
}

// ===== 拼成 prompt 的一段 =====
// 关键：**按人分开注入**。跟小明说话就只垫小明的记忆 + 跟他有关的关系，
// 绝不把小红小华的住址生日一起塞进去——聊天串人是很要命的事。
// 想记「所有人都该知道的」（服规、世界设定），subject 写成 世界/服务器/大家 就行。
const GLOBAL_SUBJECTS = new Set(['世界', '服务器', '全体', '大家', '服规', '所有人']);

// who 传当前对话人；不传就只出全局那几条
function block(who, budget) {
  const d = load();
  if (!d.facts.length && !d.relations.length) return '';
  const cap = Math.max(120, budget || BLOCK_BUDGET);
  const k = clean(who, 24).toLowerCase();

  const facts = d.facts.filter(f => {
    const s = f.subject.trim();
    return (k && s.toLowerCase() === k) || GLOBAL_SUBJECTS.has(s) || GLOBAL_SUBJECTS.has(s.toLowerCase());
  });
  // 关系只取「有他参与」的：对端只是被提到，不是被扒档案
  const rels = k ? d.relations.filter(r => r.a.toLowerCase() === k || r.b.toLowerCase() === k) : [];
  if (!facts.length && !rels.length) return '';

  const rank = (x) => (x.confidence || 0.85) * 1.0 + Math.min(x.hits || 1, 5) * 0.06;
  facts.sort((a, b) => rank(b) - rank(a));
  rels.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const head = who
    ? `【重要记忆·关于${who}，钉住的，不许说不知道】\n`
    : '【重要记忆·服务器通用，钉住的，不许说不知道】\n';
  const lines = [];
  let used = head.length;
  const push = (s) => {
    if (used + s.length + 1 > cap) return false;
    lines.push(s);
    used += s.length + 1;
    return true;
  };

  // 关系排前面：人跟人怎么连的，比零碎属性更决定该怎么称呼、怎么说话
  for (const r of rels) {
    const isA = r.a.toLowerCase() === k;
    const other = isA ? r.b : r.a;
    let line;
    if (r.sym) line = `你和${other}是${r.rel}`;
    else line = isA ? `你是${r.b}的${r.rel}` : `${r.a}是你的${r.rel}`;
    if (!push('·' + line + (r.note ? `（${r.note}）` : ''))) break;
  }
  for (const f of facts) {
    const s = f.subject.trim();
    const global = GLOBAL_SUBJECTS.has(s) || GLOBAL_SUBJECTS.has(s.toLowerCase());
    // 是自己的事就说「你的」，比「小明的家」自然得多
    if (!push('·' + (global ? `${f.attr}：${f.value}` : `你的${f.attr}：${f.value}`))) break;
  }
  if (!lines.length) return '';
  return head + lines.join('\n');
}

// ===== LLM 提炼 =====

// 粗筛：这几类话才值得花一次请求去提炼
const HINT = new RegExp([
  '记住', '记一下', '别忘', '记牢',
  '我叫', '我的名字', '我是', '本人',
  '我家', '我住', '住在', '老家', '地址',
  '生日', '几岁', '年龄',
  '喜欢', '讨厌', '不爱', '爱吃', '爱喝', '不吃', '不喝',
  '答应', '约好', '说好', '承诺', '保证',
  '是.{0,12}的(?:朋友|好友|兄弟|姐妹|闺蜜|队友|搭档|邻居|老婆|老公|对象|女朋友|男朋友|妈妈|爸爸|父母|姐姐|妹妹|哥哥|弟弟|师父|师傅|徒弟|学生|老师|老板|老大|服主|管理员|群主)',
  '认识', '加个好友',
].join('|'));

function looksImportant(t) { return HINT.test(String(t || '')); }

const EXTRACT_SYS = '你从 Minecraft 聊天里抽「值得长期记住」的信息，只输出 JSON，不要解释。\n' +
  '格式：{"facts":[{"subject":"小明","attr":"家","value":"主城东边红顶木屋 320,68,-112"}],"relations":[{"a":"小明","rel":"好友","b":"服主"}]}\n' +
  '规则：\n' +
  '1. 只抽稳定的：身份、名字、基地位置、生日、口味喜好、习惯、长期约定、重要经过。\n' +
  '1b. 「家」一律指游戏里他自己的房子/基地——写位置、外观、坐标，比如「出生点北边河对岸的木屋 210,64,-88」。\n' +
  '1c. 现实世界的个人信息一律不抽：城市、住址、学校、公司、电话、真实姓名、社交账号，' +
  '哪怕他主动说、让你记住，也不抽不记。这类话当没听见。\n' +
  '2. 一次性的话、情绪、玩笑（除非明显是认真的约定）一律不抽。\n' +
  '3. relations 里「A是B的XX」就写成 a=A, rel=XX, b=B；rel 要短（2-4 字）。\n' +
  '4. 方向别搞反：rel 的含义是「a 是 b 的 rel」。「我叫他师父」= a=他, rel=师父, b=我；反过来写就错了。\n' +
  '5. 第一人称的「我」一律换成「玩家名」里那个人，facts 的 subject 和 relations 的 a/b 都不要出现「我」。\n' +
  '6. 主语是服务器/所有人共有的（服规、约定、出生点），subject 写「世界」。\n' +
  '7. attr 尽量用这几个词：家、生日、年龄、喜欢、名字、工作、身份、备注；实在没有合适的再用两三个字的短词。\n' +
  '8. rel 尽量用这几个词：好友、师徒、徒弟、恋人、队友、邻居、同学、同事、老板、下属、管理员、服主。\n' +
  '9. facts 的 value 不超过 20 字，别写整句。\n' +
  '10. 什么都没抽到就输出 {"facts":[],"relations":[]}。\n' +
  '11. 不许编，只抽话里真的说了的。';

// 模型经常裹 ```json 或者前后带解释，这里把第一个完整的 {...} 揪出来
function pickJson(s) {
  const t = String(s || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{');
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; } } }
  }
  return null;
}

// 把模型吐出来的东西落库。返回实际记住的条数
function applyExtracted(obj, ctx) {
  const out = { facts: 0, relations: 0 };
  if (!obj || typeof obj !== 'object') return out;
  const source = (ctx && ctx.source) || '';
  const ts = (ctx && ctx.ts) || Math.round(Date.now() / 1000);

  for (const f of Array.isArray(obj.facts) ? obj.facts.slice(0, 8) : []) {
    if (!f || !f.subject || !f.value) continue;
    const r = addFact({
      subject: f.subject, attr: f.attr || '备注', value: f.value,
      type: f.type || 'fact', ts, source,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.85,
    });
    if (r) out.facts++;
  }
  for (const r of Array.isArray(obj.relations) ? obj.relations.slice(0, 8) : []) {
    if (!r || !r.a || !r.b) continue;
    const x = addRelation({ a: r.a, rel: r.rel, b: r.b, ts, source, note: r.note });
    if (x) out.relations++;
  }
  return out;
}

// 直接喂一段话去提炼（force=true 跳过粗筛）
async function extract(player, text, force) {
  if (!EXTRACTOR) return null;
  const body = String(text || '').trim();
  if (!body) return null;
  let raw;
  try {
    raw = await EXTRACTOR({ player: player || '', text: body, sys: EXTRACT_SYS });
  } catch (e) {
    log('提炼失败：' + (e.message || e));
    return null;
  }
  const obj = pickJson(raw);
  if (!obj) return null;
  const got = applyExtracted(obj, { source: player ? player + '说的' : '', ts: Math.round(Date.now() / 1000) });
  if (got.facts || got.relations) log(`提炼到 ${got.facts} 条事实、${got.relations} 条关系`);
  return got;
}

// 每句话都会走这里：先粗筛，再限流，最后才花 token
async function consider(player, text, force) {
  if (!EXTRACTOR) return null;
  const t = String(text || '');
  if (!t.trim()) return null;
  if (!force && !looksImportant(t)) return null;
  const k = String(player || '').toLowerCase();
  const now = Date.now();
  if (!force && now - (lastExtract.get(k) || 0) < EXTRACT_COOLDOWN) return null;
  lastExtract.set(k, now);
  return extract(player, t, force);
}

module.exports = {
  setDir, getDir, setExtractor,
  load, save, block, stats,
  addFact, addRelation, listFacts, listRelations, forget,
  isPrivate, scanPrivate, prunePrivate,
  extract, consider, applyExtracted, looksImportant, pickJson,
  isSym, scrubVal,
  FILE, BAK, MAX_FACTS, MAX_RELS, BLOCK_BUDGET, EXTRACT_SYS,
};
