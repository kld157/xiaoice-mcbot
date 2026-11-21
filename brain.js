#!/usr/bin/env node
/**
 * brain.js — 后台大脑（「想」的那一半）
 *
 * 为什么拆出来：play.js 里「问模型 → 等结果 → 再问模型」是一步一往返，
 * 每一步都要等 1~3 秒模型延迟，几十步的活儿能拖好几分钟。
 * 这里把它拆到独立进程，规矩是三条：
 *   1. 一次一批：模型一次给 BATCH_SIZE 个动作，不是一个；
 *   2. 一边生一边做：当前批在 play.js 那边跑的时候，这里已经在生成下一批（预取槽 1 个）；
 *   3. 通用调用：动作名只从 play.js 发来的白名单里挑，不自己造分发。
 *
 * 通道：复用 mc_ipc.js 的 Unix socket，不加协议、不加端口。
 *   brain --> play   {t:'hello', role:'brain'} / {t:'batch'|'say'|'done'}
 *   play  --> brain  {t:'tools', names} / {t:'task', id, user, text, ctx} / {t:'batch_done', results, aborted}
 *
 * 用法：node brain.js            （前台）
 *      setsid nohup node brain.js >/dev/null 2>&1 &   （后台）
 * 环境变量：
 *      MC_BATCH=3        一批最多几个动作
 *      MC_MAX_BATCH=12   一个任务最多几批（防打转）
 *      MC_BRAIN_KIND=auto 走 llm.json 里的哪一档模型
 *      MC_IPC_SOCK=...   通道路径，默认与 play.js 同目录
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const LLM = require('./llm.js');
const PLAT = require('./platform.js');

const SOCK = process.env.MC_IPC_SOCK || path.join(__dirname, '.mc_ipc.sock');
const BATCH_SIZE = Math.max(1, Math.min(8, parseInt(process.env.MC_BATCH || '3', 10)));
const MAX_BATCH = Math.max(1, parseInt(process.env.MC_MAX_BATCH || '12', 10));
const KIND = process.env.MC_BRAIN_KIND || 'auto';
const LOGFILE = path.join(__dirname, 'brain.log');

let sock = null, connected = false, buf = '', retry = 0;
let TOOLS = [];          // play.js 发来的动作白名单（唯一来源）

// 2026-11-21 真机 bug：白名单只发了动作名，模型不知道要带参数，于是写 dig {"args":{}}，
// 执行端只好去挖脚下那块，结果「挖泥土」挖到 cobblestone。这里把关键参数讲清楚 + 发出去前自己校验。
const ARG_HINT = {
  dig: 'block（方块英文 id，如 "dirt"/"oak_log"/"stone"）或坐标 x,y,z',
  place: 'x,y,z（block 可省）',
  goto: 'x,y,z',
  collect: 'count（数量）；要指定方块就加 block',
  toss: 'item（英文 id，如 "dirt"）+ count',
  craft: 'item（英文 id，如 "oak_planks"）+ count',
  say: 'text（要说的话）',
  shoot: 'target（玩家名/怪名）+ count',
  chest: 'mode（store|take|list）+ items/preset',
};
// 2026-11-21 真机 bug（挖三个石头→扔了）：挖 stone 掉下来的是 **cobblestone**，不是 stone。
// 模型按玩家说的名字写 toss {"item":"stone"}，执行端只能回「背包里没有 stone」；
// 改成 cobblestone 时又因为掉落物被秒清真的没捡到 -> 整条链断在这儿。
// 一张「方块 -> 实际掉落物」表：挖完要扔/合成/放，用的必须是掉落物的 id。
const DROPS = {
  stone: 'cobblestone',
  deepslate: 'cobbled_deepslate',
  grass_block: 'dirt',
  mycelium: 'dirt', podzol: 'dirt', dirt_path: 'dirt', farmland: 'dirt',
  coal_ore: 'coal', iron_ore: 'raw_iron', copper_ore: 'raw_copper', gold_ore: 'raw_gold',
  diamond_ore: 'diamond', emerald_ore: 'emerald', redstone_ore: 'redstone',
  lapis_ore: 'lapis_lazuli', nether_quartz_ore: 'nether_quartz', nether_gold_ore: 'gold_nugget',
  oak_leaves: 'oak_sapling', birch_leaves: 'birch_sapling', spruce_leaves: 'spruce_sapling',
  gravel: 'gravel', sandstone: 'sandstone', clay: 'clay_ball',
  // 反向也认一下：背包里有 cobblestone，玩家说的是「石头」
  cobblestone: 'cobblestone', cobbled_deepslate: 'cobbled_deepslate', dirt: 'dirt',
};

/** 方块/物品 id -> 它实际会掉的东西（认不出就空串） */
function dropOf(name) {
  const n = String(name || '').toLowerCase().replace(/^minecraft:/, '').trim();
  if (!n) return '';
  if (DROPS[n]) return DROPS[n];
  if (n.startsWith('deepslate_')) {
    const b = DROPS[n.slice('deepslate_'.length)];
    if (b) return b;
  }
  return '';
}

