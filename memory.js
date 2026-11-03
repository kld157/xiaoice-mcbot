// memory.js —— mcbot 的轻量长期记忆（零依赖，跨平台）
// 存：一天一个文件 mc_memory-YYYY-MM-DD.jsonl，JSONL 追加写，一行一条
// 取：最近 N 条（默认 10）当上下文 + 按这句话里的词去翻旧账（A 检索）
// 压：过了 10 天的原文攒够 30 条压成摘要（原文随即删）；摘要活到第 30 天（C 压缩）
// 字段刻意对齐 livingmemory（importance / topics / key_facts），将来接共享记忆时零返工

'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = __dirname;
const FILE_PREFIX = 'mc_memory-';       // mc_memory-2026-11-03.jsonl
const FILE_EXT = '.jsonl';
const LEGACY_FILE = 'mc_memory.jsonl';  // 老的单文件，还能读；下次重写会自动拆进当天文件

const DEFAULT_KEEP = 10;          // 同一个玩家留最后 10 条当上下文
const MAX_LINES = 4000;           // 单个日文件超了就砍掉前半，防止无限长
const BUDGET_CHARS = 620;         // 塞进 prompt 的字符预算，别把 token 吃光
const RECALL_N = 3;               // 检索最多补几条旧记忆
const COMPACT_TRIGGER = 30;       // 窗口外攒够 30 条才压一次
const COMPACT_BATCH = 60;         // 一次最多压多少条，别一口气把 300 条塞进 prompt
const RAW_DAYS = 10;              // 原文只留 10 天，过了就压成摘要、原文从盘上删
const SUM_DAYS = 30;              // 摘要留到「对话发生」后 30 天（原文 10 天 + 摘要 20 天）
const HARD_DAYS = 30;             // 兜底：压缩失败/没总结器时，原文最多拖到 30 天才删，别把话丢了
const FORCE_DAYS = 12;            // 兜底：最老的未压缩原文超过 12 天，不管够不够 30 条都先压
const KEEP_DAYS = RAW_DAYS;       // 兼容旧名字
const COMPACT_COOLDOWN = 5 * 60 * 1000;

let MEM_DIR = DEFAULT_DIR;       // 日文件放哪
let FIXED = null;                // 测试用：固定单文件（设了就退回老行为）
let boot = null;                 // 启动时读进来的索引：player -> [entry...]
let SUMM = null;                 // 摘要函数，由 play.js 注入（没注入就不压缩）

function setDir(d) { MEM_DIR = d || DEFAULT_DIR; boot = null; }
function setFile(p) { FIXED = p || null; boot = null; }   // 兼容老调用：固定单文件
function getDir() { return MEM_DIR; }
function setSummarizer(fn) { SUMM = typeof fn === 'function' ? fn : null; }

function norm(p) { return String(p || '').trim().toLowerCase(); }

// 落盘前先抹掉长得像密钥的东西：玩家在游戏里把 key 念出来，也不该被记住
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, false],                       // OpenAI / DeepSeek 等
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, false],    // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, false],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, false],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, false],               // 一长串乱码（hex/base64 风格的 token）
  // 「密码是 xxx」「key: xxx」这种：保留前缀，只抹值
  [/((?:密码|口令|密钥|秘钥|key|token|secret|api[_-]?key)\s*[:：=是为]?\s*)\S{6,}/gi, true],
];

