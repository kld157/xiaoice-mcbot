// memory.js —— mcbot 的轻量长期记忆（零依赖，跨平台）
// 存：JSONL 追加写，一行一条
// 取：同一个玩家最近 N 条（默认 10），拼成一小段文字塞进 system prompt
// 字段刻意对齐 livingmemory（importance / topics / key_facts），将来接共享记忆时零返工

'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, 'mc_memory.jsonl');
const DEFAULT_KEEP = 10;          // 同一个玩家留最后 10 条
const MAX_LINES = 4000;          // 文件超了就从老的一半截掉，防止无限长
const BUDGET_CHARS = 420;        // 塞进 prompt 的字符预算，别把 token 吃光

let MEM_FILE = DEFAULT_FILE;
let boot = null;                 // 启动时读进来的索引：player -> [entry...]

function setFile(p) { MEM_FILE = p; boot = null; }

function norm(p) { return String(p || '').trim().toLowerCase(); }

// 一行一条，读坏了就跳过（记忆坏了不该让 bot 起不来）
function loadAll() {
  if (boot) return boot;
  const idx = new Map();
  let raw = '';
  try { raw = fs.readFileSync(MEM_FILE, 'utf8'); } catch (e) { boot = idx; return boot; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    if (!rec || !rec.player) continue;
    const k = norm(rec.player);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(rec);
  }
  boot = idx;
  return boot;
}

// 追加一条。写盘失败只记日志，不抛（记忆不能拖垮游戏）
function remember(player, text, opts) {
  const o = opts || {};
  const body = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!body) return null;
  const rec = {
    ts: Math.round(Date.now() / 1000),
    player: String(player || '?'),
    role: o.role || 'player',           // player | bot | event
    text: body.slice(0, 200),
    importance: typeof o.importance === 'number' ? o.importance : 0.5,
    topics: Array.isArray(o.topics) ? o.topics.slice(0, 5) : [],
    key_facts: Array.isArray(o.key_facts) ? o.key_facts.slice(0, 5) : [],
  };
  const idx = loadAll();          // 先把索引建好：否则下面 loadAll 会把刚落盘的这条也读进来，变两条
  try {
    fs.appendFileSync(MEM_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    try { console.log('[memory] write fail: ' + e.message); } catch (_) {}
    return rec;
  }
  const k = norm(rec.player);
  if (!idx.has(k)) idx.set(k, []);
  const arr = idx.get(k);
  arr.push(rec);
  trimFileIfNeeded();
  return rec;
}

// 文件太长就裁：读回全部、留后半，重写
let lastTrim = 0;
function trimFileIfNeeded() {
  if (Date.now() - lastTrim < 60000) return;
  lastTrim = Date.now();
  try {
    const raw = fs.readFileSync(MEM_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const kept = lines.slice(Math.floor(lines.length / 2));
    const tmp = MEM_FILE + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, MEM_FILE);
    boot = null;                                  // 索引重建
  } catch (e) { /* 裁失败无所谓，下轮再试 */ }
}

// 同一个玩家的最后 n 条
function recent(player, n) {
  const want = Math.max(1, Math.min(50, n || DEFAULT_KEEP));
  const idx = loadAll();
  const arr = idx.get(norm(player)) || [];
  return arr.slice(-want);
}

// 拼成 prompt 里的一小段；没记忆就返回空串（调用方不用特判）
function block(player, n) {
  const list = recent(player, n || DEFAULT_KEEP);
  if (!list.length) return '';
  const head = `【你记得关于 ${list[0].player} 的事】\n`;
  const body = [];
  let used = head.length;
  for (const r of list) {
    const who = r.role === 'bot' ? '你' : (r.role === 'event' ? '（发生）' : r.player);
    const seg = `${who}：${r.text}`;
    if (used + seg.length + 1 > BUDGET_CHARS) break;
    body.push(seg);
    used += seg.length + 1;
  }
  if (!body.length) return '';
  return head + body.join('\n');
}

// 记一轮对话：玩家说了啥 + 你回了啥
function rememberExchange(player, userText, botText) {
  if (userText) remember(player, userText, { role: 'player' });
  if (botText) remember(player, botText, { role: 'bot' });
}

module.exports = { remember, rememberExchange, recent, block, setFile, DEFAULT_KEEP };