// 这些动作少了参数就等于没说要干什么 -> 直接不许发，让模型重写
const REQ_ARGS = {
  dig: ['block', 'x', 'name', 'what', 'type'],
  toss: ['item'],
  craft: ['item'],
  say: ['text'],
  goto: ['x', 'y', 'z'],
};
function argProblems(items) {
  const bad = [];
  for (const it of items) {
    const nm = String((it && it.name) || '').toLowerCase();
    const req = REQ_ARGS[nm];
    if (!req) continue;
    const a = (it && it.args && typeof it.args === 'object') ? it.args : {};
    const has = req.some((k) => a[k] !== undefined && a[k] !== null && String(a[k]).trim() !== '');
    if (!has) bad.push(`${nm} 少了参数（要 ${ARG_HINT[nm] || req.join('/')}），现在写的是 ${JSON.stringify(a)}`);
  }
  return bad;
}
let CFG = null;
try { CFG = LLM.loadCfg(__dirname); } catch (e) { /* 下面调用时会报原因 */ }

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOGFILE) && fs.statSync(LOGFILE).size > 8 * 1024 * 1024) fs.renameSync(LOGFILE, LOGFILE + '.1');
  } catch (e) {}
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch (e) {}
}

// —— 单实例锁：两个 brain 接同一个 play.js，同一句话会被想两遍、动作翻倍 ——
// 交给 platform.js（Linux 读 /proc、Windows 问 tasklist）。MC_BRAIN_LOCK 让离线自测用独立锁
const LOCK = process.env.MC_BRAIN_LOCK || path.join(__dirname, '.brain.lock');
{
  const r = PLAT.acquireLock(LOCK, 'brain.js', (m) => log(m));
  if (!r.ok) {
    log(`另一个 brain.js 还在跑(pid ${r.pid})，本进程退出`);
    process.exit(0);
  }
  PLAT.installExitHandlers(() => PLAT.releaseLock(LOCK));
}

function send(obj) {
  if (!sock || !connected) return false;
  try { sock.write(JSON.stringify(Object.assign({ ts: Date.now() }, obj)) + '\n'); return true; }
  catch (e) { log('sendErr ' + (e.message || e)); return false; }
}

// ===== 通道：同机 socket，断了就 2 秒后重连（play.js 重启不用管我） =====
function connect() {
  sock = net.createConnection(SOCK);
  sock.setEncoding('utf8');
  sock.setNoDelay(true);
  sock.on('connect', () => {
    connected = true; retry = 0; buf = '';
    log('已接上 play.js (' + SOCK + ')');
    send({ t: 'hello', role: 'brain', pid: process.pid, batch: BATCH_SIZE });
  });
  sock.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 512 * 1024) { buf = ''; return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { onMsg(JSON.parse(line)); } catch (e) { /* 半行/脏行直接丢 */ }
    }
  });
  sock.on('error', (e) => { if (connected) log('sockErr ' + (e.message || e)); });
  sock.on('close', () => {
    connected = false;
    const wait = Math.min(15000, 2000 * Math.max(1, retry++));
    setTimeout(connect, wait);
  });
}

// ===== 批内依赖检测（2026-11-21 真机踩的坑）=====
// 模型一旦能「一次给一批」，就会把有依赖的两步塞进同一批：dig>toss。
// 但 dig 是异步的（要挖好几秒），play.js 串行往下走，toss 立刻执行时背包里还没东西
// -> "背包里没有 dirt" -> 整批 aborted，任务还照样 finish，丢掉那步就悄悄没了。
// 规矩：一批里只放「互不依赖」的动作。后面要用的东西是前面动作产出的，就强制拆到下一批。
const DEP_PRODUCE = new Set(['dig', 'collect', 'pickup', 'drops', 'craft', 'farm', 'trade', 'junk', 'mobs', 'attack']);
const DEP_CONSUME = new Set(['toss', 'drop', 'place', 'give', 'chest', 'craft', 'eat', 'drink', 'potions',
  'weapons', 'armor', 'blueprint', 'build_house', 'plug_well', 'gravel_fill', 'cage', 'pillar', 'farm',
  'redstone', 'trade']);
const ARG_ITEM_KEYS = ['item', 'block', 'what', 'target', 'name', 'material', 'with', 'using', 'kind', 'type'];

/** 从参数里猜这个动作「要/会」什么物品（就取常见字段，猜不到就空） */
function itemNames(args) {
  const out = [];
  if (!args || typeof args !== 'object') return out;
  for (const k of ARG_ITEM_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim().toLowerCase());
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.push(x.trim().toLowerCase());
  }
  return out;
}

/** 物品名比对：容忍 minecraft: 前缀、复数/后缀（dirt / dirt_block / oak_log / oak_wood 这类） */
function sameItem(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/^minecraft:/, '').replace(/[^a-z0-9_]/g, '');
  const x = norm(a), y = norm(b);
  if (x.length < 2 || y.length < 2) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// 「背包里没有 X」「没挖到 X」-> 给模型一条掉落物对照的提醒（① 2026-11-21）