function scrub(s) {
  let t = String(s == null ? '' : s);
  for (const [re, keepPrefix] of SECRET_PATTERNS) {
    // 有捕获组的保留前缀（「密码是」这种），没有的直接整段替换
    // 注意：没捕获组时回调第二个参数是 offset，别拿它当前缀
    t = keepPrefix ? t.replace(re, (m, pre) => pre + '[已隐去]') : t.replace(re, '[已隐去]');
  }
  return t;
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(ts) {
  const d = new Date((ts || Math.round(Date.now() / 1000)) * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 这条记录该落在哪：有 ts 就按 ts 那天的文件，没有就落今天
function dayFile(ts) {
  if (FIXED) return FIXED;
  return path.join(MEM_DIR, FILE_PREFIX + ymd(ts) + FILE_EXT);
}

// 要读的文件清单：所有日文件（文件名带日期，字典序就是时间序）+ 老单文件
function listFiles() {
  if (FIXED) return [FIXED];
  const out = [];
  try {
    for (const f of fs.readdirSync(MEM_DIR)) {
      if (f.startsWith(FILE_PREFIX) && f.endsWith(FILE_EXT)) out.push(path.join(MEM_DIR, f));
    }
  } catch (e) { /* 目录不在就当没记忆 */ }
  out.sort();
  const legacy = path.join(MEM_DIR, LEGACY_FILE);
  try { if (fs.existsSync(legacy)) out.push(legacy); } catch (e) {}
  return out;
}

function readFileInto(idx, file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }   // 读坏了就跳过
    if (!rec || !rec.player) continue;
    const k = norm(rec.player);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(rec);
  }
}

// 所有日文件读进内存索引，按 ts 排序（哪天写的都串成一条时间线）
function loadAll() {
  if (boot) return boot;
  const idx = new Map();
  for (const f of listFiles()) readFileInto(idx, f);
  for (const arr of idx.values()) arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  boot = idx;
  return boot;
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 追加一条。写盘失败只记日志，不抛（记忆不能拖垮游戏）
function remember(player, text, opts) {
  const o = opts || {};
  const body = scrub(String(text == null ? '' : text)).replace(/\s+/g, ' ').trim();
  if (!body) return null;
  const rec = {
    ts: typeof o.ts === 'number' ? o.ts : Math.round(Date.now() / 1000),
    player: String(player || '?'),
    role: o.role || 'player',           // player | bot | event
    text: body.slice(0, 200),
    importance: typeof o.importance === 'number' ? o.importance : 0.5,
    topics: Array.isArray(o.topics) ? o.topics.slice(0, 5) : [],
    key_facts: Array.isArray(o.key_facts) ? o.key_facts.slice(0, 5) : [],
  };
  if (o.sum) rec.sum = 1;               // 标记：这条是压缩出来的摘要
  const idx = loadAll();          // 先把索引建好：否则 loadAll 会把刚落盘的这条也读进来，变两条
  const file = dayFile(rec.ts);   // 落到今天那个文件，跨零点自动换
  try {
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    try { console.log('[memory] write fail: ' + e.message); } catch (_) {}
    return rec;
  }
  const k = norm(rec.player);
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k).push(rec);
  trimFileIfNeeded(file);
  return rec;
}

// 单个日文件太长就裁：读回、留后半、重写
const lastTrim = new Map();
function trimFileIfNeeded(file) {
  const t = lastTrim.get(file) || 0;
  if (Date.now() - t < 60000) return;
  lastTrim.set(file, Date.now());
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const kept = lines.slice(Math.floor(lines.length / 2));
    writeAtomic(file, kept.join('\n') + '\n');
    boot = null;                                  // 索引重建
  } catch (e) { /* 裁失败无所谓，下轮再试 */ }
}

// 按 ts 把内存索引分回各天的文件重写（改字段、删条目都靠它落盘）
function rewriteAll() {
  const idx = loadAll();
  const groups = new Map();
  const now = Math.round(Date.now() / 1000);
  for (const arr of idx.values()) {
    for (const r of arr) {
      const fp = dayFile(r.ts || now);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp).push(r);
    }
  }
  for (const [fp, list] of groups) {
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    try { writeAtomic(fp, list.map(r => JSON.stringify(r)).join('\n') + '\n'); }
    catch (e) { try { console.log('[memory] rewrite fail: ' + e.message); } catch (_) {} }
  }
  if (!FIXED) {
    for (const fp of listFiles()) {               // 清掉被搬空的日文件 + 老单文件
      if (!groups.has(fp)) { try { fs.unlinkSync(fp); } catch (e) {} }
    }
  }
  boot = idx;
}

// 同一个玩家的最后 n 条
function recent(player, n) {
  const want = Math.max(1, Math.min(50, n || DEFAULT_KEEP));
  const idx = loadAll();
  const arr = idx.get(norm(player)) || [];
  return arr.slice(-want);
}

// ===== A：按关键词翻旧账 =====
// 中文没有空格，切双字（bigram）就够用；英文/数字按词切
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '们', '啊', '吗', '呢', '吧',
  'the', 'and', 'you', 'me', 'is', 'to', 'we', 'it']);

function toks(s) {
  const t = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) if (!STOP.has(w)) out.add(w);
  for (const run of t.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return out;
}