function aliasHint(msg) {
  const m = /(?:背包里没有|没挖到|找不到)\s*([a-z0-9_:]+)/i.exec(String(msg || ''));
  if (!m) return '';
  const want = m[1].toLowerCase();
  const d = dropOf(want);
  let h = `执行端回的是「${String(msg).slice(0, 60)}」——背包里没有叫「${want}」的东西。`;
  if (d && d !== want) h += `挖 ${want} 掉下来的其实是 ${d}，扔/合成/放置都要写「${d}」；`;
  h += '不确定就先 inventory（或 drops）看一眼背包里到底叫什么，再照着那个 id 写，别再重复同一个名字。';
  return h;
}

/** 切开一批：head 现在做，tail 下一批做。没有依赖就原样返回 */
function splitDeps(items) {
  const produced = [];
  let unknown = false;   // 前面有产出型动作，但推不出产出啥 -> 后面要东西的也别硬塞
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const nm = String(it.name || '').toLowerCase();
    const names = itemNames(it.args);
    if (i > 0 && DEP_CONSUME.has(nm) && names.length) {
      const hit = names.find((n) => produced.some((p) => sameItem(n, p) || sameItem(dropOf(n) || '§', p) || sameItem(n, dropOf(p) || '§')));
      if (hit || unknown) {
        return { head: items.slice(0, i), tail: items.slice(i), why: `${nm} 要的 ${hit || names[0]} 得等前面动作的产出` };
      }
    }
    if (DEP_PRODUCE.has(nm)) {
      if (names.length) for (const n of names) { produced.push(n); const d = dropOf(n); if (d) produced.push(d); }
      else unknown = true;
    }
  }
  return { head: items, tail: [], why: '' };
}

// ===== 一个任务的状态机 =====
// 老任务被打断（新指令来了）靠 token 比对：token 一变，正在跑的循环自己退场。
let CUR = { id: null, token: 0 };
let PENDING = [];            // 被强制拆批后还没做的动作（不用再问模型，直接接着做）
let PENDING_FINAL = false;
const WAITERS = new Map();   // "id:seq" -> resolve
let lastPrefetch = null;     // 预取槽：只有一个

function onMsg(o) {
  if (!o || typeof o !== 'object') return;
  switch (o.t) {
    case 'tools':
      TOOLS = Array.isArray(o.names) ? o.names.filter((x) => typeof x === 'string') : [];
      log('拿到动作白名单 ' + TOOLS.length + ' 个');
      break;
    case 'task':
      startTask(o);
      break;
    case 'batch_done': {
      const k = `${o.id}:${o.seq}`;
      const w = WAITERS.get(k);
      if (w) { WAITERS.delete(k); w(o); }
      break;
    }
    default:
      break;
  }
}

function waitDone(id, seq, ms) {
  const k = `${id}:${seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { WAITERS.delete(k); resolve({ results: [], aborted: true, timeout: true }); }, ms || 180000);
    WAITERS.set(k, (o) => { clearTimeout(timer); resolve(o); });
  });
}

function startTask(t) {
  const token = ++CUR.token;
  CUR.id = t.id;
  t.inv0 = (t.inv && typeof t.inv === 'object') ? t.inv : null;   // 任务开始时的背包快照，验收拿它算增量
  PENDING = [];          // 新任务来了，上一个任务拆剩的余量作废
  PENDING_FINAL = false;
  log(`TASK ${t.id} ${t.user || ''}: ${String(t.text || '').slice(0, 100)}`);
  runTask(t, token).catch((e) => {
    log('TASK ERR ' + ((e && e.stack) || e));
    send({ t: 'done', id: t.id, why: 'brain 出错：' + (e && e.message ? e.message : e) });
  });
}

// ===== 让模型给一批动作 =====
function buildPrompt(task, hist, seq, extra) {
  const sys = [
    '你是 Minecraft 里一个 AI 玩家的「执行大脑」。你看不到画面，只能看到状态 JSON，并下达动作。',
    '执行端会严格按你给的顺序一条一条做，所以：动作要少而准，前面失败后面就别硬来。',
    '',
    '只输出一个 JSON 对象，不要解释、不要代码块围栏、不要多余文字：',
    '{"say":"要对玩家说的一句话（可空）","items":[{"name":"动作名","args":{}}],"final":false}',
    '',
    `规则：`,
    `1. items 最多 ${BATCH_SIZE} 条，从短到长，先做能立刻验证成功的；`,
    '2. name 必须从「可用动作」里选，不许编；args 只填该动作认识的字段。这个动作需要目标/数量的话，args 就必须写清楚，写 {} 会被打回；',
    '3. 这一批做完就能达成目标的话，final 写 true；还需要下一批就 false；',
    '4. 已有执行历史里标 ✓ 的别再重复，标 ✗ 的要换方法；',
    '5. say 只在需要跟玩家说人话时填，别每批都说。',
    '6. 一批里不要放互相依赖的动作：后面那条要用前面那条产出的东西（比如先挖再扔/先挖再合成），就留给下一批，这批只写前面那步。',
    '7. 玩家说了挖什么，dig 就必须带 block，不许给空 args：',
    '   「挖三个泥土」→ {"name":"dig","args":{"block":"dirt"}} 连来 3 条（或先 dig 再下一批）；',
    '   「扔了泥土」→ {"name":"toss","args":{"item":"dirt","count":1}}；「做个木板」→ {"name":"craft","args":{"item":"oak_planks","count":4}}；',
    '   不确定就把方块名写英文 id，挖不到会报错，报错再换，别空着。',
    '8. 挖到的不是方块本身，是掉落物——后面要扔/合成/放置，用掉落物的 id：',
    '   石头 stone→cobblestone，深板岩 deepslate→cobbled_deepslate，草方块 grass_block→dirt，',
    '   coal_ore→coal，iron_ore→raw_iron，diamond_ore→diamond，lapis_ore→lapis_lazuli（其余 _ore 同理）。',
    '   所以「挖三个石头再扔掉」= 先 dig {"block":"stone"} ×3，下一批 toss {"item":"cobblestone"}。',
    '   真不确定背包里叫什么，就先写 inventory 看一眼，别硬猜着报错。',
    '',
    '可用动作：' + (TOOLS.length ? TOOLS.join(', ') : '（还没拿到白名单，先用 perceive）'),
    (function () {
      const lines = Object.keys(ARG_HINT).filter((k) => !TOOLS.length || TOOLS.includes(k))
        .map((k) => `- ${k}: ${ARG_HINT[k]}`);
      return lines.length ? '要带参数的动作（args 写法）：\n' + lines.join('\n') : '';
    })(),
  ].filter(Boolean).join('\n');

  const parts = [];
  parts.push('【任务】' + String(task.text || ''));
  parts.push('【当前状态】' + JSON.stringify(task.ctx || {}).slice(0, 1200));
  if (hist.length) {
    const lines = hist.map((h) => `第${h.seq + 1}批：` + h.items.map((it, i) => {
      const r = (h.results || [])[i];
      const mark = !r ? '…' : (r.ok ? '✓' : '✗');
      return `${mark}${it.name}${r && r.msg ? '(' + String(r.msg).slice(0, 60) + ')' : ''}`;
    }).join(' ')).join('\n');
    parts.push('【已经做过】\n' + lines);
  }
  const lastH = hist[hist.length - 1];
  const lastFailed = !!lastH && (!!lastH.aborted || (lastH.results || []).some((r) => !r.ok));
  if (lastFailed) {
    parts.push('【注意】上一批有动作失败或中途断了，剩下的别按原计划照做，先处理失败原因；'
      + '并且必须至少给一个动作（换了方法再试）。只有目标真的已经达成，才写 final:true + 空 items。');
  }
  if (extra) parts.push('【提醒】' + extra);
  parts.push(`【这是第 ${seq + 1} 批】`);
  return { sys, user: parts.join('\n\n') };
}

function parsePlan(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 抠第一个平衡的 {...}，容忍前后有闲话
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  let obj;
  try { obj = JSON.parse(s.slice(start, end)); } catch (e) { return null; }
  const items = (Array.isArray(obj.items) ? obj.items : []).slice(0, BATCH_SIZE).map((it) => ({
    name: String((it && (it.name || it.action)) || '').trim(),
    args: (it && it.args && typeof it.args === 'object') ? it.args : {},
  })).filter((it) => it.name);
  return { say: typeof obj.say === 'string' ? obj.say.slice(0, 200) : '', items, final: !!obj.final };
}

async function think(task, hist, seq, extra) {
  const { sys, user } = buildPrompt(task, hist, seq, extra);
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await LLM.chat(CFG, KIND, msgs, { max_tokens: 800, temperature: 0.3 });
    if (!r || !r.ok) {
      log(`think 第${attempt + 1}次失败：${(r && r.err) || 'unknown'}`);
      continue;
    }
    const plan = parsePlan(r.text);
    if (plan) {
      log(`think #${seq + 1} ${Date.now() - t0}ms ${r.viaModel || ''} -> ${plan.items.length} 条${plan.final ? ' final' : ''}`);
      return plan;
    }
    log(`think 第${attempt + 1}次解析不出 JSON：` + String(r.text || '').slice(0, 160));
    msgs.push({ role: 'assistant', content: String(r.text || '').slice(0, 500) });
    msgs.push({ role: 'user', content: '格式不对，只输出那个 JSON 对象，别的话一句都不要。' });
  }
  return null;
}

// 发出去前校验参数：缺参数就打回让模型重写一次，别让「挖泥土」变成「随便挖一块」
async function repairArgs(task, hist, seq, plan) {
  if (!plan || !plan.items.length) return plan;
  let probs = argProblems(plan.items);
  if (!probs.length) return plan;
  log('参数校验没过：' + probs.join('；'));
  const fix = await think(task, hist, seq,
    '上一版这些动作缺参数被打回了：' + probs.join('；')
    + '。按【要带参数的动作（args 写法）】重写这一批，每条都要把 args 填清楚。');
  if (fix && fix.items.length) {
    const p2 = argProblems(fix.items);
    if (!p2.length) { log('重写后参数齐了'); return fix; }
    log('重写后还是缺参数：' + p2.join('；') + '，只保留参数齐的');
    const kept = fix.items.filter((it) => !argProblems([it]).length);
    if (kept.length) return { say: fix.say, items: kept, final: false };
  }
  log('参数补不上，这批不发');
  return null;
}