function scoreOf(rec, q, now) {
  let hit = 0;
  const rt = toks(rec.text);
  for (const t of q) if (rt.has(t)) hit++;
  const tagText = toks((rec.topics || []).join(' '));
  const factText = toks((rec.key_facts || []).join(' '));
  let factHit = 0;
  for (const t of q) { if (tagText.has(t)) hit += 0.5; if (factText.has(t)) factHit++; }
  if (hit < 1 && factHit < 1) return 0;                  // 一个词都不沾就别硬塞
  let s = Math.min(hit, 6) * 1.0 + Math.min(factHit, 3) * 1.5;
  s += (typeof rec.importance === 'number' ? rec.importance : 0.5) * 0.8;
  const days = Math.max(0, (now - (rec.ts || 0)) / 86400);
  s += 0.6 / (1 + days / 7);                             // 越新越容易被想起来
  if (rec.sum) s += 0.3;                                 // 摘要带上，省得重复讲
  return s;
}

// 翻：跳过最近 keep 条（那些已经在上下文里了）
function recall(player, query, n, keep) {
  const q = toks(query);
  if (!q.size) return [];
  const arr = loadAll().get(norm(player)) || [];
  const cut = Math.max(0, arr.length - (keep == null ? DEFAULT_KEEP : keep));
  const now = Math.round(Date.now() / 1000);
  const scored = [];
  for (let i = 0; i < cut; i++) {
    const s = scoreOf(arr[i], q, now);
    if (s > 0) scored.push({ r: arr[i], s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, Math.max(1, n || RECALL_N)).map(x => x.r);
}

// ===== C：把滑出窗口的旧对话压成一条摘要 =====
const lastCompact = new Map();

function who(r) {
  return r.role === 'bot' ? '你' : (r.role === 'event' ? '（发生）' : r.player);
}

// 原文留 10 天、摘要留到第 30 天，到点从盘上删；整天的老文件会被搬空后自动消失
let lastPurge = 0;
function purgeOld() {
  if (Date.now() - lastPurge < 3600 * 1000) return 0;   // 一小时查一次够了
  lastPurge = Date.now();
  const now = Math.round(Date.now() / 1000);
  const rawLim = now - RAW_DAYS * 86400;    // 原文：比这早的，压过了就删
  const hardLim = now - HARD_DAYS * 86400;  // 原文：比这早的，压没压过都删（兜底）
  const sumLim = now - SUM_DAYS * 86400;    // 摘要：比这早的删掉，一共只存 30 天
  const idx = loadAll();
  let dropped = 0;
  for (const [k, arr] of idx) {
    const kept = arr.filter(r => {
      if (r.sum) return (r.ts || 0) >= sumLim;
      if ((r.ts || 0) >= rawLim) return true;   // 10 天内，原文照留
      if (r.arch) return false;                 // 过了 10 天且已进摘要 -> 原文删掉
      return (r.ts || 0) >= hardLim;            // 没压成的先兜着，最多到 30 天
    });
    if (kept.length === arr.length) continue;
    dropped += arr.length - kept.length;
    if (kept.length) idx.set(k, kept); else idx.delete(k);
  }
  if (dropped) rewriteAll();          // 落盘：文件真的变少
  return dropped;
}

// 该压的：过了 10 天、还没压过的原文（原文压完就删，摘要替它继续活到第 30 天）
function pending() {
  const rawLim = Math.round(Date.now() / 1000) - RAW_DAYS * 86400;
  const out = [];
  for (const arr of loadAll().values()) {
    for (const r of arr) {
      if (!r.sum && !r.arch && (r.ts || 0) < rawLim) out.push(r);
    }
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

async function compact(player, list) {
  if (!SUMM || !list || !list.length) return null;
  const batch = list.slice(0, COMPACT_BATCH);       // 一次压一批，剩下的下轮再说
  const lines = batch.map(r => `${who(r)}：${r.text}`);
  let sum = '';
  try {
    sum = await SUMM(lines, player);
  } catch (e) {
    lastCompact.delete(norm(player));      // 失败就早点重试
    return null;
  }
  sum = String(sum || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!sum) { lastCompact.delete(norm(player)); return null; }
  for (const r of batch) r.arch = 1;       // 原文压缩完就不再留着（purgeOld 会把它们删掉）
  rewriteAll();                            // 落盘：arch 标记按日期写回各天文件
  // 摘要的时间戳用这批里最新的一条：等于「对话发生」的时间，
  // 这样它自己还能再活 20 天，到第 30 天跟原文一起走
  const lastTs = batch[batch.length - 1].ts || Math.round(Date.now() / 1000);
  const rec = remember(player, sum, {
    role: 'event', importance: 0.85, topics: ['摘要'], sum: 1, ts: lastTs,
  });
  try { console.log(`[memory] 压缩 ${batch.length} 条 -> 摘要：${sum.slice(0, 40)}`); } catch (_) {}
  return rec;
}

// 每个玩家「过了 10 天还没压」的原文，按时间升序排好
function pendingByPlayer() {
  const rawLim = Math.round(Date.now() / 1000) - RAW_DAYS * 86400;
  const m = new Map();
  for (const arr of loadAll().values()) {
    for (const r of arr) {
      if (r.sum || r.arch || (r.ts || 0) >= rawLim) continue;
      const k = norm(r.player);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return m;
}

// 由 play.js 在说完话后顺手调，不阻塞：条件不够就立刻返回
async function maybeCompact(player, keep) {
  if (!SUMM) return null;
  purgeOld();                       // 到期的原文/摘要先清（不会动没压过的原文）
  const groups = pendingByPlayer();
  if (!groups.size) return null;
  const now = Math.round(Date.now() / 1000);
  const ready = [];
  for (const [k, arr] of groups) {
    const age = (now - (arr[0].ts || now)) / 86400;
    // 30 条一压；但如果最老那条已经压了 12 天，就不等够数了，免得过期被兜底删掉
    if (arr.length >= COMPACT_TRIGGER || age >= FORCE_DAYS) ready.push({ k, arr, age });
  }
  if (!ready.length) return null;
  const me = norm(player);
  // 先压说话的人；没说话的那些也别忘了（按最老的先来），一轮最多两批，别把请求堆起来
  ready.sort((a, b) => (b.k === me ? 1 : 0) - (a.k === me ? 1 : 0) || b.age - a.age);
  let out = null;
  for (const pick of ready.slice(0, 2)) {
    if (Date.now() - (lastCompact.get(pick.k) || 0) < COMPACT_COOLDOWN) continue;
    lastCompact.set(pick.k, Date.now());
    out = await compact(pick.arr[0].player, pick.arr) || out;
  }
  return out;
}

// 拼成 prompt 里的一小段；没记忆就返回空串（调用方不用特判）
// query 可选：传了就先翻一遍旧账，把相关的垫在最前面
function block(player, n, query) {
  const keep = Math.max(1, Math.min(50, n || DEFAULT_KEEP));
  const list = recent(player, keep);
  const old = query ? recall(player, query, RECALL_N, keep) : [];
  if (!list.length && !old.length) return '';
  const head = `【你记得关于 ${player} 的事】\n`;
  const body = [];
  let used = head.length;
  const push = (seg) => {
    if (used + seg.length + 1 > BUDGET_CHARS) return false;
    body.push(seg);
    used += seg.length + 1;
    return true;
  };
  if (old.length) {
    const capOld = used + Math.floor(BUDGET_CHARS * 0.4);   // 旧账最多吃四成预算，别把最近的话挤出去
    push('（早点聊到的）');
    for (const r of old) {
      if (used + r.text.length + 8 > capOld) break;
      push(`${who(r)}：${r.text}`);
    }
  }
  if (old.length && list.length) push('（最近）');
  for (const r of list) if (!push(`${who(r)}：${r.text}`)) break;
  if (!body.length) return '';
  return head + body.join('\n');
}

// 记一轮对话：玩家说了啥 + 你回了啥
function rememberExchange(player, userText, botText) {
  if (userText) remember(player, userText, { role: 'player' });
  if (botText) remember(player, botText, { role: 'bot' });
}

module.exports = {
  remember, rememberExchange, recent, block, recall, compact, maybeCompact, purgeOld,
  setFile, setDir, getDir, setSummarizer, listFiles, pendingByPlayer, scrub,
  DEFAULT_KEEP, BUDGET_CHARS, RECALL_N, COMPACT_TRIGGER, COMPACT_BATCH,
  RAW_DAYS, SUM_DAYS, HARD_DAYS, FORCE_DAYS, KEEP_DAYS,
};