// ===== 状态核对：动作回执 ✓ ≠ 目标达成（2026-11-21 用户定的验收口径）=====
// 「挖了」= 回执 ✓ 且背包/目标状态真的变了。这里用任务开始时的背包快照和每批回执的背包快照
// 算增量，先做一遍不用模型的硬核对，抓得住典型的假成功：动作全 ✓、背包一件没多。
const GAIN_ACTS = ['dig', 'collect', 'gather', 'mine', 'pickup', 'autopickup', 'loot', 'chop'];
const SPEND_ACTS = ['toss', 'drop', 'place', 'craft', 'chest'];

function invDiff(from, to) {
  const a = from || {}, b = to || {};
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  const gained = {}, lost = {};
  for (const n of names) {
    const d = (b[n] || 0) - (a[n] || 0);
    if (d > 0) gained[n] = d;
    else if (d < 0) lost[n] = -d;
  }
  return { gained, lost };
}

function diffText(d) {
  const g = Object.keys(d.gained).map((n) => `+${d.gained[n]} ${n}`);
  const l = Object.keys(d.lost).map((n) => `-${d.lost[n]} ${n}`);
  const s = [...g, ...l].join('，');
  return s || '（一件都没变）';
}

/**
 * 硬核对背包：只判能 100% 确定的假成功，其余交给模型 + 增量一起看。
 * 返回 {ok:true, note} 表示没发现问题；{ok:false, missing} 表示确定没达成。
 */
function stateCheck(task, hist) {
  if (!task.inv0 || typeof task.inv0 !== 'object') return { ok: true, note: '' };
  const last = [...hist].reverse().find((h) => h.inv && typeof h.inv === 'object');
  if (!last) return { ok: true, note: '' };   // 执行端没给快照（老 play.js），别乱判
  const d = invDiff(task.inv0, last.inv);
  const note = `背包变化（任务开始 → 现在）：${diffText(d)}`;

  const oks = [];
  for (const h of hist) {
    h.items.forEach((it, i) => {
      const r = (h.results || [])[i];
      if (r && r.ok) oks.push(it.name);
    });
  }
  const gotActs = oks.filter((n) => GAIN_ACTS.includes(n));
  const nothingGained = !Object.keys(d.gained).length;
  const nothingLost = !Object.keys(d.lost).length;
  // 只有「获取类动作全 ✓」+「背包一件没多」同时成立才判死，避免纯放置/纯说话被误伤
  if (gotActs.length && nothingGained && !Object.keys(d.lost).length) {
    return {
      ok: false,
      note,
      missing: `动作都报成功了，但背包一件都没多（${gotActs.join('/')} 没东西到手），这步不算做到`,
    };
  }
  // 反向：只有「消耗类动作全 ✓」、别的啥也没干，背包还一件没少 -> 多半是空跑
  const spActs = oks.filter((n) => SPEND_ACTS.includes(n));
  if (spActs.length && !gotActs.length && nothingLost && nothingGained) {
    return { ok: false, note, missing: `${spActs.join('/')} 报成功但背包没变（没扔出去也没用掉），这步不算做到` };
  }
  return { ok: true, note };
}

// ②收工前自检：模型说 final 就停，以前会出现「活儿没干完也当作完了」（2026-11-21 真机 bug③）
async function verifyDone(task, hist, strict) {
  // strict=true 时「验收调不动/看不懂」不算通过（批次用完那种场景，宁可说一句也不假装成功）
  const unsure = (why) => {
    if (strict) { log('验收不可用（' + why + '），按「不确定」处理'); return { done: false, missing: '我这边核对不了到底做完没有' }; }
    log('验收不可用（' + why + '），按完成算');
    return { done: true, missing: '' };
  };
  const histLines = hist.map((h) => `第${h.seq + 1}批：` + h.items.map((it, i) => {
    const r = (h.results || [])[i];
    const mark = !r ? '…' : (r.ok ? '✓' : '✗');
    return `${mark}${it.name}${it.args && Object.keys(it.args).length ? JSON.stringify(it.args) : ''}${r && r.msg ? '(' + String(r.msg).slice(0, 50) + ')' : ''}`;
  }).join(' ')).join('\n');

  // 先硬核对一遍背包：确定的假成功直接判没做到，不浪费一次模型调用
  const sc = stateCheck(task, hist);
  if (!sc.ok) {
    log('状态核对没过：' + sc.missing);
    return { done: false, missing: sc.missing };
  }

  const sys = '你是 Minecraft 任务的验收员，只核对有没有做到，不聊天。'
    + '验收口径：动作回执 ✓ 只是「动作发出去了」，还必须背包/目标状态真的变了才算做到；'
    + '背包没变化、或者变化跟玩家要的不一致，就写 done:false。'
    + '只输出一个 JSON 对象，不要代码块、不要解释：{"done":true 或 false,"missing":"没做到的地方，一句话，做到了就写空串"}';
  const user = `【玩家原话】${String(task.text || '')}\n\n【已经做过的动作】\n${histLines.slice(0, 1500)}`
    + `\n\n【当前状态】${JSON.stringify(task.ctx || {}).slice(0, 800)}`
    + (sc.note ? `\n\n【${sc.note.slice(0, 400)}】` : '')
    + '\n\n执行大脑现在说「做完了」。按玩家原话核对：真的全做到了吗？（只认动作 ✓ 且背包/状态真的有变化，别想象）';
  try {
    const r = await LLM.chat(CFG, KIND, [{ role: 'system', content: sys }, { role: 'user', content: user }], { max_tokens: 200, temperature: 0 });
    if (!r || !r.ok) return unsure('调用失败 ' + ((r && r.err) || 'unknown'));
    const s = String(r.text || '');
    const i0 = s.indexOf('{'), i1 = s.lastIndexOf('}');
    let obj = null;
    if (i0 >= 0 && i1 > i0) { try { obj = JSON.parse(s.slice(i0, i1 + 1)); } catch (e) { obj = null; } }
    if (!obj || typeof obj.done !== 'boolean') return unsure('解析不出 ' + s.slice(0, 120));
    const missing = typeof obj.missing === 'string' ? obj.missing.slice(0, 120) : '';
    log(`验收：${obj.done ? '通过' : '没通过（' + missing + '）'}`);
    return { done: obj.done, missing };
  } catch (e) {
    return unsure('出错 ' + (e && e.message));
  }
}

// ===== 主循环：发一批 → 立刻预取下一批 → 等回执 → 决定用预取还是重想 =====
async function runTask(task, token) {
  const id = task.id;
  const hist = [];
  let why = 'finish';
  let plan = await think(task, hist, 0);
  if (CUR.token !== token) return;
  plan = await repairArgs(task, hist, 0, plan);   // 首轮就盯参数
  let verifies = 0;

  for (let seq = 0; seq < MAX_BATCH; seq++) {
    if (!plan || !plan.items.length) {
      // ③ 以前这里闷头 break 然后 finish，用户以为事儿办完了，其实半路就断了（2026-11-21 真机 bug）
      //    现在：卡住了就当场说清楚，done 的 why 也换成 giveup，别假装成功
      const last = hist[hist.length - 1];
      const lastBad = last && (last.aborted || (last.results || []).some((r) => !r.ok));
      if (lastBad) {
        const fail = (last.results || []).find((r) => !r.ok) || {};
        const what = fail.name ? '「' + fail.name + '」' : '那步';
        const msg = `这活儿卡住了：${what}没成${fail.msg ? '（' + String(fail.msg).slice(0, 50) + '）' : ''}，我不硬来了`;
        log(`#${seq + 1} 想不出下一步，告诉用户：${msg}`);
        send({ t: 'say', text: msg });
        why = 'giveup';
      } else if (!hist.length) {
        const msg = '我这边没想出能做的动作来，你再说细一点？比如「挖三个泥土」这种';
        log('#1 首轮就没计划，告诉用户');
        send({ t: 'say', text: msg });
        why = 'giveup';
      } else {
        log(`#${seq + 1} 没计划了，收工`);
      }
      break;
    }
    // —— 参数校验：缺参数的先打回重写，不许空 args 蒙过去 ——
    plan = await repairArgs(task, hist, seq, plan);
    if (CUR.token !== token) return;
    if (!plan || !plan.items.length) {
      const msg = '这活儿我卡在「不知道具体要动哪个方块/东西」上了，你能说具体点吗？比如「挖三个泥土」这种';
      log(`#${seq + 1} 参数补不上，告诉用户`);
      send({ t: 'say', text: msg });
      why = 'giveup';
      break;
    }
    // —— 批内依赖：有依赖就当场拆开，head 现在发，tail 排下一批 ——
    const sp = splitDeps(plan.items);
    if (sp.tail.length) {
      PENDING = sp.tail.concat(PENDING);
      PENDING_FINAL = plan.final;
      log(`批内有依赖，拆开：${sp.head.map((x) => x.name).join('>')} 现在做 ｜ ${sp.tail.map((x) => x.name).join('>')} 下一批（${sp.why}）`);
      plan = { say: plan.say, items: sp.head, final: false };
    }
    if (plan.say) send({ t: 'say', text: plan.say });
    send({ t: 'batch', id, seq, items: plan.items, final: plan.final });
    log(`发批 #${seq + 1} ` + plan.items.map((x) => x.name).join('>'));

    // ↓ 关键：这边不等执行，立刻开始生成下一批（预取槽 1 个）
    // 手里还有拆出来的余量就不用问了，省一次模型调用
    const prefetch = (plan.final || PENDING.length) ? null : think(task, hist, seq + 1);
    lastPrefetch = prefetch;

    const done = await waitDone(id, seq);
    if (CUR.token !== token) { log('任务被打断，退出'); return; }
    hist.push({ seq, items: plan.items, results: done.results || [], aborted: !!done.aborted, inv: done.inv || null });
    const bad = (done.results || []).find((r) => !r.ok);
    log(`回执 #${seq + 1} ${done.aborted ? 'aborted' : 'ok'}${bad ? ' 首个失败:' + bad.name + ' ' + bad.msg : ''}`);

    if (plan.final) {
      // 说收工了先自检一次：没做到就接着干（最多自检 2 次，别死循环）
      if (verifies < 2) {
        verifies++;
        const v = await verifyDone(task, hist);
        if (CUR.token !== token) return;
        if (!v.done) {
          const nxt = await think(task, hist, seq + 1,
            '刚才是想收工，但自检发现还没做到：' + (v.missing || '玩家要的事没完成')
            + '。接着把这点补上，别写 final:true。');
          const fixed = (nxt && nxt.items.length) ? await repairArgs(task, hist, seq + 1, nxt) : null;
          if (CUR.token !== token) return;
          if (fixed && fixed.items.length) {
            plan = { say: fixed.say, items: fixed.items, final: false };
            continue;
          }
          const msg = '差一点没做完：' + (v.missing || '还有一步') + '，我这边卡住了，你再点点我';
          log('# 验收没过又补不上：' + msg);
          send({ t: 'say', text: msg });
          why = 'giveup';
        }
      }
      break;
    }
    // 这一批失败了，拆出来的余量多半也做不成（依赖的东西没到手），丢掉重想
    if ((done.aborted || bad) && PENDING.length) {
      log(`前面失败了，拆出来的余量作废（${PENDING.map((x) => x.name).join('>')}）`);
      PENDING = [];
    }
    let next = null;
    if (PENDING.length) {
      next = { say: '', items: PENDING.splice(0, BATCH_SIZE), final: false };
      if (!PENDING.length) next.final = PENDING_FINAL;
      log(`接着做拆出来的余量：${next.items.map((x) => x.name).join('>')}${next.final ? ' final' : ''}`);
      if (prefetch) prefetch.catch(() => null);   // 这轮没用上，作废
    } else {
      if (prefetch) {
        next = await prefetch.catch(() => null);
        lastPrefetch = null;
      }
      // 预取的批次是「盲生成」的（当时还不知道回执），一旦有失败就整批作废重想
      // ① 掉落物对照：失败信息里点名「背包里没有 X」时，把「X 掉的是 Y」直接塞给模型
      const hint = aliasHint(bad && bad.msg);
      if (hint) log('掉落物对照：' + hint);
      if (done.aborted || bad || !next) {
        if (done.aborted || bad) log('预取作废，带失败信息重想');
        next = await think(task, hist, seq + 1, hint);
      }
      // 失败之后模型还是「0 条收工」的话，逼它一次：换方法，别装死
      if ((done.aborted || bad) && (!next || !next.items.length)) {
        log('失败后重想还是 0 条，再逼一次换方法');
        next = await think(task, hist, seq + 1,
          '上一批已经失败了，必须换一种方法给出至少一个动作（比如先走过去、先换个方块/换个名字），不要给空 items。'
          + (hint ? '\n' + hint : ''));
      }
    }
    plan = next;
    if (CUR.token !== token) return;
  }

  // 跑到批次上限也停：最后一批要是没成，照样说清楚，别静悄悄收工
  if (why === 'finish') {
    const lh = hist[hist.length - 1];
    if (lh && (lh.aborted || (lh.results || []).some((r) => !r.ok))) {
      const fail = (lh.results || []).find((r) => !r.ok) || {};
      const msg = `剩的活儿没做完：最后「${fail.name || '那一步'}」没成${fail.msg ? '（' + String(fail.msg).slice(0, 50) + '）' : ''}，我先停这儿`;
      log('批次用完还有失败，告诉用户');
      send({ t: 'say', text: msg });
      why = 'giveup';
    } else if (hist.length) {
      // ④ 2026-11-21 真机 bug：最后一批动作回执全是 ✓（autopickup>drops 都成功），
      //    但玩家要的「再扔了」根本没做；12 批用完就走 finish，用户以为办完了 —— 假成功。
      //    动作成功 ≠ 目标达成：批次用完、没经过 final 验收的，一律补一次严格验收。
      const v = await verifyDone(task, hist, true);
      if (CUR.token !== token) return;
      if (!v.done) {
        const msg = `这批干完了但我核对了一下，${v.missing || '你要的那步还没落实'}；批数给我用完了，我先停这儿，你回一句我就接着来`;
        log('批次用完但验收没过，告诉用户：' + msg);
        send({ t: 'say', text: msg });
        why = 'giveup';
      }
    }
  }
  send({ t: 'done', id, why });
  log(`TASK ${id} 结束（${why}），用了 ${hist.length} 批`);
}

// ===== 离线自测（① 掉落物映射）：MC_TEST_DROPS=1 node brain.js 不需要模型、不连游戏 =====
if (process.env.MC_TEST_DROPS) {
  const cases = ['stone', 'deepslate', 'grass_block', 'dirt', 'coal_ore', 'deepslate_iron_ore',
    'diamond_ore', 'lapis_ore', 'oak_leaves', 'unknown_thing'];
  for (const c of cases) console.log(`dropOf(${c}) = ${dropOf(c) || '(认不出)'}`);
  console.log('\naliasHint: ' + aliasHint('背包里没有 stone'));
  const sp1 = splitDeps([{ name: 'dig', args: { block: 'stone' } }, { name: 'toss', args: { item: 'cobblestone', count: 1 } }]);
  console.log('\n拆批 dig stone > toss cobblestone -> head ' + sp1.head.map((x) => x.name)
    + ' / tail ' + sp1.tail.map((x) => x.name) + ' (' + sp1.why + ')');
  const sp2 = splitDeps([{ name: 'dig', args: { block: 'dirt' } }, { name: 'toss', args: { item: 'dirt', count: 1 } }]);
  console.log('拆批 dig dirt > toss dirt -> tail ' + sp2.tail.length);
  const sp3 = splitDeps([{ name: 'dig', args: { block: 'stone' } }, { name: 'inventory', args: {} }]);
  console.log('无依赖 dig > inventory -> tail ' + sp3.tail.length + '（应为 0）');

  // ===== 验收口径自测：动作 ✓ 但背包没变 = 没做到 =====
  const H = (items, results, inv) => ({ seq: 0, items, results, aborted: false, inv });
  const cases2 = [
    ['挖了但背包没多（假成功）', '挖三个泥土',
      { inv0: { dirt: 0 }, hist: [H([{ name: 'dig', args: { block: 'dirt' } }], [{ ok: true, msg: '挖掉一块 dirt' }], {})] }],
    ['挖了且背包真多了（该过）', '挖三个泥土',
      { inv0: { dirt: 2 }, hist: [H([{ name: 'dig', args: { block: 'dirt' } }], [{ ok: true, msg: '挖掉一块 dirt' }], { dirt: 3 })] }],
    ['石头挖到 cobblestone（该过）', '挖三个石头',
      { inv0: {}, hist: [H([{ name: 'dig', args: { block: 'stone' } }], [{ ok: true, msg: '挖掉一块 stone' }], { cobblestone: 1 })] }],
    ['扔了但背包没少（假成功）', '扔一块泥土',
      { inv0: { dirt: 5 }, hist: [H([{ name: 'toss', args: { item: 'dirt', count: 1 } }], [{ ok: true, msg: '扔了 1 个 dirt' }], { dirt: 5 })] }],
    ['扔了且背包真少了（该过）', '扔一块泥土',
      { inv0: { dirt: 5 }, hist: [H([{ name: 'toss', args: { item: 'dirt', count: 1 } }], [{ ok: true, msg: '扔了 1 个 dirt' }], { dirt: 4 })] }],
    ['只说句话（不该被硬判死）', '说你好',
      { inv0: { dirt: 1 }, hist: [H([{ name: 'say', args: { text: '你好' } }], [{ ok: true, msg: 'ok' }], { dirt: 1 })] }],
    ['执行端没给快照（不判）', '挖泥土',
      { inv0: { dirt: 1 }, hist: [H([{ name: 'dig', args: { block: 'dirt' } }], [{ ok: true }], null)] }],
  ];
  console.log('\n===== 验收口径（stateCheck）=====');
  for (const [label, text, t] of cases2) {
    const r = stateCheck({ text, inv0: t.inv0 }, t.hist);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${label} -> ${JSON.stringify(r)}`);
  }
  process.exit(0);
}

// ===== 离线自测：MC_TEST_PROMPT=1 node brain.js "挖三个泥土再扔掉" 只打印提示词，不连游戏 =====
if (process.env.MC_TEST_PROMPT) {
  TOOLS = (process.env.MC_TEST_TOOLS || 'perceive,inventory,say,dig,collect,toss,craft,goto').split(',');
  const text = process.argv.slice(2).join(' ') || '挖三个泥土再扔掉';
  console.log('【参数校验演示】' + JSON.stringify(argProblems([
    { name: 'dig', args: {} },
    { name: 'dig', args: { block: 'dirt' } },
    { name: 'toss', args: {} },
  ])));
  const p = buildPrompt({ text, ctx: { pos: [0, 64, 0], gamemode: 'survival' } }, [], 0, '');
  console.log('\n===== SYS =====\n' + p.sys + '\n\n===== USER =====\n' + p.user);
  if (process.env.MC_TEST_VERIFY) {
    const fakeHist = [{ seq: 0, items: [{ name: 'dig', args: { block: 'dirt' } }], results: [{ ok: true, msg: '挖掉一块 dirt' }], aborted: false }];
    verifyDone({ text, ctx: { mats: { dirt: 1 } } }, fakeHist)
      .then((v) => console.log('\n===== 验收自测 =====\n' + JSON.stringify(v)))
      .catch((e) => console.log('验收出错：' + e.message))
      .finally(() => process.exit(0));
    return;
  }
  if (process.env.MC_TEST_THINK) {
    LLM.chat(CFG, KIND, [{ role: 'system', content: p.sys }, { role: 'user', content: p.user }], { max_tokens: 800, temperature: 0.3 })
      .then((r) => {
        console.log('\n===== 模型原话 =====\n' + (r && r.ok ? r.text : '调用失败：' + (r && r.err)));
        const plan = r && r.ok ? parsePlan(r.text) : null;
        console.log('\n===== 解析 =====\n' + JSON.stringify(plan));
        if (plan) console.log('\n===== 参数校验 =====\n' + JSON.stringify(argProblems(plan.items)));
      })
      .catch((e) => console.log('think 出错：' + e.message))
      .finally(() => process.exit(0));
    return;
  }
  process.exit(0);
}

// ===== 起：接通道；顺带支持 stdin 发一条任务（不接游戏也能测提示词） =====
connect();
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    const s = String(d).trim();
    if (!s) return;
    if (s === '/tools') { log('白名单：' + TOOLS.join(',')); return; }
    startTask({ id: 'cli' + Date.now().toString(36), user: 'console', text: s, ctx: {} });
  });
}
process.on('SIGINT', () => { log('退出'); try { sock && sock.destroy(); } catch (e) {} process.exit(0); });
