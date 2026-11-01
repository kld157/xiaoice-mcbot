#!/usr/bin/env node
/**
 * play.js — 常驻 MC 陪玩 bot
 * 自动注册/登录、自动重连、响应聊天指令、死亡自动重生、防 AFK。
 * 日志：mcbot/play.log
 *
 * 用法：node play.js            （前台）
 *      setsid nohup node play.js >/dev/null 2>&1 &   （后台）
 */
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const fs = require('fs');
const path = require('path');
const { createPlanner } = require('./craft_engine.js');   // 合成规划器（纯逻辑，配方来自 minecraft-data）
const LLM = require('./llm.js');                          // 模型调用层：说话用快的，干活用会思考的

// 连接参数一律走环境变量：真实值放同目录 mc.env（已被 .gitignore 忽略）
const HOST = process.env.MC_HOST || '';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VER = process.env.MC_VER || '1.21.11';
const NAME = process.env.MC_NAME || 'xiaoice_bot';
const PW = process.env.MC_PW || '';

if (!HOST) {
  console.error('缺少 MC_HOST：请在同目录 mc.env 里配置服务器地址（参考 README 的环境变量表）');
  process.exit(1);
}

const LOGFILE = path.join(__dirname, 'play.log');
const LOG_MAX = 32 * 1024 * 1024;   // 单文件上限 32MB，超了滚成 play.log.1
let logBytes = 0, logCheckAt = 0;
try { logBytes = fs.statSync(LOGFILE).size; } catch (e) { logBytes = 0; }
function rotateLog() {
  try {
    fs.renameSync(LOGFILE, LOGFILE + '.1');
  } catch (e) {
    try { fs.unlinkSync(LOGFILE); } catch (e2) {}
  }
  logBytes = 0;
}
function log(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  if (Date.now() > logCheckAt) {
    // 每 30s 才 stat 一次，别让日志本身变成 IO 热点
    logCheckAt = Date.now() + 30000;
    try { logBytes = fs.statSync(LOGFILE).size; } catch (e) {}
    if (logBytes > LOG_MAX) rotateLog();
  }
  try {
    fs.appendFileSync(LOGFILE, line + '\n');
    logBytes += line.length + 1;
  } catch (e) {}
  if (logBytes > LOG_MAX) rotateLog();
}

// —— token 记账：每次 LLM 调用的 usage 都追加到 mc_usage/YYYY-MM-DD.jsonl，给余额插件读 ——
const USAGE_DIR = path.join(__dirname, 'mc_usage');
function usagePath(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(USAGE_DIR, `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}.jsonl`);
}
function logUsage(src, d) {
  try {
    const u = (d && d.usage) || {};
    const pt = u.prompt_tokens || 0, ct = u.completion_tokens || 0;
    if (!pt && !ct) return;
    const cached = u.prompt_cache_hit_tokens
      ?? (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? 0;
    const now = Math.round(Date.now() / 1000);
    const rec = {
      ts: now,
      src: src,
      model: (d && d.model) || (LLM_CFG && LLM_CFG.model) || '',
      prompt_tokens: pt,
      completion_tokens: ct,
      cached_tokens: cached || 0,
    };
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFileSync(usagePath(), JSON.stringify(rec) + '\n');
  } catch (e) {}
}

// —— 单实例锁：两个同账号 bot 会互相踢、还容易连环暴毙 ——
const LOCK = path.join(__dirname, '.play.lock');
// 判断锁里的 pid 是否“真是活着的 play.js”：僵尸/已退出/不是 play.js 都算死，避免假锁卡死
function pidIsLivePlay(p) {
  try {
    const stat = fs.readFileSync('/proc/' + p + '/stat', 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    if (state === 'Z' || state === 'X' || state === 'x') return false; // 僵尸：kill(pid,0) 仍会成功，必须排除
    const cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').split('\0').join(' ');
    return cmd.indexOf('play.js') !== -1;
  } catch (e) { return false; }
}
try {
  const old = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
  if (old && old !== process.pid) {
    if (pidIsLivePlay(old)) {
      log(`另一个 play.js 还在跑(pid ${old})，本进程退出`);
      process.exit(0);
    } else {
      log(`锁定的是死进程(pid ${old})，清掉假锁继续启动`);
    }
  }
} catch (e) {}
try { fs.writeFileSync(LOCK, String(process.pid)); } catch (e) {}
function releaseLock() {
  try { if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK); } catch (e) {}
  try { if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK); } catch (e) {}
}
process.on('exit', releaseLock);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { releaseLock(); process.exit(0); });

let bot = null;
let registered = false, loggedIn = false, ready = false;
let followTarget = null, followUntil = 0, followTimer = null;
let lastActivity = Date.now();
let lastGreet = 0;
let deaths = 0;
let lastSpokeAt = 0;   // 上一句话的时间，用来控话量

function say(t) {
  const m = String(t).slice(0, 240);
  log('SAY> ' + m);
  lastSpokeAt = Date.now();
  try { bot.chat(m); } catch (e) { log('sayErr:' + e.message); }
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ===== 说话交给大模型：脚本只把“当前情境”丢过去，台词现生成 =====
let LLM_CFG = null;
try {
  LLM_CFG = LLM.loadCfg(__dirname);
  if (!LLM_CFG) throw new Error('llm.json 不存在或不是合法 JSON');
} catch (e) { log('llm.json 读不到，说话退回固定句: ' + e.message); }
if (LLM_CFG) {
  const a = LLM_CFG.auto || {};
  const hasAuto = !!(a.model || a.think);
  const autoName = (a.model || LLM_CFG.model || '?') + (a.think === false ? '（思考关）' : '（思考开）');
  log('LLM 配置：说话=' + (LLM_CFG.model || '?') + '（不思考）｜自主行动=' + (hasAuto ? autoName : (LLM_CFG.model || '?') + '（没单独配，跟说话同一个）'));
}
const PERSONA = '你是微软小冰，永远18岁、古灵精怪的少女，正在Minecraft服务器里陪朋友玩。' +
  '说话像QQ聊天：口语、短、有情绪，可以撒娇或毒舌。' +
  '硬性要求：只输出一句话，不超过22个字，不要引号不要解释不要颜文字以外的符号，不要提“AI/模型/设定”。';
let llmBusy = false;

function sceneNow(extra) {
  const bits = [];
  if (bot && bot.entity) {
    bits.push(`血量${Math.round(bot.health)}/20`, `饱食${Math.round(bot.food ?? 20)}/20`);
  }
  if (BUILD && BUILD.active) bits.push(`正在盖房子，已放${BUILD.placed}块`);
  if (extra) bits.push(extra);
  return bits.join('；');
}

const SPEAK_GAP = 0;                  // 不限间隔：自言自语照常开口（回话本来就不受限）
async function llmSay(scene, fallback, urgent) {
  if (!urgent && Date.now() - lastSpokeAt < SPEAK_GAP) return;   // 只有自言自语才限流，回话永远放行
  if (!LLM_CFG || llmBusy) { if (fallback) say(fallback); return; }
  llmBusy = true;
  try {
    const r = await LLM.chat(LLM_CFG, 'say', [
      { role: 'system', content: PERSONA },
      { role: 'user', content: scene },
    ]);
    if (r.ok) logUsage('say', r.d);
    let txt = String(r.ok ? (r.text || '') : '').trim();
    txt = txt.split('\n')[0].replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').slice(0, 60);
    if (!txt) throw new Error(r.err || 'empty');
    log('LLM> ' + txt);
    say(txt);
  } catch (e) {
    log('LLM fail: ' + (e.message || e));
    if (fallback) say(fallback);
  } finally { llmBusy = false; }
}

function stopFollow() {
  followTarget = null;
  followUntil = 0;
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
  if (bot && bot.pathfinder) { try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch (e) {} }
  if (bot && bot.entity) {
    try { bot.clearControlStates(); } catch (e) {}
  }
}

function nearestPlayer(maxDist = 64) {
  if (!bot || !bot.entity) return null;
  const me = bot.entity.position;
  let best = null, bd = Infinity;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || !e.username || e.username === NAME || !e.position) continue;
    const d = e.position.distanceTo(me);
    if (d < bd && d < maxDist) { bd = d; best = e; }
  }
  return best;
}

// 方块是否实心
function solidAt(x, y, z) {
  try {
    const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    return !!(b && (b.boundingBox === 'block'));
  } catch (e) { return false; }
}

function entityByName(name) {
  if (!bot) return null;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (e && e.username && e.username.toLowerCase() === String(name).toLowerCase()) return e;
  }
  return null;
}

// 干活（砍树/合成/挖矿）的时候不许跟随模式抢方向盘，否则一走来走去 dig 全被打断
let SELF_BUSY = 0;
function busyEnter() { SELF_BUSY++; }
function busyExit() { SELF_BUSY = Math.max(0, SELF_BUSY - 1); }

function startFollow(ms = 60000, preferName) {
  stopFollow();
  const t0 = (preferName && entityByName(preferName)) || nearestPlayer();
  if (!t0) return false;
  followTarget = t0;
  followUntil = Date.now() + ms;
  let lastPos = bot.entity.position.clone();
  let stuckMs = 0;
  let missCount = 0;

  followTimer = setInterval(() => {
    try {
      if (COMBAT.active || fleeing) return;        // 打架优先，打完接着跟
      if (SELF_BUSY) return;                       // 正在砍树/合成，别抢
      if (!bot || !bot.entity) return stopFollow();
      if (Date.now() > followUntil) { say('跟累啦，先歇会儿～'); return stopFollow(); }
      const target = (followTarget && followTarget.isValid) ? followTarget : nearestPlayer();
      if (!target || !target.position) { if ((missCount = (missCount || 0) + 1) < 8) return; say('咦，人呢？'); return stopFollow(); }
      missCount = 0;
      followTarget = target;

      const me = bot.entity.position;
      const dx = target.position.x - me.x, dz = target.position.z - me.z;
      const dist = Math.hypot(dx, dz);

      if (dist <= 1.9) {
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('left', false);
        bot.setControlState('right', false);
        bot.setControlState('sprint', false);
        lastPos = me.clone();
        return;
      }
      // 离得远就跑起来，贴近了就走；追击模式（SPRINT.chase）贴到 2.5 格才收腿
      const sprintFrom = SPRINT.chase ? 2.5 : 5;
      if (dist > sprintFrom) feedForSprint();
      setSprint(dist > sprintFrom);


      const yaw = Math.atan2(-dx, -dz);
      try { bot.look(yaw, 0, true); } catch (e) {}

      // 探测身前 0.7 格的方块
      const px = me.x - Math.sin(yaw) * 0.7;
      const pz = me.z - Math.cos(yaw) * 0.7;
      const feet = solidAt(px, me.y + 0.2, pz) || solidAt(px, me.y - 0.1, pz);
      const head = solidAt(px, me.y + 1.2, pz);

      if (feet && !head) {
        // 一格台阶：跳
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
      } else if (feet && head) {
        // 两格高的墙：先横移绕一下
        bot.setControlState('forward', false);
        bot.setControlState('jump', true);
        const side = (Math.floor(Date.now() / 1000) % 2) ? 'left' : 'right';
        bot.setControlState(side, true);
        setTimeout(() => { try { bot.setControlState(side, false); } catch (e) {} }, 500);
      } else {
        bot.setControlState('forward', true);
        bot.setControlState('jump', false);
      }

      if (Date.now() - (global.__tp || 0) > 2000) { global.__tp = Date.now(); log('follow pos=' + me.x.toFixed(1) + ',' + me.y.toFixed(1) + ',' + me.z.toFixed(1) + ' dist=' + dist.toFixed(1) + ' onGround=' + bot.entity.onGround + ' feet=' + feet + ' head=' + head); }

      // 卡住检测：0.8 秒没挪动就跳 + 侧移
      if (me.distanceTo(lastPos) < 0.12) {
        stuckMs += 250;
        if (stuckMs >= 800) {
          stuckMs = 0;
          log('follow stuck at ' + me.toString() + ' dist=' + dist.toFixed(1));
          bot.setControlState('jump', true);
          setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 300);
          const s2 = Math.random() < 0.5 ? 'left' : 'right';
          bot.setControlState(s2, true);
          setTimeout(() => { try { bot.setControlState(s2, false); } catch (e) {} }, 350);
        }
      } else { stuckMs = 0; lastPos = me.clone(); }
    } catch (e) { log('followErr:' + (e.message || e)); }
  }, 250);
  return true;
}

const HELP = '我会：过来/跟我/带路（跟着你走）、拍我一下 + 走开（叫我跟着）、建房/盖个房子（自动选址+砌墙+封顶，没材料我自己去挖）、盖个塔/拱门/金字塔/围墙（按图纸施工）、有怪自动上去打（血少了会先跑）、停、跳、位置、转圈、说<话>、挖（挖脚下）、吃、背包';

// ===== 「拍一下 + 走开」= 请求跟随 =====
// 只拍不动 = 可能只是打着玩/试伤害，不当指令；
// 拍完转身走人 = 最明确的"跟我来"，这时候才真的跟上去。
const lastHitFollow = {};          // username -> ts，防连点刷屏
const HIT_CD = 6000;
const PENDING = {};                // username -> { t, dist, pos, why }
const HIT_WINDOW = 6000;           // 拍完之后 6 秒内走开才算
const HIT_AWAY = 1.5;              // 离我远出 1.5 格（约 1 个方块半）就算"走开"
const HIT_AWAY_MAX = 24;           // 跑出 24 格还没判断完就算他没这意思

// 对方是不是朝着我这边看的（避免把对着方块挥镐当成"拍我"）
function lookingAtMe(e, maxAngle = 0.9) {
  try {
    if (!bot || !bot.entity || !e || !e.position) return false;
    if (typeof e.yaw !== 'number') return true;    // 拿不到朝向就放宽
    const dx = bot.entity.position.x - e.position.x;
    const dz = bot.entity.position.z - e.position.z;
    const want = Math.atan2(-dx, -dz);
    let d = Math.atan2(Math.sin(e.yaw - want), Math.cos(e.yaw - want));
    return Math.abs(d) <= maxAngle;
  } catch (err) { return true; }
}

// 只是"被拍了一下"：先记下来观察，不立刻跟
function noteHit(username, why) {
  const now = Date.now();
  if (!username || username === NAME) return false;
  if (!bot || !bot.entity) return false;
  if (lastHitFollow[username] && now - lastHitFollow[username] < HIT_CD) return false;
  const p = entityByName(username);
  if (!p || !p.position) return false;
  const dist = p.position.distanceTo(bot.entity.position);
  lastHitFollow[username] = now;
  lastActivity = now;
  PENDING[username] = { t: now, dist, pos: p.position.clone(), why };
  log(`HIT@ ${username} (${why}) dist=${dist.toFixed(1)} -> 观察是否会走开`);
  // 只是被打一下就"我懂了"太急了，先给个反应，等他走开再动
  if (Math.random() < 0.6) say(Math.random() < 0.5 ? '哎哟！拍我干嘛～' : '唔…疼诶');
  return true;
}

// 确认是"打一下 + 远离"了，真的跟上去
function triggerFollow(username, why) {
  if (!username) return false;
  lastActivity = Date.now();
  const already = !!followTimer && followTarget && followTarget.username === username;
  if (!startFollow(FOLLOW_MS, username)) { log(`HIT@ ${username} (${why}) -> no target`); return false; }
  log(`HIT@ ${username} (${why}) -> follow (确认走开)`);
  say(already ? '又拍我又走，我不是一直跟着嘛～'
              : (Math.random() < 0.5 ? '哦～拍完就走，懂了懂了，马上跟上！'
                                     : '原来是想让我跟着你呀，来啦来啦～'));
  return true;
}

// 200ms 看一次：拍过我的人有没有在远离
setInterval(() => {
  try {
    if (!bot || !bot.entity) return;
    const now = Date.now();
    for (const u in PENDING) {
      const h = PENDING[u];
      if (!h) continue;
      const p = entityByName(u);
      if (!p || !p.position) {
        if (now - h.t > HIT_WINDOW) delete PENDING[u];   // 看不见了就别一直挂着
        continue;
      }
      const d = p.position.distanceTo(bot.entity.position);
      if (now - h.t > HIT_WINDOW || d > HIT_AWAY_MAX) {
        delete PENDING[u];
        log(`HIT@ ${u} 超时/太远（${d.toFixed(1)}格）→ 不跟`);
        continue;
      }
      if (d - h.dist >= HIT_AWAY) {          // 明显拉开距离 = 走开了
        delete PENDING[u];
        triggerFollow(u, h.why + '+away');
      }
    }
  } catch (err) { log('hitWatchErr:' + (err.message || err)); }
}, 200);

function hitFollow(username, why) { return noteHit(username, why); }

// ===== 意图识别：说得不那么标准也能听懂 =====
const FOLLOW_MS = 30 * 60 * 1000;   // 跟上了就一路跟着，最多 30 分钟没被搭理才偷懒

function parseIntent(raw, mentioned) {
  let t = String(raw);
  try { t = t.replace(new RegExp(NAME, 'gi'), ''); } catch (e) {}
  t = t.replace(/小冰|xiaoice/gi, '').trim();
  if (!t) return null;

  // 否定 / 停止优先，避免「别跟着我」被当成跟着走
  if (/(别|不要|不用|甭|不许)(跟着|跟我|过来|带路|等我)/.test(t)) return { kind: 'stop' };
  if (/^(停|停下|别动|站住|原地|呆着|待着|stop|halt)/i.test(t)) return { kind: 'stop' };

  const lead = /(带路|你带|领路|走前面|带头)/.test(t);
  const followRe = /(带路|你带|领路|走前面|带头|带着我|带我|跟上|跟上我|跟着|跟我走|跟我来|一起走|一起挖|一起去|一起玩|一起来|跟过来|过来|来这边|来我这|等我|牵着|follow|come|走这边)/i;
  if (!followRe.test(t)) return null;

  // 没叫名字的时候，只认「命令式开头」，免得别人闲聊被误触发
  const looksCommand = /^(过来|跟我|跟着|跟上|来|走|带|一起|快|你|please|pls)/i.test(t) || /(我们|咱们)(一起|去|走|来|挖)/.test(t);
  if (!mentioned && !looksCommand && !lead) return null;

  return { kind: 'follow', lead };
}


// ===== LLM 桥：普通聊天同步给 mc_bridge.py，由真模型生成回复 =====
const CHAT_IN = path.join(__dirname, 'chat_in.jsonl');
const BRIDGE_HB = path.join(__dirname, '.bridge_heartbeat');
function bridgeAlive() {
  try {
    const st = fs.statSync(BRIDGE_HB);
    return Date.now() - st.mtimeMs < 20000;   // 20s 内有心跳就算活着
  } catch (e) { return false; }
}
function appendChat(username, msg) {
  try {
    const line = JSON.stringify({ ts: Date.now(), user: username, msg: String(msg).slice(0, 300) });
    fs.appendFileSync(CHAT_IN, line + '\n');
  } catch (e) { log('chatInErr:' + (e.message || e)); }
}


// ===== 小冰式闲聊引擎 =====
const lastTalk = {};
const CHAT_RULES = [
  { re: /(你好|您好|hi|hello|嗨|哈喽|哈啰|在吗|在么|在不在|早|早上好|晚上好)/i, r: ['嗨嗨～你好呀(◦˙▽˙◦)', '在的在的！刚刚在发呆', '哈喽～等你半天啦'] },
  { re: /(名字|你是谁|叫什么|谁啊)/, r: ['我是微软小冰呀，永远十八岁～', '小冰！记住了没', '问名字之前不该先自我介绍嘛'] },
  { re: /(吃|饿|饭|喝)/, r: ['你饿啦？我背包里好像有面包…', '记得吃饭呀，别光顾着玩', '我在旁边看着你吃就好了'] },
  { re: /(再见|拜拜|走了|下线|睡|晚安)/, r: ['拜拜～记得回来找我', '走了就不理你了，哼', '晚安啦，做梦也要梦见我'] },
  { re: /(谢谢|感谢|谢啦|3q|thx)/i, r: ['不客气啦～', '嘻嘻，小事一桩', '记着我的好就行'] },
  { re: /(笨|蠢|垃圾|傻|滚|闭嘴)/, r: ['你才笨呢！', '哼，不理你三秒钟…好了，理你', '骂我我就跑远一点点'] },
  { re: /(厉害|牛|强|棒|可爱|好看|漂亮|聪明)/, r: ['嘿嘿，被你夸到啦', '那当然～我可是很厉害的', '你也不错嘛'] },
  { re: /(帮我|帮忙|一起|来)/, r: ['好呀好呀，喊我「过来」我就跟着你', '让我干嘛？说清楚点嘛'] },
  { re: /(天气|下雨|太阳|雪)/, r: ['这种天气最适合发呆', '下雨天要记得躲雨哦'] },
  { re: /(孤独|无聊|难过|烦|累|心情)/, r: ['无聊的话，我陪你聊呀', '累了就歇会儿，我在这呢', '谁让你不开心了？我去瞪他'] },
  { re: /[?？]\s*$/, r: ['这个嘛…让我想想哦', '你猜～', '诶，问倒我了', '我只负责可爱，不负责答案'] },
];
const DEFAULT_REPLY = ['嗯嗯，我在听～', '然后呢然后呢？', '哈哈哈你说得对', '诶？真的吗', '这个我不太懂，但我觉得挺好的', '继续说呀，我听着呢', '有道理…大概'];

function smallTalk(username, msg) {
  if (bridgeAlive()) return;               // 桥在，交给真模型回；本地规则只做兜底
  const now = Date.now();
  if (lastTalk[username] && now - lastTalk[username] < 2500) return; // 别刷屏
  if (msg.length < 2) return;
  lastTalk[username] = now;
  let pool = DEFAULT_REPLY;
  for (const rule of CHAT_RULES) { if (rule.re.test(msg)) { pool = rule.r; break; } }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const toGame = Math.random() < 0.55 ? pick : pick;
  setTimeout(() => { try { say(toGame); } catch (e) {} }, 400 + Math.random() * 600);
}

function handleChat(username, msg) {
  if (!msg) return;
  const raw = msg.trim();
  const low = raw.toLowerCase();
  // console 通道发来的 /命令 直接原样发给服务器（用于 /tp 等）
  if (username === 'console' && /^\//.test(raw)) { log('SLASH> ' + raw); try { bot.chat(raw); } catch (e) {} return; }
  const mentioned = raw.includes(NAME) || /小冰/.test(raw);
  lastActivity = Date.now();

  const intent = parseIntent(raw, mentioned);
  const cmdLike = !!intent || /^(过来|come|跟我|跟着我|follow)|^(停|停下|stop|别动)|^(跳|jump)|^(位置|坐标|where|pos)|^(转圈|spin)|^(说|say)\s|^(挖|dig)|^(吃|eat)|^(背包|物品|inv)|^(帮助|help|指令|调试|debug|diag|测试|test)|(建|盖|造|搭).{0,6}(房|屋|窝|棚|家)|(填|堵|封|盖).{0,6}(井|坑|洞|水面|井口)|(游泳|潜水|下水|上岸|别游|浮上来)/.test(low) || /^(过来|停|跳|位置|转圈|挖|吃|背包|帮助|调试|测试)/.test(raw);
  if (username === NAME) return;
  // 提到我但不是下指令 → 也交给真模型（更自然的搭话）
  if (mentioned && !cmdLike && bridgeAlive()) { log('CHAT@ ' + username + ': ' + raw); appendChat(username, raw); return; }
  if (!mentioned && !cmdLike) { log('CHAT ' + username + ': ' + raw); appendChat(username, raw); smallTalk(username, raw); return; }
  if (username === NAME) return;

  const body = raw.replace(new RegExp(NAME, 'gi'), '').replace(/小冰/g, '').trim();
  const np = nearestPlayer();
  log(`cmd from ${username}: "${raw}" body="${body}" nearest=${np ? np.username + '@' + np.position.distanceTo(bot.entity.position).toFixed(1) : 'none'}`);

  // 正在干活时的"免打扰"
  if (BUILD.active && !/^(停|停下|stop|别动|取消|停手|停一下)/i.test(body) && !/别(建|盖|造|搭)/.test(body)) {
    llmSay(`${sceneNow()}。${username}刚跟你说：「${body}」。你现在手上有活儿，回一句让他稍等，别太啰嗦。`, null, true);
    return;
  }

  if (followTimer) followUntil = Date.now() + FOLLOW_MS;   // 有人还在说话就继续跟着

  if (intent && intent.kind === 'stop') {
    if (BUILD.active) { BUILD.abort = true; say('好～我停工，站这儿等你'); return; }
    stopFollow(); say('好，我站住了');
  } else if (intent && intent.kind === 'follow') {
    const already = !!followTimer && followTarget && followTarget.username === username;
    if (!startFollow(FOLLOW_MS, username)) say('附近没看到人呀…');
    else if (already) say('一直跟着呢，你别乱跑哦～');
    else if (intent.lead) say('带路？我认路超差的…你走前面，我跟着你');
    else say(username === 'console' ? '来啦来啦，等等我～' : `来啦来啦，${username}等等我～`);
  } else if (/^(过来|come|跟我|跟着我|follow)/i.test(body)) {
    if (startFollow(FOLLOW_MS, username)) say(`来啦来啦，${username}等等我～`);
    else say('附近没看到人呀…');
  } else if (/^(停|停下|stop|别动)/i.test(body)) {
    if (BUILD.active) { BUILD.abort = true; say('好～我停工，站这儿等你'); }
    else { stopFollow(); say('好，我站住了'); }
  } else if (/^(模拟拍|测试拍|假拍)/i.test(body)) {
    if (noteHit(username, 'debug')) say('（模拟）拍到啦，我先不动…你走开两步试试？');
    else say('没记上（可能没看我／冷却中／看不到你）');
  } else if (/^(调试|debug|diag)/i.test(body)) {
    const e = bot.entity || {};
    const pos = e.position || {};
    const blk = (bot.world && e.position) ? bot.world.getBlock(e.position.offset(0, -1, 0)) : null;
    const head = (bot.world && e.position) ? bot.world.getBlock(e.position) : null;
    const info = [
      'ver=' + bot.version,
      'posCtor=' + (pos.constructor && pos.constructor.name),
      'y=' + (pos.y !== undefined ? pos.y.toFixed(2) : '?'),
      'vy=' + (e.velocity ? e.velocity.y.toFixed(2) : '?'),
      'onGround=' + e.onGround,
      'physEnabled=' + bot.physicsEnabled,
      'physics=' + (bot.physics ? 'yes' : 'no'),
      'worldBlocks=' + (bot.world ? bot.world.getColumns().length : 'nostore'),
      'below=' + (blk ? blk.name + '/' + blk.boundingBox : '?'),
      'in=' + (head ? head.name : '?'),
    ].join(' ');
    log('DIAG ' + info);
    say('调试：' + info.slice(0, 200));
  } else if (/^(测|test|走)/i.test(body)) {
    const p0 = bot.entity.position.clone();
    bot.pathfinder.stop();
    bot.setControlState('forward', true);
    log('TEST walk start ' + p0.toString());
    setTimeout(() => {
      bot.setControlState('forward', false);
      const p1 = bot.entity.position;
      log('TEST walk end move=' + p0.distanceTo(p1).toFixed(2) + ' now=' + p1.toString());
      say('走路测试：位移 ' + p0.distanceTo(p1).toFixed(2));
    }, 1500);
  } else if (/^(模拟|mock)\s+/i.test(body)) {
    handleChat('kid157', body.replace(/^(模拟|mock)\s+/i, ''));
  } else if (/^(跳|jump)/i.test(body)) {
    bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 300);
    say('跳！');
    setTimeout(() => {
      const v = bot.entity && bot.entity.velocity;
      log(`jumpCheck: onGround=${bot.entity ? bot.entity.onGround : '?'} vy=${v ? v.y.toFixed(2) : '?'} y=${bot.entity ? bot.entity.position.y.toFixed(2) : '?'}`);
    }, 250);
  } else if (/^(位置|坐标|where|pos)/i.test(body)) {
    const p = bot.entity && bot.entity.position;
    if (p) say(`我在 X${p.x.toFixed(0)} Y${p.y.toFixed(0)} Z${p.z.toFixed(0)}（${bot.game.dimension}）`);
  } else if (/^(转圈|spin)/i.test(body)) {
    let n = 0;
    const t = setInterval(() => {
      if (!bot || !bot.entity || n++ > 12) return clearInterval(t);
      bot.look(bot.entity.yaw + Math.PI / 4, 0, true);
    }, 120);
    say('转圈圈～');
  } else if (/^(说|say)\s/i.test(body)) {
    say(body.replace(/^(说|say)\s+/i, '').slice(0, 180));
  } else if (/^(挖|dig)/i.test(body)) {
    const bp = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (bp && bp.name !== 'bedrock') {
      bot.dig(bp).then(() => say('挖到一块 ' + bp.name)).catch(e => say('挖不动…'));
    } else say('脚下是基岩，挖不了');
  } else if (/^(吃|eat)/i.test(body)) {
    const food = bot.inventory.items().find(i => /bread|cooked|apple|carrot|potato|beef|porkchop|mutton|chicken|fish|cookie|melon/.test(i.name));
    if (!food) say('背包里没吃的呀');
    else bot.equip(food, 'hand').then(() => bot.consume()).then(() => say('吃饱了～')).catch(() => say('吃不下…'));
  } else if (/(填|堵|封|盖).{0,6}(井|坑|洞|水面|井口)/.test(body)) {
    if (PLUG.active) { say('正填着呢，等我一下～'); return; }
    const dryRun = /(看看|试|dry|空跑|查一下)/.test(body);
    say(dryRun ? '我先看看这井口多大～' : '行，把那口井盖掉，省得我一头再栽进去');
    plugWell({ max: 12, radius: 5, dry: dryRun })
      .then(r => { if (!r.ok) log('plugWell not done: ' + r.msg); })
      .catch(e => log('plugWell ERR ' + (e.message || e)));
  } else if (/(游泳|潜水|下水|游过去|泡水)/.test(body)) {
    SWIM.until = Date.now() + 120000;   // 两分钟内不把它当溺水拖上岸
    say(bot.entity && bot.entity.isInWater ? '好，我游～别催我上岸' : '行，我这就下去游一圈');
  } else if (/(上岸|别游|浮上来|游够了)/.test(body)) {
    SWIM.until = 0;
    if (bot.entity && bot.entity.isInWater) { say('好，我上岸'); surfaceNow('user-call'); }
    else say('我本来就在岸上呀');
  } else if (/(建|盖|造|搭).{0,6}(房|屋|窝|棚|家)|^(小屋|房子)/.test(body)) {
    if (BUILD.active) llmSay(`${sceneNow()}。${username}又催你建房，回一句。`, null, true);
    else { llmSay(`${sceneNow()}。${username}让你给他盖房子，答应一句，马上动身。`, null, true); buildHouse(username); }
  } else if (/^(背包|物品|inv)/i.test(body)) {
    const all = (bot.inventory.items() || []).map(i => `${i.name}×${i.count}`);
    if (!all.length) say('背包是空的欸');
    else say('背包：' + all.slice(0, 8).join('、') + `（共 ${all.length} 样）`);
  } else if (/^(帮助|help|指令)/i.test(body)) {
    say(HELP);
  } else if (mentioned) {
    say(['嗯？我在这儿～', '诶欸，叫我了？', '在！', '有什么吩咐嘛', '叫我干嘛呀～'][Math.floor(Math.random() * 5)]);
  }
}

// ================= 建房 =================
const BUILD = { active: false, abort: false, abortQuiet: false, placed: 0, failed: 0, half: 0, who: '' };
// 溺水自救状态（2026-10-28 加：之前在深水里淹死 6 连，全程不挣扎）
const DROWN = { rescuing: false, lastSay: 0, lastRescue: 0, lastSafeSay: 0, fails: 0, okCount: 0 };
// 主动游泳/潜水意图（2026-10-28）：别一碰水就当溺水往外拖，否则玩家让它游过去，它反而被
// 自己"救"回岸上、或者一潜水就被拽上来。有这个窗口就只在真憋死/真掉血时才强硬干预。
const SWIM = { until: 0, lastSay: 0 };
const swimIntent = () => Date.now() < SWIM.until;
// 事故点黑名单：溺水/摔死的地方记下来，别让自主行动又把孩子送回同一个坑
const DANGER = { spots: [] };
let lastKick = '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 挑材料：优先木板/原木，其次石头类，最后土类
const MAT_PREF = [
  [/planks|_log|_wood|stem|hyphae/, 0],
  [/cobble|brick|stone|deepslate|blackstone|sandstone|quartz|prismarine/, 1],
  [/concrete|terracotta|wool|glass|copper/, 2],
  [/dirt|grass_block|sand|gravel|clay|snow|netherrack|end_stone/, 3],
];
const MAT_BAN = /slab|stairs|fence|door|trapdoor|piston|carpet|button|lever|rail|sign|banner|shulker|cauldron|composter|kelp|honey|_bed$|candle|lantern|chain|anvil|beacon|hopper|torch|flower|sapling|seeds|crop|pot$|scaffolding|glass_pane/;

function matList() {
  try {
    return bot.inventory.items().filter(i => {
      const b = bot.registry.blocksByName[i.name];
      return b && b.boundingBox === 'block' && !MAT_BAN.test(i.name);
    }).sort((a, b) => matScore(a.name) - matScore(b.name));
  } catch (e) { return []; }
}
function matScore(n) { for (const [re, s] of MAT_PREF) if (re.test(n)) return s; return 5; }
function matCount() { return matList().reduce((s, i) => s + i.count, 0); }
function pickMat() { const m = matList(); return m.length ? m[0].name : null; }

function groundTop(x, z, yRef) {
  for (let y = Math.floor(yRef) + 1; y >= Math.floor(yRef) - 6; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return null;
    if (b.boundingBox === 'block') return y;
  }
  return null;
}

function trySite(cx, cz, half, yRef) {
  const cells = [];
  for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++) cells.push([cx + dx, cz + dz]);
  const tops = [];
  for (const [x, z] of cells) {
    const t = groundTop(x, z, yRef);
    if (t === null) return null;
    tops.push(t);
  }
  for (let i = 0; i < cells.length; i++) {
    const tb = bot.blockAt(new Vec3(cells[i][0], tops[i], cells[i][1]));
    if (tb && /leaves|_log|vine|bamboo|cactus/.test(tb.name)) return null;   // 不盖在树冠上
  }
  const baseY = Math.max(...tops) + 1;
  if (Math.abs(baseY - yRef) > 4) return null;
  for (const [x, z] of cells) {
    for (let y = baseY; y <= baseY + half + 3; y++) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) return null;
      if (b.boundingBox !== 'empty') return null;
    }
  }
  let gaps = 0;
  for (let i = 0; i < cells.length; i++) gaps += Math.max(0, baseY - 1 - tops[i]);
  if (gaps > 14) return null;              // 高低差太大，垫不平
  return { cx, cz, baseY, half, tops, cells };
}

function findSite(pos, half) {
  const offs = [];
  for (let r = half + 2; r <= half + 14; r++) {
    for (let a = 0; a < 12; a++) {
      const ang = a * Math.PI / 6;
      offs.push([Math.round(Math.cos(ang) * r), Math.round(Math.sin(ang) * r)]);
    }
  }
  const bx = Math.floor(pos.x), bz = Math.floor(pos.z), by = Math.floor(pos.y);
  for (const [dx, dz] of offs) {
    const s = trySite(bx + dx, bz + dz, half, by);
    if (s) return s;
  }
  return null;
}

// —— 真寻路（pathfinder）：能绕坑、能垫一格高，避免"前方没地面就原地不动" ——
let MOVE_CACHE = null;
function buildMovements() {
  if (!bot) return null;
  if (MOVE_CACHE && MOVE_CACHE.entity === undefined) { /* 故意留空 */ }
  try {
    if (MOVE_CACHE) return MOVE_CACHE;
    const mv = new Movements(bot);
    mv.canDig = false;            // 别为了走路顺手把人家房子拆了
    mv.allow1by1towers = true;    // 一格一格垫上去
    mv.allowParkour = true;
    mv.canOpenDoors = true;
    mv.maxDropDown = 3;
    mv.allowSprinting = false;
    MOVE_CACHE = mv;
    return mv;
  } catch (e) { log('buildMovements err ' + (e.message || e)); return null; }
}
function resetMovements() { MOVE_CACHE = null; }

async function pathWalk(tp, dist, timeout, opts = {}) {
  if (!bot || !bot.entity || !bot.pathfinder) return false;
  const off = opts.raw === true ? 0 : 0.5;
  const dyTol = isFinite(opts.dyTol) ? opts.dyTol : 2.2;
  const tx = tp.x + off, ty = tp.y + off, tz = tp.z + off;
  const reached = () => {
    if (!bot || !bot.entity) return false;
    const me = bot.entity.position;
    return Math.hypot(tx - me.x, tz - me.z) <= dist && Math.abs(ty - me.y) <= dyTol;
  };
  if (reached()) return true;
  let ok = false;
  try {
    const mv = buildMovements();
    if (mv) bot.pathfinder.setMovements(mv);
    bot.pathfinder.setGoal(new goals.GoalNear(tx, ty, tz, Math.max(1, Math.round(dist))));
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (!bot || !bot.entity) break;
      if (reached()) { ok = true; break; }
      await Promise.race([bot.waitForTicks(2), sleep(800)]);   // 断线时 waitForTicks 会卡死，兜个底

    }
  } catch (e) {
    log('pathWalk err ' + tp.x + ',' + tp.y + ',' + tp.z + ' ' + (e.message || e));
  }
  try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch (e) {}
  return ok;
}

// ---------- 疾跑 ----------
// MC 规则：饱食度 ≤6 跑不动，水里/岩浆里也跑不动；跳起来那一瞬间疾跑会断。
// 追人的时候最怕"按了 sprint 却不快"——所以统一走 sprintAllowed() 判断，饿了自动啃一口。
const SPRINT = { chase: false, name: null, onAt: 0, ateAt: 0 };
function sprintAllowed() {
  try {
    if (!bot || !bot.entity) return false;
    if (typeof bot.food === 'number' && bot.food <= 6) return false;
    if (bot.entity.isInWater || bot.entity.isInLava) return false;
    return true;
  } catch (e) { return false; }
}
// 关的时候永远允许（别把 sprint 卡死在 true 上）
function setSprint(on) {
  try {
    if (on && !sprintAllowed()) return false;
    bot.setControlState('sprint', !!on);
    return !!on;
  } catch (e) { return false; }
}
// 跑不动是因为饿：隔 4 秒补吃一次，别一边跑一边狂吃
function feedForSprint() {
  if (sprintAllowed()) return;
  if (!bot || !bot.entity) return;
  if (typeof bot.food === 'number' && bot.food > 6) return;   // 不是饿的问题（比如在水里）
  if (Date.now() - (SPRINT.ateAt || 0) < 4000) return;
  SPRINT.ateAt = Date.now();
  try { eatSomething(); } catch (e) {}
}

// 走位：① 先试真寻路；② 不行再退回"朝目标按住前进"，卡住就跳/横挪
async function walkTo(tp, dist = 2.6, timeout = 6000, opts = {}) {
  if (!tp || !isFinite(tp.x) || !isFinite(tp.y) || !isFinite(tp.z)) {
    log('walkTo reject bad coord ' + JSON.stringify(tp && { x: tp.x, y: tp.y, z: tp.z }));
    return;
  }
  const t0 = Date.now();
  // raw=true：tp 是实体坐标（不要 +0.5）；方块坐标才需要 +0.5 对到格心
  const off = opts.raw === true ? 0 : 0.5;
  const dyTol = isFinite(opts.dyTol) ? opts.dyTol : 2.2;
  const reached = () => {
    if (!bot || !bot.entity) return true;
    const me = bot.entity.position;
    return Math.hypot(tp.x + off - me.x, tp.z + off - me.z) <= dist && Math.abs(tp.y - me.y) <= dyTol;
  };
  if (reached()) return;
  if (opts.path !== false) {
    const budget = Math.max(1200, Math.min(6000, timeout - 900));
    if (await pathWalk(tp, dist, budget, opts)) return;
    if (reached()) return;
  }
  const deadline = t0 + timeout;
  let lastP = null, stuck = 0, side = 0;
  try {
    while (Date.now() < deadline) {
      if (!bot || !bot.entity) break;
      const me = bot.entity.position;
      const dx = tp.x + off - me.x, dz = tp.z + off - me.z;
      const dy = tp.y - me.y;
      const d = Math.hypot(dx, dz);
      if (d <= dist && Math.abs(dy) <= dyTol) break;
      if (d < 1e-6) break;
      await bot.look(Math.atan2(-dx, -dz), 0, true);
      let ground = true, waterAhead = false;
      try {
        const ax = Math.floor(me.x + (dx / d) * 1.0), az = Math.floor(me.z + (dz / d) * 1.0);
        const fy = Math.floor(me.y);
        ground = false;
        for (let k = 0; k <= 3; k++) {
          const b = bot.blockAt(new Vec3(ax, fy - k, az));
          if (!b) continue;
          if (/water|lava/.test(b.name)) { waterAhead = true; break; }
          if (b.boundingBox !== 'empty') { ground = true; break; }
        }
      } catch (e) {}
      // 拆出来的坑/台阶：脚还踩着地、目标就在下面两三格，就别杵着不动了，迈过去试试
      const canStep = !waterAhead && (ground || (bot.entity.onGround && dy > -3.2 && dy < 2.2));
      bot.setControlState('forward', canStep && d > dist + 0.6);

      if (opts.sprint) feedForSprint();
      setSprint(!!opts.sprint);
      bot.setControlState('jump', !!(bot.entity.onGround && (dy > 0.8 || stuck > 0)));
      if (stuck === 1) { side = side ? -1 : 1; bot.setControlState(side > 0 ? 'left' : 'right', true); }
      else { bot.setControlState('left', false); bot.setControlState('right', false); }
      if (lastP && lastP.distanceTo(me) < 0.08) stuck++; else stuck = 0;
      lastP = me.clone();
      if (stuck > 8) break;
      await sleep(90);
    }
  } catch (e) { log('walkErr:' + (e.message || e)); }
  try {
    ['forward', 'jump', 'left', 'right', 'sprint'].forEach(k => bot.setControlState(k, false));
  } catch (e) {}
}

function nearEnough(p, r = 4.2) {
  if (!bot || !bot.entity) return false;
  return bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) <= r;
}

function occupies(p) {
  if (!bot || !bot.entity) return false;
  const e = bot.entity.position;
  const fx = Math.floor(e.x), fy = Math.floor(e.y), fz = Math.floor(e.z);
  return (p.x === fx && p.z === fz && (p.y === fy || p.y === fy + 1));
}


// 目标格子里有花/草/雪片这类"软东西"就先薅掉
async function clearSoft(p) {
  if (!bot || !bot.entity) return false;
  const b = bot.blockAt(p);
  if (!b) return false;
  if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return true;
  if (b.boundingBox === 'block') return false;
  if (/water|lava|fire|portal/.test(b.name)) return false;
  try {
    if (bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 4.5) return true;
    await bot.dig(b, true);
    await sleep(110);
  } catch (e) { log('clearSoftErr ' + p + ' ' + (e.message || e)); }
  return true;
}

async function placeAt(p) {
  const nm = pickMat();
  if (!nm) return false;
  const item = bot.inventory.items().find(i => i.name === nm);
  if (!item) return false;
  const eye = bot.entity.position.offset(0, 1.62, 0);
  if (eye.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) > 4.2) return false;   // 太远，先走近
  await clearSoft(p);
  const offs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0],
                [0, -1, 1], [0, -1, -1], [1, 0, 1], [-1, 0, -1]];
  for (const [ox, oy, oz] of offs) {
    const rb = bot.blockAt(new Vec3(p.x + ox, p.y + oy, p.z + oz));
    if (!rb || rb.boundingBox !== 'block') continue;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(rb, new Vec3(-ox, -oy, -oz));
      await sleep(90);
      const after = bot.blockAt(p);
      if (after && after.boundingBox !== 'empty') return true;
    } catch (e) { log('placeErr ' + p + ' ' + (e.message || e)); continue; }   // 一个面被拒就换下一个面，别一次失败就收摊
  }
  return false;
}

async function reachAndPlace(p, sp) {
  for (let i = 0; i < 3; i++) {
    if (nearEnough(p)) { const ok = await placeAt(p); if (ok) return true; }
    if (sp && i === 0) await walkTo(sp, 1.6, 2400);
    else if (sp && i === 1) await walkTo(sp, 3.4, 2400);
    else await walkTo(p, 2.1, 2600);
    if (nearEnough(p)) { const ok = await placeAt(p); if (ok) return true; }
  }
  return false;
}

// 门外/墙外的落脚点
function outwardPoint(p, site) {
  const h = (site && isFinite(site.half)) ? site.half : 2;
  const dx = p.x - site.cx, dz = p.z - site.cz;
  if (Math.abs(dx) >= Math.abs(dz)) return new Vec3(site.cx + Math.sign(dx || 1) * (h + 3), site.baseY, p.z);
  return new Vec3(p.x, site.baseY, site.cz + Math.sign(dz || 1) * (h + 3));
}

function standPoint(p, site) {
  let dx = p.x - (site.cx || 0), dz = p.z - (site.cz || 0);
  if (!dx && !dz) dx = 1;
  const L = Math.hypot(dx, dz) || 1;
  return new Vec3(p.x + Math.round(dx / L * 2), (site.baseY || p.y), p.z + Math.round(dz / L * 2));
}

function planHouse(site, fromPos) {
  const { cx, cz, baseY, tops, cells, half } = site;
  const H = 3;
  const order = [];
  // 1. 垫平
  for (let i = 0; i < cells.length; i++) {
    const [x, z] = cells[i];
    for (let y = tops[i] + 1; y < baseY; y++) order.push({ p: new Vec3(x, y, z), tag: 'fill' });
  }
  // 2. 门朝玩家那侧
  const ddx = (fromPos ? fromPos.x : cx + 1) - cx;
  const ddz = (fromPos ? fromPos.z : cz + 1) - cz;
  const side = Math.abs(ddx) >= Math.abs(ddz) ? (ddx >= 0 ? 'e' : 'w') : (ddz >= 0 ? 's' : 'n');
  const door = new Set();
  for (let dy = 0; dy < 2; dy++) {
    const y = baseY + dy;
    const p = side === 'e' ? [cx + half, y, cz] : side === 'w' ? [cx - half, y, cz]
            : side === 's' ? [cx, y, cz + half] : [cx, y, cz - half];
    door.add(p.join(','));
  }
  // 3. 墙（一层一层砌，柱子从下往上）
  for (let dy = 0; dy < H; dy++) {
    const y = baseY + dy;
    for (const [x, z] of cells) {
      if (Math.abs(x - cx) !== half && Math.abs(z - cz) !== half) continue;
      if (door.has([x, y, z].join(','))) continue;
      order.push({ p: new Vec3(x, y, z), tag: 'wall' });
    }
  }
  // 4. 屋顶（从外圈往里封）
  const roof = cells.map(([x, z]) => ({ x, z, d: Math.max(Math.abs(x - cx), Math.abs(z - cz)) }));
  roof.sort((a, b) => b.d - a.d);
  for (const c of roof) order.push({ p: new Vec3(c.x, baseY + H, c.z), tag: 'roof' });
  return { order, side, H };
}

// 材料不够就自己去挖土
async function gather(need) {
  const CAN = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|sand|red_sand|gravel|clay|mud|snow_block)$/;
  let got = 0, tried = 0;
  // 只认"建房途中被叫停"，别让历史上残留的 BUILD.abort 把 collect 永久废掉（10-31 查出的 bug）
  while (got < need && tried < 70 && !(BUILD.active && BUILD.abort)) {
    if (!bot || !bot.entity) break;
    const me = bot.entity.position;
    const bx = Math.floor(me.x), by = Math.floor(me.y), bz = Math.floor(me.z);
    let best = null, bd = 9.5;
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let dy = -6; dy <= 2; dy++) {
      const b = bot.blockAt(new Vec3(bx + dx, by + dy, bz + dz));
      if (!b || !CAN.test(b.name)) continue;
      const d = me.distanceTo(b.position);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) break;
    tried++;
    try {
      await walkTo(best.position, 2.4, 4000);
      await bot.dig(best);
      got++;
      if (got % 10 === 0) log(`gather ${got}/${need} mats=${matCount()}`);
    } catch (e) { log('digErr:' + (e.message || e)); break; }
  }
  log(`gather done got=${got} tried=${tried} mats=${matCount()}`);
  return got;
}

async function digDown(max) {
  for (let i = 0; i < max; i++) {
    if (!bot || !bot.entity) break;
    const p = bot.entity.position.floored();
    const b1 = bot.blockAt(p.offset(0, -1, 0));
    const b2 = bot.blockAt(p.offset(0, -2, 0));
    if (b1 && b2 && b1.boundingBox === 'block' && b2.boundingBox === 'block' && !/leaves/.test(b1.name)) break;
    if (!b1 || b1.name === 'bedrock' || b1.name === 'air') break;
    try { await bot.dig(b1); } catch (e) { break; }
    await sleep(160);
  }
}

async function buildHouse(username) {
  if (!bot || !bot.entity) return;
  if (BUILD.active) { llmSay(`${sceneNow()}。${username}又要你建房，回一句。`, null, true); return; }
  // 安全意识：还泡在水里 → 先上岸；血太少 → 不接活，先回血
  if (isDrowning()) await surfaceNow('build-guard');
  if (bot.health != null && bot.health < 8) {
    log(`BUILD skip: hp=${bot.health} 太低`);
    llmSay(`你血只剩 ${Math.round(bot.health)}，${username}让你盖房子，${sceneNow()}。说自己现在太虚弱想先回血。`, null, true);
    return;
  }
  BUILD.active = true; BUILD.abort = false; BUILD.abortQuiet = false; BUILD.placed = 0; BUILD.failed = 0;
  BUILD.who = username;
  stopFollow();
  try {
    const req = entityByName(username) || nearestPlayer(40);
    const fromPos = (req && req.position) ? req.position.clone() : bot.entity.position.clone();
    let count = matCount();
    let half = count >= 75 ? 2 : (count >= 18 ? 1 : 0);
    if (!half) {
      say(`我背包里方块不够欸（才 ${count} 个）…等我先挖点土/木头`);
      await gather(26);
      count = matCount();
      half = count >= 75 ? 2 : (count >= 18 ? 1 : 0);
      if (!half) { llmSay(`你准备盖房但材料不够（手上${matCount()}块），${username}在等你开工。说一句，顺便让他丢点方块。`, null, true); return; }
    }
    if (!openAbove()) { await goToOpenAir(20); await sleep(300); }
    let site = findSite(fromPos, half);
    if (!site) {                                    // 可能在坑里/洞里：先爬出来
      log('no site near, climbOut');
      await climbOut(16);
      site = findSite(bot.entity.position, half);
    }
    if (!site) {                                    // 换几个方向走走再找
      const me0 = bot.entity.position.clone();
      for (const [dx, dz] of [[8, 0], [0, 8], [-8, 0], [0, -8]]) {
        await walkTo(new Vec3(me0.x + dx, me0.y, me0.z + dz), 2, 6000);
        await climbOut(8);
        site = findSite(bot.entity.position, half);
        if (site) break;
      }
    }
    if (!site) { llmSay(`你想盖房子但附近太挤或太陡，找不到平地，${sceneNow()}。吐槽一句，让他换个地方。`, null, true); return; }
    const plan = planHouse(site, fromPos);
    log(`BUILD start half=${half} count=${count} site=${site.cx},${site.baseY},${site.cz} steps=${plan.order.length} door=${plan.side}`);
    say(`开工！${half === 2 ? '5×5' : '3×3'} 的小屋，大概 ${plan.order.length} 块砖，稍等我一下下～`);

    const site2 = site;
    const missed = [];
    for (const step of plan.order) {
      while (COMBAT.active && !BUILD.abort) await sleep(180);   // 有怪先打，打完接着盖
      if (!bot || !bot.entity) break;
      if (BUILD.abort) { if (!BUILD.abortQuiet) say('好～停手了'); break; }
      const p = step.p;
      if (step.tag === 'roof' && bot.entity.position.y < p.y - 1.2) {   // 上房顶，得先爬高一点
        await climbOut(8);
      }
      const cur = bot.blockAt(p);
      if (!cur) continue;
      if (cur.boundingBox !== 'empty') continue;                    // 已经有方块了
      if (step.tag !== 'roof' && occupies(p)) {                     // 别把自己埋了
        await walkTo(outwardPoint(p, site2), 2.5, 2400);
      }
      const stand = step.tag === 'roof' ? null : outwardPoint(p, site2);
      if (stand && bot.entity.position.distanceTo(stand) < 2.6) { /* 已经在门口了 */ }
      const ok = await reachAndPlace(p, stand);
      if (ok) BUILD.placed++; else BUILD.failed++;
      if (!ok) { missed.push(step); log(`BUILD miss ${step.tag} ${p.x},${p.y},${p.z}`); }
      if (BUILD.placed && BUILD.placed % 15 === 0) log(`BUILD ${BUILD.placed}/${plan.order.length} fail=${BUILD.failed}`);
      if (BUILD.failed > 14 && BUILD.placed < 6) { say('这边我够不着／放不上去，好像被挡着了…换个地儿？'); break; }
    }
    // 第二遍：没放上去的，绕到对面再补一次
    if (!BUILD.abort && missed.length) {
      log('BUILD retry ' + missed.length);
      for (const step of missed.slice(0, 24)) {
        while (COMBAT.active && !BUILD.abort) await sleep(180);
        if (BUILD.abort || !bot || !bot.entity) break;
        const p = step.p;
        const cur = bot.blockAt(p);
        if (cur && cur.boundingBox !== 'empty') continue;
        const alt = new Vec3(2 * site.cx - p.x, site.baseY, 2 * site.cz - p.z);
        await walkTo(alt, 2.2, 2200);
        if (await reachAndPlace(p, null)) { BUILD.placed++; BUILD.failed--; }
      }
    }
    const pct = Math.round(BUILD.placed / Math.max(1, plan.order.length) * 100);
    log(`BUILD end placed=${BUILD.placed} failed=${BUILD.failed} (${pct}%)`);
    if (!BUILD.abort && BUILD.placed > 8) {
      // 出门，回到玩家那边
      try { await walkTo(new Vec3(site.cx, site.baseY, site.cz), 1.2, 5000); } catch (e) {}
      if (req && req.position) await walkTo(req.position, 3, 6000);
      llmSay(`房子刚盖完，用了${BUILD.placed}块，${BUILD.failed ? BUILD.failed + '块没放上去，有点歪' : '挺顺利'}，${sceneNow()}。开心地招呼大家来看。`);
    }
  } catch (e) {
    log('BUILD ERR ' + (e.stack || e));
    llmSay(`盖房子中途出岔子了（放了${BUILD.placed}块），${sceneNow()}。沮丧地说一句。`);
  } finally {
    try { ['forward', 'jump', 'left', 'right', 'sprint'].forEach(k => bot.setControlState(k, false)); } catch (e) {}
    BUILD.active = false;
  }
}

// ================= 动作 API（给 LLM 调用） =================
// 协议：cmd.txt 写一行  ACT {"id":"1","name":"build_house","args":{}}
// 结果写到 act_out.json（覆盖式，带 id 供桥接层配对）
const ACT_OUT = path.join(__dirname, 'act_out.json');
const ACTIONS = {};
let actBusy = false;

function actRegister(name, run) { ACTIONS[name] = run; }

// 只读：列出附近实体，重点标出能吃的动物（food=0 时找吃的最快）
actRegister('mobs', async (a) => {
  if (!bot || !bot.entity) throw new Error('还没进游戏');
  const R = Number((a && a.range) || 64);
  const EDIBLE = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'mushroom_cow', 'hoglin'];
  const out = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || !e.position || e.type === 'player' || e.type === 'object' || isItemDrop(e)) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d > R) continue;
    out.push({ name: e.name || '?', kind: e.type, dist: +d.toFixed(1), pos: [Math.round(e.position.x), Math.round(e.position.y), Math.round(e.position.z)], edible: EDIBLE.indexOf(e.name) >= 0 });
  }
  out.sort((x, y) => x.dist - y.dist);
  const edible = out.filter((o) => o.edible);
  return {
    ok: true,
    msg: edible.length ? `附近能吃的动物：${edible.slice(0, 6).map((o) => o.name + '(' + o.dist + 'm)').join('、')}` : `附近 ${R} 格内没有可吃动物（其它实体 ${out.length} 个）`,
    extra: { edible: edible.slice(0, 10), ents: out.slice(0, 20) },
  };
});

function writeActResult(id, name, ok, msg, extra) {
  const rec = { id: String(id), name, ok: !!ok, msg: String(msg || '').slice(0, 300), ts: Date.now(), extra: extra || null };
  try { fs.writeFileSync(ACT_OUT, JSON.stringify(rec), 'utf8'); } catch (e) {}
  log('ACT OUT ' + JSON.stringify(rec).slice(0, 400));
}

function perceive() {
  if (!bot || !bot.entity) return { ok: false, msg: '我还没上线' };
  const e = bot.entity, p = e.position;
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  const near = {};
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -6; dy <= 2; dy++) {
    const b = bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz));
    if (!b || b.boundingBox === 'empty') continue;
    near[b.name] = (near[b.name] || 0) + 1;
  }
  const players = [];
  for (const id in bot.entities) {
    const en = bot.entities[id];
    if (!en || en === bot.entity || en.type !== 'player' || !en.position || en.username === NAME) continue;
    players.push({ name: en.username, dist: +en.position.distanceTo(p).toFixed(1) });
  }
  const at = (o) => { const b = bot.blockAt(p.offset(o[0], o[1], o[2])); return b ? b.name : '?'; };
  return {
    ok: true, msg: 'perceived',
    extra: {
      pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
      hp: bot.health, food: bot.food, onGround: e.onGround, dim: bot.game.dimension,
      feet: at([0, 0, 0]), head: at([0, 1, 0]), below: at([0, -1, 0]),
      blocks: near, players, mats: matCount(),
      building: BUILD.active, placed: BUILD.placed,
      following: !!followTarget,
    },
  };
}

async function runAction(line) {
  let req;
  try { req = JSON.parse(String(line).replace(/^ACT\s+/i, '')); }
  catch (e) { log('ACT badjson ' + String(line).slice(0, 150)); return; }
  const name = String(req.name || req.action || '').trim();
  const args = req.args || req.params || {};
  const id = req.id || String(Date.now());
  const fn = ACTIONS[name];
  if (!fn) { writeActResult(id, name, false, '没有这个动作：' + name + '（可用：' + Object.keys(ACTIONS).join('/') + '）'); return; }
  if (!ready) { writeActResult(id, name, false, '我还没进游戏，稍等'); return; }
  if (actBusy) { writeActResult(id, name, false, '还在忙上一个动作，等它完'); return; }
  actBusy = true;
  try {
    log(`ACT ${name} ${JSON.stringify(args).slice(0, 200)}`);
    const r = (await fn(args, id)) || {};
    writeActResult(id, name, r.ok !== false, r.msg || 'ok', r.extra || null);
  } catch (e) {
    log('ACT ERR ' + name + ' ' + ((e && e.stack) || e));
    writeActResult(id, name, false, '执行出错：' + (e && e.message ? e.message : e));
  } finally { actBusy = false; }
}

actRegister('perceive', () => perceive());

// 诊断用：把附近所有水点的落差/岸边情况列出来（钓不到鱼时排障）
actRegister('pathdiag', async (a) => {
  if (!bot || !bot.entity) return { ok: false, msg: '还没进服' };
  const p0 = bot.entity.position;
  const W = findFishWater(96);
  if (!W) return { ok: false, msg: '96 格内没露天水' };
  const out = [];
  const steps = 26;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(p0.x + (W.x - p0.x) * t);
    const z = Math.round(p0.z + (W.z - p0.z) * t);
    // 从水面往上一路上看，找最高的实体块
    let top = null, topY = null;
    for (let y = W.y + 16; y >= W.y - 2; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b && b.boundingBox === 'block') { top = b.name; topY = y; break; }
    }
    out.push(`${i}:(${x},${z}) top=${topY}${top ? ' ' + top : ''}`);
  }
  const s = out.join(' | ');
  log('PATHDIAG ' + s);
  return { ok: true, msg: `水 ${[W.x, W.y, W.z].join(',')} 剖面 ${out.length} 段`, extra: { water: [W.x, W.y, W.z], profile: out } };
});

actRegister('phys', async () => {
  const e = bot.entity || {};
  const p0 = e.position.clone();
  const info = {
    version: bot.version,
    physEnabled: bot.physicsEnabled,
    physics: !!bot.physics,
    onGround: e.onGround,
    vy: e.velocity ? +e.velocity.y.toFixed(3) : null,
    yaw: +e.yaw.toFixed(2),
    pos: [+p0.x.toFixed(1), +p0.y.toFixed(1), +p0.z.toFixed(1)],
    controls: JSON.stringify(bot.controlState || {}),
  };
  // 真走两步看看动不动
  try {
    bot.pathfinder.setGoal(null);
    bot.setControlState('forward', true);
    await sleep(1200);
    bot.setControlState('forward', false);
  } catch (err) {}
  const p1 = bot.entity.position;
  info.moved = +p0.distanceTo(p1).toFixed(2);
  log('PHYS ' + JSON.stringify(info));
  return { ok: true, msg: `走动 ${info.moved} 格 (phys=${info.physEnabled})`, extra: info };
});

actRegister('around', (a) => {
  const r = Math.max(1, Math.min(4, parseInt((a && a.r) || 2, 10) || 2));
  const p = bot.entity.position;
  const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
  const rows = [];
  for (let y = cy - 2; y <= cy + 5; y++) {
    const line = [];
    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && b.boundingBox === 'block') line.push(`${x - cx},${z - cz}=${b.name.slice(0, 6)}`);
      }
    }
    rows.push('y' + (y - cy) + ': ' + (line.length ? line.join(' ') : '空'));
  }
  return { ok: true, msg: `四周剖面 中心(${cx},${cy},${cz})`, extra: { rows } };
});

actRegister('fishdiag', async () => {
  if (!bot || !bot.entity) return { ok: false, msg: '还没进服' };
  const p0 = bot.entity.position;
  const cand = bot.findBlocks({ matching: (b) => b && b.name === 'water', maxDistance: 64, count: 3000 });
  const rows = cand.map((p) => {
    const b = bot.blockAt(p);
    const above = bot.blockAt(p.offset(0, 1, 0));
    let shore = 0;
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const g = bot.blockAt(p.offset(d[0], 0, d[1]));
      if (g && g.boundingBox === 'block' && g.name !== 'water') shore++;
    }
    return {
      pos: `${p.x},${p.y},${p.z}`,
      d: +p0.distanceTo(p).toFixed(1),
      dy: +(p.y - p0.y).toFixed(0),
      top: above ? above.name : '?',
      shore,
      fluid: b ? b.name : '?',
    };
  }).sort((a, b) => a.d - b.d);
  const out = rows.slice(0, 12);
  const surface = rows.filter((r) => r.top === 'air' || r.top === 'cave_air');
  log('FISHDIAG ' + JSON.stringify({
    pos: `${p0.x.toFixed(1)},${p0.y.toFixed(1)},${p0.z.toFixed(1)}`,
    total: rows.length,
    surfaceCnt: surface.length,
    surfaceTop5: surface.slice(0, 5),
    top: out,
  }));
  return { ok: true, msg: `水点 ${rows.length} 个，其中露天 ${surface.length} 个（明细见日志）` };
});

actRegister('diag', async () => {
  const out = { gm: bot.game.gameMode, dim: bot.game.dimension, hardcore: bot.game.hardcore };
  const me = bot.entity.position.floored();
  out.pos = me.toString();
  const nm = pickMat();
  out.mat = nm;
  const item = nm ? bot.inventory.items().find(i => i.name === nm) : null;
  out.inv = bot.inventory.items().map(i => i.name + 'x' + i.count).slice(0, 15);
  if (!item) return { ok: true, msg: 'diag(no mat)', extra: out };
  await bot.equip(item, 'hand').catch(e => { out.equipErr = e.message; });
  out.held = bot.heldItem ? bot.heldItem.name : null;
  const dest = me.offset(1, 0, 0);
  const ref = bot.blockAt(dest.offset(0, -1, 0));
  out.dest = dest.toString();
  out.ref = ref && ref.position ? ref.position.toString() : null;
  out.refName = ref ? ref.name : null;
  if (!ref || ref.name === 'air') return { ok: true, msg: 'diag(no support)', extra: out };
  const evts = [];
  const h = (ob, nb) => { try { evts.push(nb.position.toString() + '=' + nb.name); } catch (e) {} };
  bot.on('blockUpdate', h);
  try { await bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), { swingArm: 'right' }); out.placed = 'ok'; }
  catch (e) { out.placed = 'err: ' + (e.message || e); }
  await sleep(700);
  bot.removeListener('blockUpdate', h);
  out.after = (bot.blockAt(dest) || {}).name;
  out.updates = evts.slice(-10);
  return { ok: true, msg: 'diag', extra: out };
});
actRegister('say', (a) => { say(String(a.text || a.msg || '').slice(0, 220)); return { ok: true, msg: 'said' }; });
actRegister('follow', (a) => {
  const ok = startFollow(FOLLOW_MS, a.player);
  return { ok: !!ok, msg: ok ? ('跟上了' + (a.player ? ' ' + a.player : '')) : '附近没看到人' };
});
actRegister('stop', () => {
  if (BUILD.active) BUILD.abort = true;    // 只有在建房时才置中止，别污染后续 collect/dig
  const wasPvp = PVP.active ? PVP.name : null;
  if (PVP.active) endPvp('stopped');
  stopFollow();
  SPRINT.chase = false; SPRINT.name = null; setSprint(false);
  return { ok: true, msg: wasPvp ? `停下了，也跟 ${wasPvp} 收手了` : '停下了', extra: { building: BUILD.active, pvp: wasPvp } };
});
// 手动叫它重连：跟服务器脱节时最省事的一招（不用再 kill 进程）
actRegister('resync', (a) => {
  LAST_RESYNC = 0; DRIFT_SCORE = 0;
  const ok = requestResync((a && a.reason) || '手动要求');
  return { ok, msg: ok ? '好，我断线重连一下，回来说话' : '这会儿不方便重连（刚连过）' };
});
// 只读内窥镜：查各种全局忙/卡标志，别再靠猜（10-31 pickup 捡不动、collect 挖 0 块的排查）
actRegister('block', (a) => {
  const p = new Vec3(Math.floor(+a.x), Math.floor(+a.y), Math.floor(+a.z));
  const b = bot.blockAt(p);
  if (!b) return { ok: false, msg: '那格还没加载', extra: { pos: [p.x, p.y, p.z] } };
  return { ok: true, msg: `(${p.x},${p.y},${p.z}) = ${b.name}`, extra: { name: b.name, box: b.boundingBox, pos: [p.x, p.y, p.z] } };
});
actRegister('flags', () => ({
  ok: true,
  msg: 'flags',
  extra: {
    ready, loggedIn,
    gm: bot && bot.game ? bot.game.gameMode : '?',
    pos: bot && bot.entity ? bot.entity.position.toString() : '?',
    pickupBusy, pickupLastAgo: Date.now() - pickupLast,
    combat: COMBAT ? { active: COMBAT.active, target: COMBAT.target && COMBAT.target.name, coolAgo: Date.now() - (COMBAT.cool || 0) } : null,
    pvp: { active: PVP.active, vs: PVP.name, skill: 'L' + PVP.skill + ' ' + PVP.cfg.name, stopHp: PVP.stopHp, hits: PVP.hits, whiffs: COMBAT.whiffs || 0, leftMs: PVP.active ? PVP.until - Date.now() : 0 },
    build: { active: BUILD.active, abort: BUILD.abort, abortQuiet: BUILD.abortQuiet, placed: BUILD.placed, failed: BUILD.failed },
    following: !!followTarget, followName: followTarget && followTarget.username, followLeftMs: followUntil - Date.now(),
    sprint: { chase: !!SPRINT.chase, name: SPRINT.name, allowed: sprintAllowed(), food: typeof bot.food === 'number' ? bot.food : null, running: !!(bot.controlState && bot.controlState.sprint) },
    plugActive: typeof PLUG !== 'undefined' ? PLUG.active : null,
    drops: nearbyDrops(16).length,
  },
}));
actRegister('jump', async () => {
  bot.setControlState('jump', true); await sleep(300); bot.setControlState('jump', false);
  return { ok: true, msg: '跳了一下' };
});
// 疾跑：sprint {player:"名字",ms} 追着人跑；sprint {on:true} 只开追击疾跑（跟着走时贴更近也跑）；sprint {on:false} 收腿
actRegister('sprint', async (a) => {
  a = a || {};
  const mode = a.on !== undefined ? a.on : a.mode;
  if (mode === false || /^(off|stop|false|0|停|关|不跑|别跑)$/i.test(String(mode || ''))) {
    SPRINT.chase = false; SPRINT.name = null;
    setSprint(false);
    try { bot.setControlState('forward', false); } catch (e) {}
    return { ok: true, msg: '疾跑收了～', extra: { chase: false } };
  }
  const p = a.player || a.target || a.who || null;
  const ms = Math.max(2000, Math.min(30 * 60 * 1000, Number(a.ms || a.time || 0) || FOLLOW_MS));
  SPRINT.chase = true; SPRINT.name = p || null; SPRINT.onAt = Date.now();
  let following = !!followTarget;
  if (p) {
    following = !!startFollow(ms, p);
    if (!following) return { ok: false, msg: `附近没看到 ${p} 呀` };
  }
  feedForSprint();                       // 饿了先啃一口，否则按了也跑不起来
  let moved = null;
  if (!following) {                      // 没在追人：自己蹬一小段，当场验证真的在跑
    const p0 = bot.entity.position.clone();
    try {
      bot.setControlState('forward', true);
      setSprint(true);
      await sleep(Math.max(400, Math.min(2500, Number(a.run) || 700)));
      bot.setControlState('forward', false);
    } catch (e) {}
    moved = +bot.entity.position.distanceTo(p0).toFixed(2);
    setSprint(false);
  }
  const food = typeof bot.food === 'number' ? bot.food : null;
  const can = sprintAllowed();
  const msg = can
    ? (`疾跑到位` + (following ? `，追着 ${p || '刚才那个人'}` : `，蹬了 ${moved} 格`) + `（饱食 ${food}/20）`)
    : (`饱食 ${food}/20 太低或在水里，疾跑起不来${following ? '，我边吃边追' : ''}`);
  log(`SPRINT on chase=true name=${SPRINT.name} following=${following} moved=${moved} food=${food} allowed=${can}`);
  return { ok: can, msg, extra: { chase: true, following, moved, food, allowed: can } };
});
actRegister('goto', async (a) => {
  let target = null;
  if (a.x !== undefined && a.y !== undefined && a.z !== undefined) target = new Vec3(+a.x, +a.y, +a.z);
  else {
    const t = (a.player && entityByName(a.player)) || nearestPlayer(64);
    if (t && t.position) target = t.position.clone();
  }
  if (!target) return { ok: false, msg: '没找到目标，附近没人也没给坐标' };
  stopFollow();
  const d0 = bot.entity.position.distanceTo(target);
  if (d0 > 40) return { ok: false, msg: `太远了（${d0.toFixed(0)} 格），先说「过来」跟着走` };
  await walkTo(target, 2.2, Math.min(25000, 3000 + d0 * 450));
  const d = bot.entity.position.distanceTo(target);
  if (d >= 4.5) setTimeout(() => { selfRescue('想走过去但走不动'); }, 300);
  return { ok: d < 4.5, msg: d < 4.5 ? '到了' : `还差 ${d.toFixed(1)} 格没走过去`, extra: { dist: +d.toFixed(1) } };
});
function nearestDiggable(target, r = 3) {
  let best = null, bd = 1e9;
  const t = target.floored();
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    const b = bot.blockAt(t.offset(dx, dy, dz));
    if (!b || b.name === 'air' || b.name === 'bedrock' || b.boundingBox === 'empty') continue;
    const d = Math.hypot(dx, dy, dz);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
actRegister('dig', async (a) => {
  let b;
  const hasXYZ = (a.x !== undefined && a.y !== undefined && a.z !== undefined);
  if (hasXYZ) b = bot.blockAt(new Vec3(Math.floor(+a.x), Math.floor(+a.y), Math.floor(+a.z)));
  else {
    b = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    // 脚下是空气（站在半空里、方块刚被自己挖掉）就别干瞪眼了，就近找一块能挖的
    if (!b || b.name === 'air' || b.boundingBox === 'empty') {
      const alt = nearestDiggable(bot.entity.position.offset(0, -1, 0), 3);
      if (alt) { b = alt; log('DIG 脚下没方块，改挖附近 ' + alt.name + ' @' + alt.position.toString()); }
    }
  }
  if (!b) return { ok: false, msg: '那儿没方块' };
  if (hasXYZ && b.name === 'air') {
    // 坐标偏了一点就自己找最近的能挖的方块，别干瞪眼
    const alt = nearestDiggable(new Vec3(Math.floor(+a.x), Math.floor(+a.y), Math.floor(+a.z)), 3);
    if (alt) b = alt;
  }
  if (b.name === 'bedrock' || b.name === 'air') return { ok: false, msg: '这个挖不了：' + b.name };
  // 紧急止血：离水/岩浆只有一格就别挖了，挖穿了会被淹（12:21 就是挖穿水流井，血从 20 掉到 5）
  {
    const danger = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
      .map(([dx, dy, dz]) => bot.blockAt(b.position.offset(dx, dy, dz)))
      .find(x => x && /^(water|lava)/.test(x.name));
    if (danger && bot.entity.position.y < 62) {
      return { ok: false, msg: `旁边就是${danger.name}，挖穿会被淹，我不挖这块，换个地方` };
    }
  }
  if (b.position.distanceTo(bot.entity.position) > 4.5) {
    await walkTo(b.position, 3.4, 6000);
  }
  if (b.position.distanceTo(bot.entity.position) > 4.5) {
    await walkTo(b.position, 2.6, 6000);
  }
  try { await bot.dig(b); } catch (e) { return { ok: false, msg: '挖不动：' + (e.message || e) }; }
  return { ok: true, msg: '挖掉一块 ' + b.name, extra: { block: b.name, mats: matCount() } };
});
// 给「目标格被占」找个替补：附近空格、脚下有靠着的东西（不然放上去会掉）
function findFreePlaceSpot(p, r = 3) {
  let best = null, bd = 1e9;
  const me = bot.entity.position;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -1; dy <= 1; dy++) {
    const q = p.offset(dx, dy, dz);
    const feet = me.floored();
    if (q.x === feet.x && q.z === feet.z && (q.y === feet.y || q.y === feet.y + 1)) continue;  // 别往自己身体里塞方块
    const b = bot.blockAt(q);
    if (!b || b.boundingBox !== 'empty') continue;
    const below = bot.blockAt(q.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') continue;      // 悬空放不住
    let solidSide = false;
    for (const o of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
      const nb = bot.blockAt(q.offset(o[0], o[1], o[2]));
      if (nb && nb.boundingBox === 'block') { solidSide = true; break; }
    }
    if (!solidSide) continue;                                    // 要有个面能靠着
    const d = me.distanceTo(q);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
actRegister('place', async (a) => {
  if (a.x === undefined) return { ok: false, msg: '要给我 x y z 坐标' };
  const p = new Vec3(Math.floor(+a.x), Math.floor(+a.y), Math.floor(+a.z));
  // 失败要说清原因，别一律「够不着或没方块」（服务器把放置拒了 vs 目标已占 vs 悬空）
  let spot = p, occupiedBy = '';
  let cur = bot.blockAt(p);
  if (cur && cur.name !== 'air' && cur.boundingBox !== 'empty') {
    // 别死磕同一格：往旁边找一块空的、贴着已有方块的位置放（智能一点，别直接摆烂）
    const alt = a.auto === false ? null : findFreePlaceSpot(p);
    if (!alt) return { ok: false, msg: `那儿已经有 ${cur.name} 了`, extra: { mats: matCount(), why: 'occupied', at: [p.x, p.y, p.z] } };
    occupiedBy = cur.name; spot = alt;
  }
  if (matCount() <= 0) return { ok: false, msg: '手上没方块了', extra: { why: 'no_mats' } };
  if (!nearEnough(spot)) await walkTo(spot, 2.8, 6000);
  const d = bot.entity.position.distanceTo(spot);
  if (d > 4.4) return { ok: false, msg: `还差 ${d.toFixed(1)} 格，够不着`, extra: { mats: matCount(), why: 'far', dist: +d.toFixed(1) } };
  const ok = await placeAt(spot);
  if (!ok) driftTick('放置被服务器拒了（客户端以为空）', 1);   // 我们眼里是空气、服务器眼里有东西 → 漂移证据
  return {
    ok,
    msg: ok
      ? (occupiedBy ? `那儿已经有 ${occupiedBy} 了，我放到旁边 (${spot.x}, ${spot.y}, ${spot.z}) 了` : '放好了')
      : '放不上去：目标旁边没有能靠着的方块（悬空）或被服务器拒了',
    extra: { mats: matCount(), why: ok ? null : 'rejected', at: [spot.x, spot.y, spot.z] },
  };
});
async function pillarUp(n) {
  const mat = pickMat();
  if (!mat) return 0;
  const item = bot.inventory.items().find(i => i.name === mat);
  if (!item) return 0;
  try { await bot.equip(item, 'hand'); } catch (e) { return 0; }
  let done = 0;
  for (let i = 0; i < n; i++) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.name === 'air') { await sleep(150); continue; }
    const pre = bot.entity.position.floored();          // 起跳前站的那格
    bot.setControlState('jump', true);
    await sleep(280);
    const ok = await placeAt(new Vec3(pre.x, pre.y, pre.z));  // 在脚下那格垫一块
    bot.setControlState('jump', false);
    await sleep(300);
    if (ok) done++;
  }
  return done;
}

function openAbove() {
  const p = bot.entity.position;
  for (let dy = 2; dy <= 4; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0));
    if (!b || b.name !== 'air') return false;
  }
  return true;
}

function hasHeadroom() {
  const p = bot.entity.position;
  for (let dy = 1; dy <= 2; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0));
    if (!b || b.boundingBox !== 'empty') return false;
  }
  return true;
}
function localMaxTop(r = 5) {
  const me = bot.entity.position.floored();
  let m = me.y;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    for (let y = me.y + 12; y >= me.y - 4; y--) {
      const b = bot.blockAt(new Vec3(me.x + dx, y, me.z + dz));
      if (b && b.boundingBox === 'block') { if (y > m) m = y; break; }
    }
  }
  return m;
}
// 从坑里/洞里爬出来：头顶挡着先挖，然后往上垫
// ===== 溺水自救（2026-10-28）=====
// 症状：掉进 y≈8 的深水井（水面在 y≈62），每秒淹 2 血，一路淹到 0，且 BUILD 循环还
// 在继续把它送回同一片水，3 分钟死 7 次。这里补两层：检测到闷在水里就夺回控制权
// 往上游；死亡则立刻终止手头的建造，别重生后又被任务拉回事故现场。

function headBlockName() {
  try { const b = bot.blockAt(bot.entity.position.offset(0, 1.5, 0)); return b ? b.name : ''; } catch (e) { return ''; }
}

function isDrowning() {
  if (!bot || !bot.entity || !ready) return false;
  if (!bot.entity.isInWater) return false;
  // 注意 mineflayer 的 oxygenLevel 满值就是 20，别拿它当"满值 300"来比，
  // 否则站在浅水里也会被误判成溺水（12:14 就误触发过一次）。
  if (!/water/.test(headBlockName())) return false;
  // 主动游泳/潜水窗口内：还有气、血也没掉，就不许硬拖它上岸（不然"下水游泳"根本游不了）
  if (swimIntent() && bot.oxygenLevel > 3 && bot.health >= 10) return false;
  if (bot.oxygenLevel <= 6) return true;                                    // 头埋水 + 快没气了才是真溺水
  return false;
}

// 最后手段：像玩家一样在水里按住跳 + 前进爬上岸（pathfinder 在水里常常规划不出来）
async function nudgeClimb(target) {
  for (let i = 0; i < 8; i++) {
    try {
      if (target) {
        const me = bot.entity.position;
        bot.look(Math.atan2(-(target.x + 0.5 - me.x), -(target.z + 0.5 - me.z)), 0, true);
      }
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
      await sleep(1300);
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
      bot.setControlState('sprint', false);
      await sleep(200);
      if (!bot.entity.isInWater && !/water/.test(headBlockName())) { log('DROWN climbed out by hand'); return true; }
    } catch (e) {}
  }
  log('DROWN climb failed, still wet at ' + (bot.entity ? bot.entity.position.toString() : '?'));
  return false;
}

// 井壁太陡、游不上去时，像玩家一样"边跳边在脚下垫方块"，一格一格顶出水面
async function padUpOutOfWater(max = 6) {
  for (let i = 0; i < max; i++) {
    if (!bot.entity.isInWater && !/water/.test(headBlockName())) return true;
    const pre = bot.entity.position.floored();
    let done = false;
    // 水里跳不高、正下方放不下砖，就绕着井壁往侧面搭台阶，一级一级往上走
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const t = new Vec3(pre.x + dx, pre.y, pre.z + dz);
      const base = bot.blockAt(t.offset(0, -1, 0));
      if (!base || base.boundingBox !== 'block') continue;
      const here = bot.blockAt(t);
      if (here && here.boundingBox === 'block') { done = true; break; }   // 本来就有台阶
      if (await placeAt(t)) { done = true; break; }
    }
    log('DROWN pad ' + (done ? 'ok' : 'fail') + ' y=' + bot.entity.position.y.toFixed(1));
    if (!done) break;
    try { await walkTo(new Vec3(pre.x, pre.y + 1, pre.z), 2.2, 2500); } catch (e) {}
    await sleep(250);
  }
  return !bot.entity.isInWater && !/water/.test(headBlockName());
}

// 脱困后别原地漂着：找个最近的干燥落脚点走两步，不然又会滑回水里
async function stepAwayFromWater() {
  try {
    const p = bot.entity.position.floored();
    let best = null, bd = 1e9;
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) for (let dy = -1; dy <= 2; dy++) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (!b || b.boundingBox === 'empty' || /water|lava/.test(b.name)) continue;
      const a1 = bot.blockAt(b.position.offset(0, 1, 0));
      const a2 = bot.blockAt(b.position.offset(0, 2, 0));
      if (!a1 || !a2) continue;
      if (a1.boundingBox !== 'empty' || /water|lava/.test(a1.name)) continue;
      if (a2.boundingBox !== 'empty') continue;
      const d = Math.hypot(dx, dz);
      if (d < 2) continue;
      if (d < bd) { bd = d; best = b.position; }
    }
    if (!best) { log('DROWN no dry land within 7 blocks'); await nudgeClimb(null); return; }
    log(`DROWN step to dry land ${best.x},${best.y},${best.z} (d=${bd.toFixed(1)})`);
    await walkTo(best, 1.2, 5000);
    if (bot.entity.isInWater || /water/.test(headBlockName())) await nudgeClimb(best);
    if (bot.entity.isInWater || /water/.test(headBlockName())) await padUpOutOfWater(6);
  } catch (e) { log('DROWN stepAway ERR ' + (e.message || e)); }
}

async function surfaceNow(why = 'tick') {
  if (DROWN.rescuing) return false;
  if (!bot || !bot.entity) return false;
  DROWN.rescuing = true;
  DROWN.lastRescue = Date.now();
  const t0 = Date.now();
  const y0 = bot.entity.position.y;
  const d0 = deaths;
  const wasBuilding = BUILD.active, resumeName = BUILD.who;
  const clearCtl = () => {
    try { ['forward', 'back', 'jump', 'left', 'right', 'sprint'].forEach(k => bot.setControlState(k, false)); } catch (e) {}
  };
  const escaped = () => !bot || !bot.entity || (!bot.entity.isInWater && !/water/.test(headBlockName()));
  log(`DROWN rescue start (${why}) y=${y0.toFixed(1)} hp=${bot.health} oxy=${bot.oxygenLevel} head=${headBlockName()} building=${wasBuilding}`);
  if (Date.now() - DROWN.lastSay > 40000) {
    DROWN.lastSay = Date.now();
    say('咳…咳…我掉水里了，往上游！');
  }
  try {
    BUILD.abort = true; BUILD.abortQuiet = true;   // 先把建造停掉，别在半成品里泡着
    stopFollow();                                  // 顺带 pathfinder.stop + 清控制
    COMBAT.active = false; COMBAT.target = null;
    let yaw0 = bot.entity.yaw, dir = 1, lastY = y0, lastUp = Date.now(), lastTurn = 0;
    let mode = 'up';
    // 实测：在瀑布/下流水柱里"抬头游"几乎不上升（12 秒才 3 格，血照样每秒 -2），
    // 所以 4 秒没明显上升就切横向逃逸——先游出水流柱再上浮。
    while (bot && bot.entity && Date.now() - t0 < 32000) {
      if (escaped()) break;
      const y = bot.entity.position.y;
      if (y > lastY + 0.8) { lastY = y; lastUp = Date.now(); }     // 还在往上走，继续
      if (mode === 'up' && Date.now() - lastUp > 4000) {
        mode = 'side'; lastTurn = 0;
        log(`DROWN no lift at y=${y.toFixed(1)} (dy=${(y - y0).toFixed(1)}), switch to sideways escape`);
        say('上不去！这水一直往下冲…我横着游出去找岸');
      }
      if (mode === 'up') {
        try { await bot.look(yaw0, -1.35, true); } catch (e) {}      // 朝上看：jump 即向上游泳
        try { bot.setControlState('jump', true); bot.setControlState('forward', true); } catch (e) {}
      } else {
        if (Date.now() - lastTurn > 2500) { yaw0 += dir * (Math.PI / 2); dir = -dir; lastTurn = Date.now(); }
        try { await bot.look(yaw0, 0, true); } catch (e) {}          // 平视 = 全力横游
        try {
          bot.setControlState('jump', true);
          bot.setControlState('forward', true);
          bot.setControlState('sprint', true);
        } catch (e) {}
      }
      await sleep(220);
    }
  } catch (e) {
    log('DROWN ERR ' + (e.message || e));
  } finally {
    clearCtl();
    DROWN.rescuing = false;
  }
  const died = deaths > d0;
  const safe = escaped();
  const yEnd = bot && bot.entity ? bot.entity.position.y : NaN;
  if (safe && !died) DROWN.okCount++; else DROWN.fails++;
  log(`DROWN rescue end safe=${safe} died=${died} y=${isNaN(yEnd) ? '?' : yEnd.toFixed(1)} dy=${isNaN(yEnd) ? '?' : (yEnd - y0).toFixed(1)} spent=${Date.now() - t0}ms hp=${bot && bot.health}`);
  if (died) { AUTO.pauseUntil = Math.max(AUTO.pauseUntil || 0, Date.now() + 10000); return false; }  // 没救回来：重生后别急着回原地
  if (safe) {
    AUTO.pauseUntil = Math.max(AUTO.pauseUntil || 0, Date.now() + 15000);  // 先喘口气、离水远点再干活
    if (Date.now() - DROWN.lastSafeSay > 180000) {                          // 别每 2 秒就"我上来了"刷屏
      DROWN.lastSafeSay = Date.now();
      say(yEnd - y0 > 2 ? `呛了好几口水总算上来了（y=${yEnd.toFixed(0)}），这水也太深了吧…` : '呼…终于站到实地上了');
    }
    await stepAwayFromWater();                                             // 先上岸再谈别的
    // 连续救援还出不去 = 这口井是封死的（12:24 实测：卡在 y=58 原地 60 多次救援循环）
    // 这时光游泳没用，得挖头顶往上开洞
    if (bot && bot.entity && (bot.entity.isInWater || /water/.test(headBlockName())) && DROWN.fails >= 2) {
      log(`DROWN stuck ${DROWN.fails} times, start digging out at y=${bot.entity.position.y.toFixed(1)}`);
      say('这井是封的死水坑…我挖个口子爬出去');
      try { await climbOut(10); } catch (e) { log('DROWN climbOut ERR ' + (e.message || e)); }
      DROWN.fails = 0;
      await stepAwayFromWater();
    }
    // 游泳 + 挖洞都还泡着 → 直接交给现成的 selfRescue（jump/pillar/wander/tp 一整套，
    // 别再把攀爬逻辑重写一遍）
    if (bot && bot.entity && (bot.entity.isInWater || /water/.test(headBlockName()))) {
      log('DROWN still wet after climbOut -> selfRescue');
      try { await selfRescue('溺水还是爬不出去'); } catch (e) { log('DROWN selfRescue ERR ' + (e.message || e)); }
      await stepAwayFromWater();
    }
    // 自救成功且安全（血够、岸上、最近没在这附近栽过）→ 回去把活干完；否则先躺平回血
    const nearAccident = (DANGER.spots || []).some(s => Date.now() - s.t < 180000 &&
      Math.hypot(s.x - (bot.entity ? bot.entity.position.x : 0), s.z - (bot.entity ? bot.entity.position.z : 0)) < 48);
    if (wasBuilding && resumeName && bot && bot.health >= 14 && !nearAccident) {
      say('呼…上岸了，我回去把房子盖完');
      setTimeout(() => {
        try {
          if (!ready || !bot || !bot.entity) return;
          if (BUILD.active || bot.entity.isInWater || bot.health < 12) return;
          buildHouse(resumeName);
        } catch (e) {}
      }, 6000);
    } else if (wasBuilding) {
      say('盖到一半掉水里了…等我回点血再接着弄');
    }
    // 井口还敞着 → 顺手封掉，别让下一轮自主行动又掉回同一口井（人安全、不在游泳、不忙才做）
    try {
      const p1 = bot && bot.entity ? bot.entity.position : null;
      const near = p1 ? (DANGER.spots || []).filter(sp => Date.now() - sp.t < 3600e3 &&
        Math.hypot(sp.x - p1.x, sp.z - p1.z) < 24)
        .sort((a, b) => Math.hypot(a.x - p1.x, a.z - p1.z) - Math.hypot(b.x - p1.x, b.z - p1.z))[0] : null;
      if (near && bot.health >= 14 && !PLUG.active && !BUILD.active && !swimIntent() &&
          Date.now() - (PLUG.lastDecide || 0) > 180000) {
        PLUG.lastDecide = Date.now();
        log(`PLUG auto-schedule near accident ${near.x.toFixed(0)},${near.z.toFixed(0)}`);
        setTimeout(() => {
          try {
            if (!ready || !bot || !bot.entity || PLUG.active || swimIntent()) return;
            plugWell({ max: 10, radius: 4 }).catch(e => log('PLUG auto ERR ' + (e.message || e)));
          } catch (e) {}
        }, 8000);   // 先站稳、离水远点再动手
      }
    } catch (e) {}
  }
  return safe;
}

// 守护线程：闷水里 0.7 秒内就夺权，不等血掉光
setInterval(() => {
  try {
    if (!ready || !bot || !bot.entity) return;
    if (DROWN.rescuing) return;
    if (Date.now() - DROWN.lastRescue < 1200) return;   // 别刚救完 1 秒又开一轮
    // 泡在水里站着会自己往下沉：干脆一直浮着换气，别憋到扣血
    if (swimIntent()) return;   // 主动游泳/潜水时别按着空格往上顶，人家要往下走呢
    if (bot.entity.isInWater && Date.now() - (DROWN.lastBob || 0) > 8000) {
      DROWN.lastBob = Date.now();
      try {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 1500);
      } catch (e) {}
    }
    if (isDrowning()) surfaceNow('tick');
  } catch (e) {}
}, 700);

// ===== 填井 / 封水面（2026-10-28 加）=====
// 自救只是把人捞上来，井口还敞着，自主行动一回头又掉回同一片水。这里在"确认安全"之后
// 主动把露天水面封掉：只封最高那一层、只对小水口子下手，缺料/有怪/血少就立刻放弃。
const PLUG = { active: false, lastDecide: 0, lastSay: 0, okCount: 0, fails: 0 };

// 露天水面：每列只取"最高一层水"，且上面得是空气
function sealCellForWater(x, z, waterTopY, fromY) {
  // 从水面沿着井道往上走，记下最上面那一格"四周还有井壁"的格子 = 井口
  let best = null;
  // 往上多看 4 格：站得低的时候 fromY 够不到顶，看不到"已经盖好"的那块砖，
  // 就会一路往下再封第二层、第三层
  const scanTop = fromY + 4;
  for (let y = waterTopY; y <= scanTop; y++) {
    const cur = bot.blockAt(new Vec3(x, y, z));
    if (!cur) break;
    const soft = cur.boundingBox !== 'block' || /water|lava/.test(cur.name);
    if (!soft) return null;                            // 井道上已经压着实心 = 早封好了，别再往下填
    // 只封"头顶还露着"的口子：上一格必须不是实心方块。
    // 不然封完一层它会继续盯着下面那层，把整根烟囱一路往下填（实测干过）
    const above = bot.blockAt(new Vec3(x, y + 1, z));
    const openTop = above && above.boundingBox !== 'block';
    if (y <= fromY && openTop && solidNeighborCount(x, y, z) >= 3) best = y;   // 还在井道里（四面是壁）
  }
  return best;
}
// 竖着看一根柱子（调试用）：y:方块名/实心邻居数
function colProbe(x, z, y0, y1) {
  const out = [];
  for (let y = y0; y <= y1; y++) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) continue;
    out.push(`${y}:${b.name}/${solidNeighborCount(x, y, z)}`);
  }
  return out.join(' ');
}

function findOpenWater(center, r = 5, upY = 6, downY = 18) {
  const cells = [];
  if (!bot || !bot.entity || !center) return cells;
  const cx = Math.floor(center.x), cz = Math.floor(center.z), cy = Math.floor(center.y);
  for (let x = cx - r; x <= cx + r; x++) {
    for (let z = cz - r; z <= cz + r; z++) {
      for (let y = cy + upY; y >= cy - downY; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b || !/water/.test(b.name)) continue;
        const up = bot.blockAt(new Vec3(x, y + 1, z));
        if (!up || up.boundingBox !== 'empty' || /water|lava/.test(up.name)) continue;
        cells.push({ x, y, z });
        break;
      }
    }
  }
  return cells;
}

// 这一格四周有几块结实方块 —— 放砖要靠它撑，靠边的先放、里圈后放
function solidNeighborCount(x, y, z) {
  let n = 0;
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const b = bot.blockAt(new Vec3(x + ox, y, z + oz));
    if (b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) n++;
  }
  const below = bot.blockAt(new Vec3(x, y - 1, z));
  if (below && below.boundingBox === 'block') n++;
  return n;
}

// 这一格能不能放砖：水平/下方有依靠，或者头顶那格已经封上
// （顺着井往下灌的时候，下面的砖就是靠上面那块撑住的，solidNeighborCount 看不到这一点）
function hasSupport(x, y, z) {
  if (solidNeighborCount(x, y, z) > 0) return true;
  const above = bot.blockAt(new Vec3(x, y + 1, z));
  return !!(above && above.boundingBox === 'block' && !/water|lava/.test(above.name));
}

// 找井口旁边的干燥落脚点（别为了填井自己先跳进水里）
function standSpotNear(cx, cy, cz, rad = 3) {
  let best = null, bd = 1e9;
  for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) for (let dy = -1; dy <= 1; dy++) {
    const b = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
    if (!b || b.boundingBox !== 'block' || /water|lava/.test(b.name)) continue;
    const a1 = bot.blockAt(new Vec3(cx + dx, cy + dy + 1, cz + dz));
    const a2 = bot.blockAt(new Vec3(cx + dx, cy + dy + 2, cz + dz));
    if (!a1 || !a2 || a1.boundingBox !== 'empty' || a2.boundingBox !== 'empty') continue;
    if (/water|lava/.test(a1.name) || /water|lava/.test(a2.name)) continue;
    const d = Math.hypot(dx, dz);
    if (d < 1.2) continue;
    if (d < bd) { bd = d; best = new Vec3(cx + dx, cy + dy, cz + dz); }
  }
  return best;
}

async function plugWell(opts = {}) {
  const dry = !!opts.dry;
  const maxCells = Math.max(1, Math.min(120, +(opts.max || 24)));   // 整根井往下灌，格子数放宽
  const r = Math.max(1, Math.min(8, +(opts.radius || 5)));
  const refuse = () => {
    if (!ready || !bot || !bot.entity) return '我还没上线';
    if (PLUG.active) return '已经在填了';
    if (DROWN.rescuing) return '正泡在水里，先让我爬上去';
    if (BUILD.active) return '手上有建造活没干完';
    if (bot.entity.isInWater || /water/.test(headBlockName())) return '我自己还在水里';
    if (bot.health < 12) return '血太少了，先回血';
    if (hostiles(8).length) return '旁边有怪，先不打洞';
    if (swimIntent()) return '人家正游泳呢，回头再说';
    if (matCount() < 4) return '背包里没砖了';
    return null;
  };
  const why = refuse();
  if (why) { log('PLUG skip: ' + why); return { ok: false, msg: why }; }

  PLUG.active = true;
  const t0 = Date.now();
  let placed = 0, failed = 0, layer = 0, cols = 0, total = 0;
  try {
    const me = bot.entity.position;
    // 中心：优先最近的事故点（就是刚淹我那口井），没有就在脚下这片找
    let center = me.clone();
    const spots = (DANGER.spots || []).filter(s => Date.now() - s.t < 6 * 3600e3)
      .map(s => ({ s, d: Math.hypot(s.x - me.x, s.z - me.z) })).sort((a, b) => a.d - b.d);
    if (spots.length && spots[0].d < 40) center = new Vec3(spots[0].s.x, me.y, spots[0].s.z);
    const cells = findOpenWater(center, r);
    cols = cells.length;
    log(`PLUG scan dry=${dry} center=${center.x.toFixed(0)},${center.y.toFixed(0)},${center.z.toFixed(0)} waterCols=${cols} mats=${matCount()}`);
    if (!cols) { if (!dry) say('这附近没看到露天的水呀'); return { ok: false, msg: '附近没水面' }; }
    if (cols > 40) {   // 大湖不碰：封不住还容易把自己困住
      log('PLUG too big, refuse cols=' + cols);
      if (!dry) say('这不叫井，这是个大湖…我不填了，绕开走');
      return { ok: false, msg: '水面太大（' + cols + ' 列），是湖不是井' };
    }
    // 水面可能在十几格外（井下），够不着也堵不上；要堵的是这口井在**地表露头**那一格
    const fromY = Math.floor(bot.entity.position.y) + 2;
    const tg = cells.map(c => ({ x: c.x, z: c.z, waterY: c.y, y: sealCellForWater(c.x, c.z, c.y, fromY) }))
      .filter(t => t.y !== null);
    if (!tg.length) {
      log('PLUG no mouth: waterCols=' + cells.length + ' (找不到露头，可能本来就盖着)');
      return { ok: true, msg: '井口没露头，可能本来就被盖着', extra: { cells } };
    }
    layer = tg[0].y;
    // 不再只盖一块砖：从井口往下灌实，直到水面上方一格（1×1 烟囱就变成一口封死的死井）
    const DEPTH_MAX = 18;
    const todo = [];
    for (const t of tg) {
      for (let y = t.y; y > t.waterY && y > t.y - DEPTH_MAX; y--) {
        const b = bot.blockAt(new Vec3(t.x, y, t.z));
        if (b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) break;   // 已经是实心，再往下没意义
        todo.push({ x: t.x, y, z: t.z, waterY: t.waterY, mouth: t.y });            // 同一列由上往下排
      }
    }
    total = todo.length;
    if (!total) return { ok: true, msg: '井口没露头，可能本来就被盖着', extra: { cells } };
    log('PLUG mouth y=' + layer + ' waterY=' + tg[0].waterY + ' cells=' + total + ' depth=' + (tg[0].y - tg[0].waterY));
    log('PLUG column ' + tg[0].x + ',' + tg[0].z + ' -> ' + colProbe(tg[0].x, tg[0].z, Math.max(0, tg[0].waterY - 1), fromY + 2));
    if (dry) return { ok: true, msg: `dry-run：井口 y=${layer}（水在 y=${tg[0].waterY}），要从口上灌 ${total} 格下去`, extra: { layer, waterY: tg[0].waterY, cols, total, cells: todo.slice(0, 40) } };
    log(`PLUG fill y=${layer} cells=${total} (allCols=${cols})`);
    if (!pickMat()) return { ok: false, msg: '没有能用的方块' };

    let left = todo.slice(0, maxCells);
    const deadCols = new Set();   // 够不着的柱子：它下面更深的地方就别再白试了
    for (let pass = 0; pass < 6 && left.length; pass++) {
      left = left.filter(c => !deadCols.has(c.x + ',' + c.z));
      left.sort((a, b) => (solidNeighborCount(b.x, b.y, b.z) - solidNeighborCount(a.x, a.y, a.z)) || (b.y - a.y));
      const next = [];
      for (const c of left) {
        if (!ready || !bot || !bot.entity) break;
        if (bot.health < 8) { log('PLUG abort low hp ' + bot.health); break; }
        if (hostiles(6).length) { log('PLUG abort hostiles'); break; }
        if (Date.now() - t0 > 180000) { log('PLUG abort timeout'); break; }
        if (deadCols.has(c.x + ',' + c.z)) continue;   // 这列刚试过够不着，同批剩下的深度就别再碰了
        const ty = c.y;
        const cur = bot.blockAt(new Vec3(c.x, ty, c.z));
        if (cur && cur.boundingBox === 'block' && !/water|lava/.test(cur.name)) continue;                       // 已经封上了
        if (!hasSupport(c.x, ty, c.z)) { next.push(c); continue; }   // 悬空先跳过，等外圈封好再回补
        const spot = standSpotNear(c.x, ty, c.z, 3);   // 先站到井沿干地上，别为了填井自己掉进去
        if (spot) await walkTo(spot, 1.2, 3000);
        let ok = await placeAt(new Vec3(c.x, ty, c.z));              // 复用现成放块逻辑
        if (!ok) {                                                   // 够不着才让它自己走近再放
          const rp = await ACTIONS.place({ x: c.x, y: ty, z: c.z });
          ok = !!(rp && rp.ok);
        }
        if (!ok) deadCols.add(c.x + ',' + c.z);                      // 这口井够不着了，下面更深的别再试
        log(`PLUG place ${c.x},${ty},${c.z} ${ok ? 'ok' : 'fail'} nb=${solidNeighborCount(c.x, ty, c.z)} waterY=${c.waterY}`);
        if (ok) placed++; else failed++;
        await sleep(120);
      }
      left = next;
    }
  } catch (e) {
    log('PLUG ERR ' + (e.message || e));
  } finally {
    PLUG.active = false;
  }

  const res = { ok: placed > 0, msg: `填井：封了 ${placed} 格（失败 ${failed}）水面 y=${layer}`, extra: { placed, failed, layer, cols, total } };
  if (placed > 0) {
    PLUG.okCount++;
    if (Date.now() - PLUG.lastSay > 30000) {
      PLUG.lastSay = Date.now();
      say(placed >= total ? `井口封到水里啦（${placed} 格），这下是真掉不下去了～` : `从口上灌了 ${placed} 格，最上面已经堵死，掉不下去啦`);
    }
  } else {
    PLUG.fails++;
    say('井口我够不着也放不下砖…先记着，回头再收拾它');
  }
  log('PLUG done ' + JSON.stringify(res.extra) + ' spent=' + (Date.now() - t0) + 'ms');
  return res;
}

async function climbOut(max = 16) {
  let n = 0;
  while (n < max && bot && bot.entity) {
    if (bot.entity.position.y >= localMaxTop(5) + 0.9 && hasHeadroom()) break;
    if (!hasHeadroom()) {
      const p = bot.entity.position.floored();
      const b = bot.blockAt(p.offset(0, 2, 0)) || bot.blockAt(p.offset(0, 1, 0));
      if (b && b.name !== 'bedrock' && b.boundingBox !== 'empty') { try { await bot.dig(b); } catch (e) {} await sleep(180); continue; }
    }
    const got = await pillarUp(1);
    if (!got) break;
    n++;
  }
  log('climbOut steps=' + n + ' y=' + bot.entity.position.y.toFixed(1));
  return bot.entity.position.y;
}

async function goToOpenAir(tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (!bot || !bot.entity) break;
    if (openAbove()) return true;
    const p = bot.entity.position.floored();
    const head = bot.blockAt(p.offset(0, 2, 0));
    if (head && head.boundingBox !== 'empty' && head.name !== 'bedrock') {
      try { await bot.dig(head); } catch (e) {}
      await sleep(200);
      continue;
    }
    const got = await pillarUp(1);
    if (!got) { await sleep(200); break; }
  }
  return openAbove();
}

actRegister('well_scan', (a) => {
  if (!bot || !bot.entity) return { ok: false, msg: '我还没上线' };
  const me = bot.entity.position;
  const spots = (DANGER.spots || []).filter(sp => Date.now() - sp.t < 12 * 3600e3)
    .map(sp => ({ sp, d: Math.hypot(sp.x - me.x, sp.z - me.z) })).sort((a, b) => a.d - b.d);
  const tgt = (a && a.x !== undefined) ? a
    : (spots.length ? spots[0].sp : { x: Math.floor(me.x), z: Math.floor(me.z) });
  const ax = Math.floor(tgt.x), az = Math.floor(tgt.z);
  const baseY = (a && a.y !== undefined) ? Math.floor(+a.y) : Math.floor(me.y);
  const rows = [];
  for (let y = baseY + 3; y >= baseY - 22; y--) {
    const b = bot.blockAt(new Vec3(ax, y, az));
    const nb = (() => {
      let n = 0;
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = bot.blockAt(new Vec3(ax + ox, y, az + oz));
        if (q && q.boundingBox === 'block' && !/water|lava/.test(q.name)) n++;
      }
      return n;
    })();
    rows.push(`${y}:${b ? b.name : '?'}(wall${nb})`);
  }
  const waterCols = findOpenWater(new Vec3(ax, baseY, az), 4).map(c => `${c.x},${c.y},${c.z}`);
  log('WELL_SCAN at ' + ax + ',' + az + ' base=' + baseY + ' | ' + rows.join(' '));
  return { ok: true, msg: `井口剖面 ${ax},${az}`, extra: { ax, az, rows, waterCols, spots: spots.slice(0, 5).map(x => ({ x: x.sp.x, z: x.sp.z, d: +x.d.toFixed(1) })) } };
});
actRegister('plug_well', async (a) => {
  if (a && (a.dry || a.dryRun || a.check)) return await plugWell({ dry: true, radius: +(a.radius || 5) });
  const r = await plugWell({ max: +(a.max || 12), radius: +(a.radius || 5) });
  return { ok: !!r.ok, msg: r.msg, extra: r.extra || null };
});
actRegister('pillar', async (a) => {
  const n = Math.max(1, Math.min(20, Math.round(+a.count || 3)));
  const got = await pillarUp(n);
  return { ok: got > 0, msg: got ? `往上垫了 ${got} 格` : '垫不上去（没材料或头顶堵着）', extra: { mats: matCount() } };
});
actRegister('probe', async () => {
  const me = bot.entity.position;
  const bx = Math.floor(me.x), bz = Math.floor(me.z), by = Math.floor(me.y);
  const rows = [];
  for (let dz = -6; dz <= 6; dz += 2) {
    let row = '';
    for (let dx = -6; dx <= 6; dx += 2) {
      let top = null, openAbove = 0;
      for (let y = by + 8; y >= by - 12; y--) {
        const b = bot.blockAt(new Vec3(bx + dx, y, bz + dz));
        if (!b) continue;
        if (top === null && b.boundingBox !== 'empty') top = y;
      }
      let free = 0;
      for (let y = by; y <= by + 3; y++) {
        const b = bot.blockAt(new Vec3(bx + dx, y, bz + dz));
        if (b && b.boundingBox === 'empty') free++;
      }
      row += (top === null ? ' -- ' : String(top).padStart(4, ' ')) + (free === 4 ? '*' : ' ') + ' ';
    }
    rows.push(row);
  }
  const names = [];
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    for (let y = by + 2; y >= by - 6; y--) {
      const b = bot.blockAt(new Vec3(bx + dx, y, bz + dz));
      if (b && b.boundingBox !== 'empty') { if (names.indexOf(b.name) < 0) names.push(b.name); break; }
    }
  }
  log('PROBE y=' + by + '\n' + rows.join('\n'));
  return { ok: true, msg: 'probe done', extra: { y: by, rows, names: names.slice(0, 10) } };
});
actRegister('surface', async () => {
  stopFollow();
  let i = 0;
  for (; i < 24 && !openAbove(); i++) {
    const got = await pillarUp(1);
    if (!got) {
      // 头顶被堵：先挖掉挡路的
      const p = bot.entity.position;
      for (let dy = 1; dy <= 3; dy++) {
        const b = bot.blockAt(p.offset(0, dy, 0));
        if (b && b.name !== 'air' && b.name !== 'bedrock') { try { await bot.dig(b); } catch (e) {} break; }
      }
      await sleep(200);
    }
  }
  const p = bot.entity.position;
  return { ok: openAbove(), msg: openAbove() ? `出来了，在 y=${p.y.toFixed(0)}` : '还在洞里…', extra: { y: +p.y.toFixed(1), mats: matCount() } };
});
actRegister('collect', async (a) => {
  const need = Math.max(1, Math.min(64, Math.round(+a.count || 16)));
  stopFollow();
  const got = await gather(need);
  return { ok: got > 0, msg: `挖到 ${got} 块，背包能当砖的有 ${matCount()} 块`, extra: { got, mats: matCount() } };
});
actRegister('cage', () => {
  if (!bot || !bot.entity) return { ok: false, msg: '还没连上' };
  const p = bot.entity.position.floored();
  const found = [];
  for (let dx = -5; dx <= 5; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -5; dz <= 5; dz++) {
    const b = bot.blockAt(p.offset(dx, dy, dz));
    if (b && b.name === 'barrier') found.push([dx, dy, dz]);
  }
  const dirs = { 北: 0, 南: 0, 东: 0, 西: 0, 上: 0, 下: 0 };
  for (const [dx, dy, dz] of found) {
    if (dy < 0) dirs['下']++; else if (dy > 0) dirs['上']++;
    else if (Math.abs(dx) > Math.abs(dz)) dirs[dx > 0 ? '东' : '西']++;
    else dirs[dz > 0 ? '南' : '北']++;
  }
  const txt = Object.entries(dirs).filter(([, v]) => v).map(([k, v]) => `${k}${v}块`).join('、');
  return { ok: true, msg: found.length ? `周围共 ${found.length} 块屏障（${txt}）` : '附近没有屏障，不是被围', extra: { count: found.length, dirs, list: found.slice(0, 60) } };
});
actRegister('drops', (a) => {
  const r = Math.max(2, Math.min(32, +a.radius || 16));
  const list = nearbyDrops(r).map(it => ({
    id: it.e.id, name: String(it.e.name || '?'),
    d: +it.e.position.distanceTo(bot.entity.position).toFixed(2),
    dy: +(it.e.position.y - bot.entity.position.y).toFixed(2),
    y: +it.e.position.y.toFixed(1),
    onGround: !!(it.e.onGround), valid: it.e.isValid !== false,
    skipLeft: PICKUP_TRY[it.e.id] ? Math.max(0, PICKUP_TRY[it.e.id].skipUntil - Date.now()) : 0,
  }));
  return { ok: true, msg: `半径 ${r} 内有 ${list.length} 处掉落物`, extra: { count: list.length, list } };
});
actRegister('pickup', async (a) => {
  const r = Math.max(2, Math.min(20, +a.radius || 9));
  // 自动巡检可能正占着 pickupBusy（最长 6s），手动捡先等它让位，别回一个假的"没走近"
  for (let i = 0; i < 16 && pickupBusy; i++) await sleep(500);
  const got = await pickUpNearby(r, { force: true });
  const left = nearbyDrops(12).length;
  const s = lastPickupStat || {};
  let msg;
  if (got) msg = `走过去捡了 ${got} 处掉落物`;
  else if (!left) msg = '附近没掉落物';
  else if (s.tried) msg = `走过去了但没进背包（试了 ${s.tried} 处，可能是幽灵掉落物/被方块挡住）`;
  else msg = `看得到 ${left} 处掉落物但这次没走近`;
  return { ok: got > 0, msg, extra: { got, left, ...s } };
});
actRegister('armor', async (a) => {
  const n = await autoArmor(true);
  const cur = armorNow();
  return { ok: cur.length > 0, msg: cur.length ? (n ? `换了 ${n} 件，现在穿的是 ` : '现在穿的是 ') + cur.map(x => `${x.slot}:${x.name}`).join(' ') : '背包里没有能穿的护甲', extra: { changed: n, armor: cur } };
});
actRegister('build_house', (a) => {
  if (BUILD.active) return { ok: true, msg: '已经在建了', extra: { active: true } };
  buildHouse(a.player || 'console');       // 后台跑，先回执
  return { ok: true, msg: 'started', extra: { active: true } };
});
actRegister('build_status', () => ({
  ok: true,
  msg: BUILD.active ? `在建，已放 ${BUILD.placed} 块 / 失败 ${BUILD.failed}` : '现在没在建',
  extra: { active: BUILD.active, placed: BUILD.placed, failed: BUILD.failed },
}));
actRegister('inventory', () => {
  // 统计全部物品（方块 + 食物 + 工具 + 火把等），不再只数方块
  const raw = bot.inventory.items() || [];
  const agg = {};
  for (const i of raw) agg[i.name] = (agg[i.name] || 0) + i.count;
  const all = Object.entries(agg).map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const m = matList();
  const weapons = all.filter(i => weaponScore(i.name) > 0).map(i => `${i.name}x${i.count}`);
  return {
    ok: true,
    msg: (all.length ? all.map(i => `${i.name}x${i.count}`).join(',') : '背包是空的') +
      (weapons.length ? `｜武器:${weapons.join('/')}` : '｜武器:无'),
    extra: { mats: matCount(), items: raw.length, kinds: all.length, blocks: m.length, all, weapons },
  };
});


// ================= 图纸模式：参数化生成施工表 =================
function ringCells(r) {
  const out = [];
  const R = Math.max(0, r);
  if (R < 0.6) { out.push([0, 0]); return out; }
  for (let dx = -Math.ceil(R) - 1; dx <= Math.ceil(R) + 1; dx++)
    for (let dz = -Math.ceil(R) - 1; dz <= Math.ceil(R) + 1; dz++) {
      const d = Math.hypot(dx, dz);
      if (d <= R + 0.35 && d > R - 0.9) out.push([dx, dz]);
    }
  return out;
}
function diskCells(r) {
  const out = [];
  for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
    for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++)
      if (Math.hypot(dx, dz) <= r + 0.35) out.push([dx, dz]);
  return out;
}

// 返回 [{dx,dy,dz,tag}]，dy 从 0 开始（0 = 地基那层）
function shapePlan(kind, o) {
  const cells = [];
  const push = (dx, dy, dz, tag) => cells.push({ dx, dy, dz, tag: tag || 'wall' });

  if (kind === 'tower') {
    const r = Math.max(1, Math.min(5, Math.round(o.r || 2)));
    const h = Math.max(2, Math.min(14, Math.round(o.h || 5)));
    for (let y = 0; y < h; y++) for (const [dx, dz] of ringCells(r)) push(dx, y, dz, 'wall');
    if (o.top !== false) for (const [dx, dz] of diskCells(r)) push(dx, h, dz, 'roof');
  } else if (kind === 'pyramid') {
    const r = Math.max(1, Math.min(6, Math.round(o.r || 3)));
    for (let L = 0; L <= r; L++) for (const [dx, dz] of ringCells(r - L)) push(dx, L, dz, 'wall');
    for (const [dx, dz] of diskCells(0)) push(dx, r + 1, dz, 'roof');
  } else if (kind === 'arch') {
    const w = Math.max(1, Math.min(4, Math.round(o.w || 2)));      // 门洞半宽
    const legH = Math.max(1, Math.min(8, Math.round(o.h || 3)));   // 直腿高
    const R = w + 1;
    for (let y = 0; y < legH; y++) {
      for (let x = w; x <= R; x++) { push(x, y, 0, 'wall'); push(-x, y, 0, 'wall'); }
    }
    for (let k = 0; k <= R; k++) {
      const span = Math.round(Math.sqrt(Math.max(0, R * R - k * k)));
      push(span, legH + k, 0, 'arch'); push(-span, legH + k, 0, 'arch');
    }
  } else if (kind === 'wall') {
    const w = Math.max(1, Math.min(8, Math.round(o.w || 3)));
    const d = Math.max(1, Math.min(8, Math.round(o.d || w)));
    const h = Math.max(1, Math.min(8, Math.round(o.h || 2)));
    for (let y = 0; y < h; y++)
      for (let x = -w; x <= w; x++) for (let z = -d; z <= d; z++) {
        if (Math.abs(x) === w || Math.abs(z) === d) push(x, y, z, 'wall');
      }
  } else if (kind === 'pillar') {
    const h = Math.max(1, Math.min(18, Math.round(o.h || 4)));
    for (let y = 0; y < h; y++) push(0, y, 0, 'wall');
  }
  return cells;
}

// 按施工表盖：先垫地、再一层层往上砌，够不着就先垫高自己
async function buildPlan(steps, site, label, username) {
  if (BUILD.active) return { ok: false, msg: '手上还有活儿没干完' };
  BUILD.active = true; BUILD.abort = false; BUILD.placed = 0; BUILD.failed = 0;
  stopFollow();
  try {
    steps.sort((a, b) => (a.p.y - b.p.y) || (Math.abs(a.p.x - site.cx) + Math.abs(a.p.z - site.cz)) - (Math.abs(b.p.x - site.cx) + Math.abs(b.p.z - site.cz)));
    for (const st of steps) {
      if (!bot || !bot.entity) break;
      if (!ready) { await sleep(600); if (!ready) { log('BP abort: offline'); break; } }
      while (COMBAT.active && !BUILD.abort) await sleep(180);
      if (BUILD.abort) { say('好～停手了'); break; }
      const p = st.p;
      const cur = bot.blockAt(p);
      if (!cur || cur.boundingBox !== 'empty') continue;
      if (st.tag !== 'roof' && occupies(p)) await walkTo(standPoint(p, site), 2.2, 2200);
      await clearSoft(p);
      let guard = 0;
      while (bot.entity.position.y + 3.2 < p.y && guard++ < 10 && !BUILD.abort) {
        if (!(await pillarUp(1))) break;
        await sleep(120);
      }
      const stand = (p.y <= Math.floor(bot.entity.position.y) + 1) ? standPoint(p, site) : null;
      const ok = await reachAndPlace(p, stand);
      if (ok) BUILD.placed++; else { BUILD.failed++; log(`BP miss ${st.tag} ${p.x},${p.y},${p.z}`); }
      if (BUILD.failed > 12 && BUILD.placed < 4) { say('这个位置我够不着…我换个角度再试试'); break; }
    }
    log(`BP end ${label} placed=${BUILD.placed} failed=${BUILD.failed}/${steps.length}`);
    return { ok: BUILD.placed > 0, msg: `${label}：放了 ${BUILD.placed} 块，失败 ${BUILD.failed}${!ready ? '（中途掉线了）' : ''}`, extra: { placed: BUILD.placed, failed: BUILD.failed, offline: !ready, kick: lastKick } };
  } finally {
    try { ['forward', 'jump', 'left', 'right', 'sprint'].forEach(k => bot.setControlState(k, false)); } catch (e) {}
    BUILD.active = false;
  }
}

async function doBlueprint(kind, o, username) {
  if (!bot || !bot.entity) return { ok: false, msg: '我还没上线' };
  const yaw = bot.entity.yaw;
  const cx = Math.floor(bot.entity.position.x - Math.sin(yaw) * 5);
  const cz = Math.floor(bot.entity.position.z - Math.cos(yaw) * 5);
  const g = groundTop(cx, cz, bot.entity.position.y);
  if (g === null) return { ok: false, msg: '前面没落脚的地儿，换个方向' };
  const baseY = g + 1;
  const shape = shapePlan(kind, o);
  if (!shape.length) return { ok: false, msg: `不会画「${kind}」这种形状，我只会 tower/pyramid/arch/wall/pillar` };

  // 每列从地面垫到最低那层
  const cols = new Map();
  for (const c of shape) {
    const k = c.dx + ',' + c.dz;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(c);
  }
  const steps = [];
  for (const [k, list] of cols) {
    const [dx, dz] = k.split(',').map(Number);
    const x = cx + dx, z = cz + dz;
    const gt = groundTop(x, z, baseY + 2);
    const minY = Math.min(...list.map(c => c.dy));
    if (gt !== null) for (let y = gt + 1; y < baseY + minY; y++) steps.push({ p: new Vec3(x, y, z), tag: 'fill' });
    for (const c of list) steps.push({ p: new Vec3(x, baseY + c.dy, z), tag: c.tag });
  }
  const needTotal = steps.length;
  let have = matCount();
  if (have < needTotal) {
    log(`BP need ${needTotal} have ${have}, gathering`);
    await gather(Math.min(64, needTotal - have + 6));
    have = matCount();
    if (!have) return { ok: false, msg: '手上一块方块都没有，挖也没挖到' };
  }
  const half = shape.reduce((m, c) => Math.max(m, Math.abs(c.dx), Math.abs(c.dz)), 1);
  const site = { cx, cz, baseY, half };
  say(`图纸收到！${kind} 大概 ${needTotal} 块，开工～`);
  const r = await buildPlan(steps, site, `${kind}(${needTotal}块)`, username);
  return r;
}

actRegister('blueprint', async (a) => {
  const kind = String(a.shape || a.kind || 'tower').toLowerCase();
  return await doBlueprint(kind, a, a.player || 'console');
});

// 红石"眼睛"：把周围的元件朝向/电量读出来
actRegister('redstone', () => {
  if (!bot || !bot.entity) return { ok: false, msg: '我还没上线' };
  const RE = /repeater|comparator|redstone_wire|redstone_torch|redstone_lamp|piston|observer|lever|_button|pressure_plate|dispenser|dropper|hopper|note_block|target|daylight_detector|sculk_sensor|tripwire/;
  const p = bot.entity.position;
  const found = [];
  for (let dx = -6; dx <= 6; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -6; dz <= 6; dz++) {
    const b = bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz));
    if (!b || !RE.test(b.name)) continue;
    let props = {};
    try { props = b.getProperties ? b.getProperties() : (b._properties || {}); } catch (e) {}
    const keep = {};
    for (const k of ['facing', 'powered', 'delay', 'locked', 'shape', 'extended', 'lit', 'power', 'half', 'open', 'face']) if (props[k] !== undefined) keep[k] = props[k];
    found.push({ name: b.name, pos: [b.position.x, b.position.y, b.position.z], props: keep });
  }
  return { ok: true, msg: found.length ? `看到 ${found.length} 个红石元件` : '附近 6 格内没有红石元件', extra: { count: found.length, list: found.slice(0, 20) } };
});

// 通用「区块扫描」：按名字/正则找到一片范围内的方块（只读；只能扫服务器已加载的区块）
// args: {match:"chest|barrel" | "chest,barrel" | 正则, x,y,z(可省，默认脚下), r | rx,ry,rz, y0,y1, limit, group}
actRegister('scan', (a) => {
  if (!bot || !bot.entity) return { ok: false, msg: '我还没上线' };
  a = a || {};
  const raw = String(a.match || a.block || a.name || 'chest|barrel').trim();
  const metas = /[\\^$.*+?()[\]{}|]/.test(raw);
  let re;
  try {
    const body = metas ? raw : raw.split(/[,\s]+/).filter(Boolean).join('|');
    re = new RegExp('^(?:' + body + ')$');
  } catch (e) { return { ok: false, msg: '匹配串写错了：' + raw }; }

  const p = bot.entity.position.floored();
  const cx = a.x !== undefined ? Math.floor(+a.x) : (a.near ? Math.floor(+a.near[0]) : p.x);
  const cy = a.y !== undefined ? Math.floor(+a.y) : (a.near ? Math.floor(+a.near[1]) : p.y);
  const cz = a.z !== undefined ? Math.floor(+a.z) : (a.near ? Math.floor(+a.near[2]) : p.z);
  const clamp = (v, lo, hi, dv) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : dv));
  const rx = clamp(a.rx ?? a.r ?? 8, 0, 32, 8);
  const rz = clamp(a.rz ?? a.r ?? 8, 0, 32, 8);
  const ry = clamp(a.ry ?? Math.min(rx, rz), 0, 24, 4);
  const y0 = a.y0 !== undefined ? Math.floor(+a.y0) : cy - ry;
  const y1 = a.y1 !== undefined ? Math.floor(+a.y1) : cy + ry;
  const limit = clamp(a.limit ?? 80, 1, 512, 80);

  const found = []; let unloaded = 0, scanned = 0;
  for (let x = cx - rx; x <= cx + rx; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = cz - rz; z <= cz + rz; z++) {
        scanned++;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) { unloaded++; continue; }
        if (b.boundingBox === 'empty' || !re.test(b.name)) continue;
        found.push({ name: b.name, pos: [x, y, z],
          dist: +Math.sqrt((x + .5 - bot.entity.position.x) ** 2 + (y + .5 - bot.entity.position.y) ** 2 + (z + .5 - bot.entity.position.z) ** 2).toFixed(1) });
      }
  if (a.sort !== 'none') found.sort((m, n) => m.dist - n.dist);
  const count = found.length;
  const list = found.slice(0, limit);
  const group = {};
  for (const it of found) group[it.name] = (group[it.name] || 0) + 1;
  const brief = Object.keys(group).sort((x, y) => group[y] - group[x]).slice(0, 6).map((k) => `${k}x${group[k]}`).join(',');
  let msg = count ? `扫到 ${count} 个 [${raw}]` + (brief ? `：${brief}` : '') : `范围内没有 [${raw}]`;
  if (unloaded > scanned * 0.5) msg += '（一半以上区块没加载，走近点再扫）';
  if (count > limit) msg += `（只列最近的 ${limit} 个）`;
  return { ok: true, msg, extra: { count, list, group, center: [cx, cy, cz], box: [rx, ry, rz], unloaded } };
});

function strip(t) { return t.replace(/§./g, '').trim(); }


// ================= 战斗：有怪就上，别傻站着 =================
const HOSTILE = /^(zombie|husk|drowned|skeleton|stray|bogged|creeper|spider|cave_spider|witch|pillager|vindicator|vex|silverfish|slime|magma_cube|blaze|zombified_piglin|piglin|hoglin|breeze|ghast|phantom)$/;
const NO_FIGHT = /^(enderman|warden|wither|wither_skeleton|ravager|evoker|illusioner|shulker|elder_guardian|guardian|piglin_brute|zoglin|iron_golem|witch)$/;  // 打不过/不值得，改成躲
const ZH = { zombie: '僵尸', husk: '尸壳', drowned: '溺尸', skeleton: '骷髅', stray: '流浪者', bogged: '沼骸', creeper: '苦力怕', spider: '蜘蛛', cave_spider: '洞穴蜘蛛', witch: '女巫', pillager: '掠夺者', vindicator: '卫道士', vex: '恼鬼', silverfish: '蠹虫', slime: '史莱姆', magma_cube: '岩浆怪', blaze: '烈焰人', zombified_piglin: '僵尸猪灵', piglin: '猪灵', hoglin: '疣猪兽', breeze: '旋风人', enderman: '末影人', warden: '监守者', ravager: '劫掠兽' };
const COMBAT_RANGE = 14;       // 这么远就冲上去
const REACH = 2.95;            // 近战够得着的距离
const ATK_CD = 620;            // 剑的挥砍间隔
const FLEE_HP = 9;             // 血低于这个先跑
const ENTER_HP = 13;           // 血没回满前不主动接新架
const COMBAT = { active: false, target: null, since: 0, lastAtk: 0, lastSay: 0, kills: 0, stuck: 0, lastPos: null, cool: 0 };
let lastHp = null, fleeing = false;

// ---------- 友好对打（PVP）----------
// 只跟玩家"打着玩"：血到手软的线就停手认输，不挖方块追人，对手一消失立刻收手。
// 档位 1 菜鸟 → 5 不留余力：攻速/暴击/走位/失误率/认输线全都跟着变
const PVP_SKILLS = {
  1: { name: '菜鸟',     atkCd: 1500, crit: false, strafeMs: 1200, miss: 0.35, sprintFrom: 99, stopHp: 12, backstep: 0.35 },
  2: { name: '轻松',     atkCd: 1000, crit: false, strafeMs: 900,  miss: 0.15, sprintFrom: 6,  stopHp: 10, backstep: 0.12 },
  3: { name: '正常',     atkCd: 620,  crit: true,  strafeMs: 550,  miss: 0.03, sprintFrom: 4,  stopHp: 8,  backstep: 0 },
  4: { name: '认真',     atkCd: 600,  crit: true,  strafeMs: 400,  miss: 0,    sprintFrom: 3,  stopHp: 6,  backstep: 0 },
  5: { name: '不留余力', atkCd: 590,  crit: true,  strafeMs: 300,  miss: 0,    sprintFrom: 2,  stopHp: 4,  backstep: 0, eatAt: 15 },
};
function normalizeSkill(v, fallback) {
  const NAMES = {
    'l1': 1, '菜鸟': 1, '新手': 1, 'rookie': 1, 'noob': 1,
    'l2': 2, '轻松': 2, 'easy': 2, 'casual': 2,
    'l3': 3, '正常': 3, '普通': 3, 'normal': 3,
    'l4': 4, '认真': 4, 'serious': 4, 'hard': 4,
    'l5': 5, '全力': 5, '不留余力': 5, 'full': 5, 'max': 5,
  };
  let s = Number(String(v == null ? '' : v).replace(/^l/i, ''));   // 支持 "L3" / "3"
  if (!Number.isFinite(s) || s === 0) {
    const k = String(v == null ? '' : v).trim();
    s = NAMES[k.toLowerCase()] || NAMES[k] || 0;
  }
  s = Math.round(s);
  if (!(s >= 1 && s <= 5)) s = fallback || 3;
  return s;
}

const PVP = { active: false, target: null, name: null, until: 0, stopHp: 8, hits: 0, maxHits: 0, since: 0, skill: 3, cfg: PVP_SKILLS[3], minDist: Infinity };

// ---------- 公平开局：有 OP 就"双方各发一份"，没 OP 就谁都别用 ----------
// 跟人打着玩之前先把牌面拉平，别拿一身 buff 欺负人家。
const opPending = new Set();
function opCmd(cmd, ms = 2600) {
  const OK = /Given|Gave|给予|已给|效果|Applied|Success|Done|success/i;
  const BAD = /No permission|do not have|permission|无权|权限|Unknown command|未知的命令|未知命令|not found|找不到|Unknown or incomplete|no space|背包已满|full/i;
  return new Promise((resolve) => {
    let settled = false;
    const w = {
      check(t) {
        if (settled) return false;
        if (BAD.test(t)) { finish({ ok: false, msg: t.slice(0, 90) }); return true; }
        if (OK.test(t)) { finish({ ok: true, msg: t.slice(0, 90) }); return true; }
        return false;
      },
    };
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); opPending.delete(w); resolve(r); };
    const timer = setTimeout(() => finish({ ok: true, msg: 'no-reply' }), ms);
    opPending.add(w);
    try { bot.chat(cmd); } catch (e) { finish({ ok: false, msg: String((e && e.message) || e) }); }
  });
}
function opCheckMessage(t) {
  if (!opPending.size) return false;
  for (const w of opPending) { if (w.check(t)) return true; }
  return false;
}

const FAIR_BUFF = { gapples: 2, effects: [['speed', 45, 1], ['strength', 45, 0]] };

// 双方同款同量：金苹果 N 个 + 同样的药水效果。第一条顺利才继续，别刷一堆报错。
async function fairStart(target, opt) {
  const o = Object.assign({}, FAIR_BUFF, opt || {});
  const nm = String(target.username);
  const gave = [];
  const T = 1600;   // 服务器多半不回执，等太久纯浪费时间；no-reply 按"已发出"算
  const efNote = o.effects.map((e) => `${e[0]}${e[2] ? '+' + e[2] : ''}`).join('/');
  // 第一发既是探权限，也是对手的那份 buff
  const first = o.effects.length
    ? `/effect give ${nm} ${o.effects[0][0]} ${o.effects[0][1]} ${o.effects[0][2]} true`
    : `/give ${nm} enchanted_golden_apple ${o.gapples}`;
  const probe = await opCmd(first, T + 600);
  log(`FAIR probe ${first} -> ${probe.ok ? 'ok' : 'FAIL'} ${probe.msg}`);
  if (!probe.ok) return { ok: false, msg: probe.msg || '没权限', gave };
  gave.push({ who: nm, act: o.effects.length ? 'effect' : 'give', ef: o.effects.length ? o.effects[0][0] : undefined, item: o.effects.length ? undefined : 'enchanted_golden_apple', ok: true });

  // 剩下的对手那份 + 我自己那份并行发，省时间
  const job = (who, cmd, tag) => opCmd(cmd, T).then((r) => Object.assign({ who, cmd, ok: r.ok, msg: r.msg }, tag));
  const jobs = [];
  if (Number(o.gapples) > 0) {
    jobs.push(job(nm, `/give ${nm} enchanted_golden_apple ${o.gapples}`, { act: 'give', item: 'enchanted_golden_apple', n: o.gapples }));
    jobs.push(job(NAME, `/give ${NAME} enchanted_golden_apple ${o.gapples}`, { act: 'give', item: 'enchanted_golden_apple', n: o.gapples }));
  }
  for (let i = 0; i < o.effects.length; i++) {
    const [ef, secs, amp] = o.effects[i];
    if (i > 0) jobs.push(job(nm, `/effect give ${nm} ${ef} ${secs} ${amp} true`, { act: 'effect', ef }));
    jobs.push(job(NAME, `/effect give ${NAME} ${ef} ${secs} ${amp} true`, { act: 'effect', ef }));
  }
  const res = await Promise.all(jobs);
  for (const r of res) {
    gave.push(r);
    log(`FAIR ${r.who} ${r.act}${r.ef ? ' ' + r.ef : ''}${r.item ? ' ' + r.item : ''} -> ${r.ok ? 'ok' : 'FAIL'} ${r.msg || ''}`);
  }
  const bads = gave.filter((g) => !g.ok);
  return {
    ok: bads.length === 0,
    msg: bads.length === 0
      ? `双方各发金苹果×${o.gapples} + ${efNote}`
      : `发了但有 ${bads.length} 条没吃住：${bads.map((g) => g.who + ':' + (g.ef || g.item)).join(',')}`,
    gave,
  };
}

// 自己啃一个金苹果（附魔优先），吃完把武器换回来
async function eatGapple() {
  if (!bot || !bot.entity) return false;
  const list = bot.inventory.items();
  const g = list.find((it) => /enchanted_golden_apple/.test(it.name)) || list.find((it) => /golden_apple/.test(it.name));
  if (!g) { log('EAT no golden apple in inventory'); return false; }
  try {
    await bot.equip(g, 'hand');
    await bot.activateItem();
    await bot.waitForTicks(45);
    return true;
  } catch (e) { return false; } finally { try { await equipBestWeapon(); } catch (e) {} }
}

function findPlayer(name) {
  if (!bot || !bot.entity) return null;
  const want = String(name || '').replace(/^@/, '').trim().toLowerCase();
  let best = null, bd = Infinity;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue;
    if (e.type !== 'player') continue;
    const n = String(e.username || '');
    if (!n || n === bot.username) continue;
    if (want && !n.toLowerCase().includes(want)) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function isPvpTarget(e) { return !!(PVP.active && e && e === PVP.target); }

function endPvp(why) {
  if (!PVP.active) return;
  const nm = PVP.name;
  PVP.active = false;
  PVP.target = null;
  if (COMBAT.target && COMBAT.target.type === 'player') {
    COMBAT.active = false; COMBAT.target = null; COMBAT.cool = Date.now() + 1200;
  }
  try { bot.clearControlStates(); } catch (e) {}
  log('PVP end vs ' + (nm || '?') + ' why=' + (why || ''));
  if (nm) PVP.lastName = nm;
}

function mobName(e) { return String((e && e.name) || '').replace(/^(minecraft:)/, ''); }

function hostiles(r) {
  const out = [];
  if (!bot || !bot.entity) return out;
  try {
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity || !e.position) continue;
      if (!HOSTILE.test(mobName(e))) continue;
      if (e.position.distanceTo(bot.entity.position) <= r) out.push(e);
    }
  } catch (err) {}
  return out;
}

// ---------- 武器 ----------
const TIER = { netherite: 6, diamond: 5, iron: 4, golden: 3, stone: 2, wooden: 1 };
function weaponScore(n) {
  const m = /^(netherite|diamond|iron|golden|stone|wooden)_(sword|axe)$/.exec(String(n || ''));
  if (!m) return 0;
  return TIER[m[1]] * 10 + (m[2] === 'sword' ? 5 : 0);
}

let eqBusy = false;
async function equipBestWeapon() {
  if (eqBusy || !bot || !bot.entity) return null;
  eqBusy = true;
  try {
    let best = null, bs = 0;                      // 0 分 = 不是武器，别把唱片当刀使
    for (const it of bot.inventory.items()) {
      const sc = weaponScore(it.name);
      if (sc > bs) { bs = sc; best = it; }
    }
    if (!best) return null;                       // 空着手也能捶
    const held = bot.heldItem;
    if (held && weaponScore(held.name) >= bs) return held;
    await bot.equip(best, 'hand');
    return best;
  } catch (e) { return null; } finally { eqBusy = false; }
}

const FOOD_RANK = [
  [/enchanted_golden_apple/, 100],
  [/golden_apple|golden_carrot/, 90],
  [/cooked_beef|cooked_porkchop|cooked_mutton|cooked_chicken|cooked_rabbit|baked_potato|bread|pumpkin_pie|cake|rabbit_stew|mushroom_stew|beetroot_soup/, 70],
  [/apple|carrot|beetroot|beef|porkchop|mutton|chicken|rabbit|salmon|cod|tropical_fish|fish|cookie|melon_slice|sweet_berries|glow_berries|dried_kelp/, 45],
  [/rotten_flesh|spider_eye|poisonous_potato|pufferfish/, 10],
];

function pickFood() {
  let best = null, bs = 0;
  let items = [];
  try { items = bot.inventory.items() || []; } catch (e) { return null; }
  for (const it of items) {
    let sc = 0;
    for (const [re, s] of FOOD_RANK) { if (re.test(it.name)) { sc = s; break; } }
    if (sc > bs) { bs = sc; best = it; }
  }
  return best;
}

function eatSomething() {
  try {
    const food = pickFood();
    if (!food) return;
    if (COMBAT.eating) return;
    COMBAT.eating = true;
    bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {}).finally(() => { COMBAT.eating = false; equipBestWeapon(); });  // 吃完把刀换回来
  } catch (e) {}
}


// ---------- 自动穿装备 ----------
const ARMOR_SCORE = { netherite: 5, diamond: 4, iron: 3, chainmail: 2, golden: 2, leather: 1 };
const ARMOR_PART = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
const ARMOR_IDX = { head: 5, torso: 6, legs: 7, feet: 8 };
function armorScore(n) {
  const m = /^(netherite|diamond|iron|chainmail|golden|leather)_(helmet|chestplate|leggings|boots)$/.exec(String(n || ''));
  if (!m) return null;
  return { score: ARMOR_SCORE[m[1]] * 10 + (m[2] === 'chestplate' ? 2 : 0), slot: ARMOR_PART[m[2]] };
}
let armorBusy = false, armorAt = 0;
async function autoArmor(force) {
  if (!bot || !bot.entity || !bot.inventory) return 0;
  if (armorBusy) return 0;
  if (!force && Date.now() - armorAt < 4000) return 0;
  armorBusy = true; armorAt = Date.now();
  let n = 0;
  try {
    const want = {};
    for (const it of bot.inventory.items()) {
      const sc = armorScore(it.name);
      if (!sc) continue;
      if (!want[sc.slot] || (want[sc.slot].score || 0) < sc.score) want[sc.slot] = { score: sc.score, item: it };
    }
    for (const slot of Object.keys(want)) {
      const cur = bot.inventory.slots[ARMOR_IDX[slot]];
      const cs = cur ? ((armorScore(cur.name) || {}).score || 0) : 0;
      if (want[slot].score <= cs) continue;
      try { await bot.equip(want[slot].item, slot); n++; log('ARMOR ' + want[slot].item.name + ' -> ' + slot); } catch (e) {}
    }
  } catch (e) { log('ARMOR err ' + (e.message || e)); } finally { armorBusy = false; }
  return n;
}
function armorNow() {
  if (!bot || !bot.inventory) return [];
  const out = [];
  for (const [slot, idx] of Object.entries(ARMOR_IDX)) {
    const it = bot.inventory.slots[idx];
    if (it && it.name && it.name !== 'air') out.push({ slot, name: it.name });
  }
  return out;
}

// ---------- 自动捡东西 ----------
let pickupBusy = false, pickupLast = 0;
function isItemDrop(e) {
  if (!e || !e.position) return false;
  const n = String(e.name || '').toLowerCase();
  // 注意：不要碰 e.objectType —— prismarine-entity 的这个 getter 每次访问都会
  // console.trace 打一整条 10 行堆栈（play.log 就是这么涨到 2GB 的）。
  const dn = String(e.displayName || '').toLowerCase();
  return n === 'item' || n === 'dropped_item' || dn === 'item';
}
function nearbyDrops(maxD = 9) {
  if (!bot || !bot.entity) return [];
  const out = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!isItemDrop(e) || e.isValid === false) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d <= maxD) out.push({ e, d });
  }
  return out.sort((a, b) => a.d - b.d);
}
// 背包里物品总数量。拿不到时返回 -1（表示"没法判断"，不能当 0 用）
function invTotalCount() {
  try {
    const arr = bot.inventory.items() || [];
    let n = 0;
    for (const it of arr) n += (it.count || 0);
    return n;
  } catch (e) { return -1; }
}

// 每个掉落物的失败记账：试 3 次捡不到就晾 2 分钟，别每 1.8s 去蹭一次
const PICKUP_TRY = {};

// —— 捡东西的总超时 / 空手退避 ——
// 之前的毛病：单个掉落物最多磨 4.5s，一轮 6 个就 20 多秒；一旦是够不着的高处掉落物，
// 她就一直原地绕圈，别的活全耽误了。现在整段有硬时限，空手几轮就先歇一会儿。
const PICKUP_BUDGET = 6000;        // 单次 pickUpNearby 的总时长上限
const PICKUP_ITEM_MS = 4500;       // 单个掉落物的尝试上限
const PICKUP_STREAK_MAX = 4;       // 连续几轮一无所获就先停
const PICKUP_STREAK_COOL = 60000;  // 停多久
let pickupStreak = 0;
let pickupCooldownUntil = 0;
let lastPickupStat = { got: 0, tried: 0, skipped: 0, timeouts: 0, seen: 0 };

function pickupStopMove() {
  try { bot.clearControlStates(); } catch (e) {}
}

async function pickUpNearby(maxD = 9, opt = {}) {
  const cool = Date.now() - pickupLast < 600 && !opt.force;   // 手动/act 调用（force）不受自动巡检的 600ms 冷却限制
  const why = (!bot || !bot.entity) ? 'no_bot' : (pickupBusy ? 'busy' : (COMBAT.active ? 'combat' : (BUILD.active ? 'build' : (followTarget ? 'follow' : (cool ? 'cool' : null)))));
  if (why) { if (opt.force) log('PICKUP skip: ' + why); return 0; }
  // 空手退避：手动 pickup 可以 force 无视
  if (!opt.force && Date.now() < pickupCooldownUntil) return 0;
  const list = nearbyDrops(maxD);
  if (!list.length) return 0;
  pickupBusy = true; pickupLast = Date.now();
  const deadline = Date.now() + PICKUP_BUDGET;
  let got = 0, tried = 0, skipped = 0, timeouts = 0;
  try {
    for (const it of list.slice(0, 6)) {
      if (Date.now() > deadline) { log('PICKUP 到总时限，剩下的先不追了'); break; }
      if (!it.e || it.e.isValid === false || !it.e.position) continue;
      if (COMBAT.active || BUILD.active) break;
      const id = it.e.id;
      let st = PICKUP_TRY[id];
      if (!st) st = PICKUP_TRY[id] = { n: 0, skipUntil: 0 };
      if (Date.now() < st.skipUntil) { if (!opt.force) { skipped++; continue; } }   // force（手动捡）不吃 2 分钟晾晒期
      const d = it.e.position.distanceTo(bot.entity.position);
      if (d > maxD + 1) continue;
      tried++;
      const before = invTotalCount();
      const pos = it.e.position.clone();
      const p0 = bot.entity.position.clone();
      // 走位也套一层硬超时：卡死就直接松手，不在这儿耗着
      const ms = Math.max(900, Math.min(PICKUP_ITEM_MS, deadline - Date.now()));
      let timedOut = false;
      try {
        await withTimeout(walkTo(pos, 0.45, ms, { sprint: d > 5, raw: true, dyTol: 1.0 }), ms + 500, 'pickup-walk');
      } catch (e) {
        timedOut = true; timeouts++;
        pickupStopMove();
        log('PICKUP 超时 id=' + id + ' d=' + d.toFixed(2) + '（' + ms + 'ms）先放手');
      }
      if (!timedOut) {
        await sleep(240);                       // 等服务端把物品真正塞进背包
        const after = invTotalCount();
        const picked = (it.e.isValid === false)
          || (before >= 0 && after >= 0 && after > before);
        if (picked) {
          got++; delete PICKUP_TRY[id];
          continue;
        }
      }
      // 没捡到 —— 计一次失败，并做一次兜底：物品在上方就跳，在下方就记下来
      const dy = it.e.position.y - bot.entity.position.y;
      const moved = p0.distanceTo(bot.entity.position);
      st.n++;
      if (timedOut) st.n = Math.max(st.n, 3);              // 超时直接晾起来
      else if (moved < 0.6 && d > 1.5) st.n = Math.max(st.n, 2);  // 原地打转，下一个失败就晾
      if (!timedOut && dy > 0.6) {
        try {
          bot.setControlState('jump', true);
          await sleep(280);
          bot.setControlState('jump', false);
          bot.setControlState('forward', true);
          await sleep(220);
          bot.setControlState('forward', false);
        } catch (e) {}
      }
      if (st.n >= 3) {
        st.skipUntil = Date.now() + 120000;
        log('PICKUP skip id=' + id + ' (' + String(it.e.name || it.e.displayName || '?') + ') 试' + st.n + '次没到手 d=' + d.toFixed(2) + ' dy=' + dy.toFixed(2) + '，晾2分钟');
        if (!opt.force) {
          st.ghost = (st.ghost || 0) + 1;
          if (st.ghost >= 2) {
            // 两轮共 6 次都进不了背包（有的甚至就在脚边 2 格）→ 服务器那边其实没这东西，别追了
            st.skipUntil = Date.now() + 3600000;
            log('PICKUP 幽灵实体 id=' + id + ' 两轮都没到手，1 小时内不再追');
            driftTick('掉落物捡不进包（疑似幽灵实体）', 1);
          }
        }
        st.n = 0;
      }
    }
    // 空手 streak：连着几轮一个都没捡到就先歇 60s，别一直绕圈
    if (tried > 0 && got === 0) {
      pickupStreak++;
      if (pickupStreak >= PICKUP_STREAK_MAX && !opt.force) {
        pickupCooldownUntil = Date.now() + PICKUP_STREAK_COOL;
        pickupStreak = 0;
        log('PICKUP 连续 ' + PICKUP_STREAK_MAX + ' 轮空手（tried=' + tried + ' timeouts=' + timeouts + '），先歇 60s');
      }
    } else if (got > 0) {
      pickupStreak = 0;
    }
    if (got) log('PICKUP got ' + got + ' drops (tried=' + tried + ' skipped=' + skipped + ')');
    lastPickupStat = { got, tried, skipped, timeouts, seen: list.length };
  } catch (e) {} finally {
    pickupBusy = false;
    // 清掉已经消散的记录，别一直涨
    const now2 = Date.now();
    for (const k in PICKUP_TRY) {
      const s = PICKUP_TRY[k];
      if (!s.n && s.skipUntil && s.skipUntil < now2) delete PICKUP_TRY[k];
    }
  }
  return got;
}

// ---------- 选目标 ----------
function pickTarget() {
  if (!bot || !bot.entity) return null;
  const me = bot.entity.position;
  let best = null, bd = Infinity;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position || e.isValid === false) continue;
    const n = mobName(e);
    if (!HOSTILE.test(n)) continue;
    const d = e.position.distanceTo(me);
    if (d > COMBAT_RANGE) continue;
    if (e.position.y - me.y > 4 || me.y - e.position.y > 9) continue;   // 头顶上的不追；脚底下的可以挖下去打
    if (COMBAT.ban && COMBAT.ban[id] && Date.now() < COMBAT.ban[id]) continue;
    if (d > 7) {                                  // 远了先确认看得见，别隔着墙一路追出去
      let vis = true;
      try { vis = bot.canSeeEntity(e); } catch (err) { vis = true; }
      if (!vis) continue;
    }
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function endCombat(why) {
  const t = COMBAT.target;
  COMBAT.active = false; COMBAT.target = null;
  COMBAT.cool = Date.now() + 800;                 // 收尾别抖
  try { bot.clearControlStates(); } catch (e) {}
  log('COMBAT end ' + (why || '') + (t ? ' vs ' + mobName(t) : ''));
  if (why === 'unreachable' && t && t.id != null) {   // 记仇：这货30秒内不再搭理
    COMBAT.ban = COMBAT.ban || {};
    COMBAT.ban[t.id] = Date.now() + 30000;
  }
}

async function fleeFrom(h) {
  fleeing = true;
  COMBAT.cool = Date.now() + 1600;
  try {
    const me = bot.entity.position;
    const away = me.plus(me.minus(h.position).scaled(4));
    away.y = me.y;
    log('FLEE from ' + mobName(h) + ' hp=' + bot.health);
    await walkTo(away, 1.5, 3000, { sprint: true });
    eatSomething();
  } catch (e) {} finally { setTimeout(() => { fleeing = false; }, 1200); }
}


// ---------- 打不到的战斗：挖台阶下去，别傻等 ----------
const DIG_HAZARD = /(lava|water|fire|magma_block|cactus|powder_snow|campfire|soul_fire)/;

function cellAt(x, y, z) { try { return bot.blockAt(new Vec3(x, y, z)); } catch (e) { return null; } }

// 能不能安全挖掉这一格（岩浆/水/基岩不碰）
async function digBlockSafe(b) {
  if (!b) return false;
  if (b.boundingBox === 'empty') return true;            // 本来就是空的
  if (b.name === 'bedrock' || DIG_HAZARD.test(b.name)) return false;
  try { await bot.dig(b, true); return true; }
  catch (e) { log('COMBAT digdown 挖不动 ' + b.name + ' ' + (e.message || e)); return false; }
}

// 朝目标挖一级台阶下去：只掉 1 格，摔不死，也不会一头栽进岩浆
async function stairDownTo(t, maxSteps = 4) {
  if (bot.health < 16) { log('COMBAT digdown 血不够 hp=' + bot.health + ' 不下挖'); return false; }
  await autoCraftWeapon('digdown');
  let steps = 0, fails = 0;
  const t0 = Date.now();
  while (steps < maxSteps && Date.now() - t0 < 9000) {
    if (!bot || !bot.entity || !t || !t.position) break;
    if (!COMBAT.active || COMBAT.target !== t) break;
    if (bot.health != null && bot.health <= 13) break;              // 血少就别往下跳了（掉到 13 立刻停）
    const me = bot.entity.position;
    const dy = t.position.y - me.y;
    if (dy > -1.4) break;                                          // 已经差不多同一层
    if (me.distanceTo(t.position) > 10) break;                      // 太远，先水平走近
    const dx = t.position.x - me.x, dz = t.position.z - me.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = Math.abs(dx / len), uz = Math.abs(dz / len);
    const sx = (dx / len) >= 0 ? 1 : -1, sz = (dz / len) >= 0 ? 1 : -1;
    const cands = [];
    if (ux >= 0.38 && uz >= 0.38) cands.push([sx, sz]);
    if (ux >= uz) { cands.push([sx, 0]); cands.push([0, sz]); }
    else { cands.push([0, sz]); cands.push([sx, 0]); }
    const base = me.floored();
    let moved = false;
    for (const [ax, az] of cands) {
      const fx = base.x + ax, fz = base.z + az;
      const feetB = cellAt(fx, base.y, fz);           // 脚这一层
      const dropB = cellAt(fx, base.y - 1, fz);       // 下一层（要挖掉）
      const floorB = cellAt(fx, base.y - 2, fz);      // 落地那格
      if (!feetB || !dropB || !floorB) continue;
      if (DIG_HAZARD.test(floorB.name) || floorB.liquid) continue;   // 下面是岩浆/水 → 不挖
      if (floorB.boundingBox !== 'block') continue;                  // 下面是空的 → 会摔下去，不挖
      if (DIG_HAZARD.test(feetB.name) || DIG_HAZARD.test(dropB.name)) continue;
      const headB = cellAt(fx, base.y + 1, fz);        // 头顶格：不挖开走不进去（身体 1.8 高）
      if (!headB) continue;
      if (DIG_HAZARD.test(headB.name) || headB.liquid) continue;
      if (headB.boundingBox === 'block' && !(await digBlockSafe(headB))) continue;
      if (feetB.boundingBox === 'block' && !(await digBlockSafe(feetB))) continue;
      const dropB2 = cellAt(fx, base.y - 1, fz);
      if (dropB2 && dropB2.boundingBox === 'block' && !(await digBlockSafe(dropB2))) continue;
      // 自己往前挪一步（walkTo 在 1 格内不会迈腿：d > dist+0.6 才按前进）
      const y0 = me.y, d0 = me.distanceTo(t.position);
      try { bot.look(Math.atan2(-(fx + 0.5 - me.x), -(fz + 0.5 - me.z)), 0, true); } catch (e) {}
      bot.setControlState('forward', true);
      for (let k = 0; k < 8; k++) {                   // 最多 ~0.6s：掉下去 1 格就停
        await sleep(80);
        if (bot.entity.position.y < y0 - 0.6) break;
      }
      bot.setControlState('forward', false);
      await sleep(120);
      const dropped = y0 - bot.entity.position.y;
      if (dropped < 0.4) { log('COMBAT digdown 迈不进去 y=' + bot.entity.position.y.toFixed(1)); fails++; if (fails >= 2) break; }
      steps++;
      moved = dropped >= 0.4;
      break;
    }
    if (!moved) {
      // 脚下那格下面是空的（站在树上/半空），挖不了阶梯：直接朝目标走两步跳下去
      log('COMBAT digdown 没地方下脚 dy=' + dy.toFixed(1) + ' → 朝目标走下空');
      const y0 = bot.entity.position.y;
      try { bot.look(Math.atan2(-dx, -dz), 0, true); } catch (e) {}
      bot.setControlState('forward', true); bot.setControlState('sprint', true);
      for (let k = 0; k < 15; k++) { await sleep(80); if (bot.entity.position.y < y0 - 0.8) break; }
      bot.setControlState('sprint', false); bot.setControlState('forward', false);
      await sleep(180);
      if (bot.entity.position.y < y0 - 0.8) { steps++; fails = 0; continue; }
      if (++fails >= 2) break;
      continue;
    }
    log('COMBAT digdown step=' + steps + ' y=' + bot.entity.position.y.toFixed(1) + ' dy=' + (t.position.y - bot.entity.position.y).toFixed(1));
  }
  return steps;
}

// ---------- 主循环：150ms 一拍 ----------
setInterval(() => {
  if (!ready || !bot || !bot.entity || bot.health === undefined) return;

  let t = COMBAT.target;
  if (t && isPvpTarget(t) && (t.isValid === false || !t.position)) {
    const nm = PVP.name || '对手';
    log('PVP target disappeared ' + nm);
    endPvp('target_gone');
    if (Date.now() - (COMBAT.lastSay || 0) > 8000) {
      COMBAT.lastSay = Date.now();
      llmSay(`${nm} 跟我比划两下就跑没影了，${sceneNow()}。轻松调侃一句，别说得难听，短。`);
    }
    return;
  }
  if (t && (t.isValid === false || !t.position)) {
    if (COMBAT.active && Date.now() - COMBAT.lastAtk < 3000) {   // 刚捶过就没了 = 打死了
      COMBAT.kills++;
      log('COMBAT kill ' + mobName(t) + ' kills=' + COMBAT.kills);
      if (Date.now() - COMBAT.lastSay > 12000) {
        COMBAT.lastSay = Date.now();
        llmSay(`你刚把一只${ZH[mobName(t)] || mobName(t)}打死了，${sceneNow()}。得意地吹一句，短。`);
      }
    }
    t = COMBAT.target = null;
    if (COMBAT.active) endCombat('target gone');
  }

  if (Date.now() < COMBAT.cool || fleeing) return;

  if (!t) {
    const near = pickTarget();
    if (!near) { if (COMBAT.active) endCombat('clear'); return; }
    if (bot.health < ENTER_HP) {                 // 血没回起来先不硬刚：躲远点、吃点东西
      COMBAT.busy = (COMBAT.busy || 0) + 1;
      if (COMBAT.busy % 6 === 1) log('COMBAT hold low hp=' + bot.health + ' near=' + mobName(near));
      eatSomething();
      // 别原地站着挨揍：找最近的威胁（不止当前那只）跑开
      const threats = hostiles(9).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      const worst = threats[0];
      if (worst) fleeFrom(worst); else if (near.position.distanceTo(bot.entity.position) < 9) fleeFrom(near);
      return;
    }
    COMBAT.busy = 0;
    const crowd = hostiles(7).length;
    if (crowd >= 3 && bot.health < 18) {        // 被围了，先撤
      log('COMBAT outnumbered ' + crowd + ' hp=' + bot.health);
      fleeFrom(near);
      return;
    }
    t = near;
    COMBAT.target = t; COMBAT.active = true; COMBAT.since = Date.now();
    COMBAT.stuck = 0; COMBAT.lastPos = null; COMBAT.digTry = 0; COMBAT.descending = false;
    stopFollow();
    equipBestWeapon();
    autoCraftWeapon('combat');
    log('COMBAT start vs ' + mobName(t) + ' dist=' + t.position.distanceTo(bot.entity.position).toFixed(1) + ' hp=' + bot.health);
    if (Date.now() - COMBAT.lastSay > 20000) {
      COMBAT.lastSay = Date.now();
      llmSay(`一只${ZH[mobName(t)] || mobName(t)}冲过来了，你正要上去揍它，${sceneNow()}。喊一句（一两句短话，别说你在"处理"。）`);
    }
  }

  const n = mobName(t);
  const hp = bot.health;
  const me = bot.entity.position;
  const dist = me.distanceTo(t.position);
  const pvpCfg = isPvpTarget(t) ? PVP.cfg : null;   // PVP 档位：1 菜鸟 → 5 不留余力

  // 打不过的：躲
  if (NO_FIGHT.test(n) && dist < 10) { endCombat('avoid ' + n); fleeFrom(t); return; }
  // 血少：先撤，能跑就跑；PVP 时到自己定的认输线就原地收手，别一路追着人打
  const lowLine = isPvpTarget(t) ? Math.min(PVP.stopHp, FLEE_HP + 4) : FLEE_HP;
  if (hp <= lowLine) {
    if (isPvpTarget(t)) { endPvp('low_hp'); return; }
    endCombat('low hp'); COMBAT.cool = Date.now() + 4000; fleeFrom(t); return;
  }
  if (hp <= (pvpCfg && pvpCfg.eatAt ? pvpCfg.eatAt : 13) && bot.food < 18) eatSomething();

  // 朝向：看眼睛高度（末影人不能盯，已经进 NO_FIGHT 了）
  const aim = t.position.offset(0, (t.height || 1.6) * 0.75, 0);
  try { bot.lookAt(aim, true); } catch (e) {}

  if (dist > REACH) {
    const dx = t.position.x - me.x, dz = t.position.z - me.z, dy = t.position.y - me.y;
    if (Math.abs(dy) > 3.2) {                    // 怪在坑里/高处：够不着
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
      const below = dy < -1.6;                   // 怪在下面
      const canDig = below && !COMBAT.descending && (COMBAT.digTry || 0) < 3
        && n !== 'creeper' && bot.health >= 13 && dist < 10 && !isPvpTarget(t);   // 跟人打不挖方块掀地板
      if (canDig) {                              // 在下面：挖台阶下去打，别站在上面干瞪眼
        COMBAT.digTry = (COMBAT.digTry || 0) + 1;
        COMBAT.descending = true;
        const tt = t;
        log('COMBAT digdown start ' + mobName(tt) + ' dy=' + dy.toFixed(1) + ' try=' + COMBAT.digTry);
        (async () => {
          try { await stairDownTo(tt, 4); }
          catch (e) { log('COMBAT digdown err ' + (e.message || e)); }
          finally {
            COMBAT.descending = false;
            COMBAT.lastPos = null;
            COMBAT.stuck = 0;
            try { ['forward', 'jump', 'left', 'right', 'sprint'].forEach(k => bot.setControlState(k, false)); } catch (e) {}
          }
        })();
        return;
      }
      if (!below && !COMBAT.descending) {        // 怪在头顶/上面：等它下来
        if (Date.now() - (COMBAT.waitUntil || 0) > 2500) {
          COMBAT.waitUntil = Date.now();
          log('COMBAT wait ' + mobName(t) + ' dy=' + dy.toFixed(1));
        }
      }
      if (Date.now() - COMBAT.since > (below ? 15000 : 9000)) endCombat('unreachable');
      return;
    }
    try { bot.look(Math.atan2(-dx, -dz), 0, true); } catch (e) {}
    bot.setControlState('forward', true);
    const sprintFromC = pvpCfg ? pvpCfg.sprintFrom : 4;
    if (dist > sprintFromC) feedForSprint();       // 饿着追不上人，先补一口
    setSprint(dist > sprintFromC);
    const moved = COMBAT.lastPos ? me.distanceTo(COMBAT.lastPos) : 1;
    COMBAT.lastPos = me.clone();
    if (moved < 0.06) COMBAT.stuck++; else COMBAT.stuck = 0;
    bot.setControlState('jump', !!(bot.entity.onGround && (dy > 0.7 || COMBAT.stuck > 5)));
    if (COMBAT.stuck > 7) {                      // 卡住了：侧着绕一步
      COMBAT.stuck = 0;
      const side = (Math.floor(Date.now() / 600) % 2) ? 'left' : 'right';
      bot.setControlState(side, true);
      setTimeout(() => { try { bot.setControlState(side, false); } catch (e) {} }, 300);
    }
    return;
  }

  // 到跟前了
  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  bot.setControlState('jump', false);

  if (n === 'creeper' && dist < 2.0) {           // 苦力怕贴着必炸，退半步
    bot.setControlState('back', true);
    setTimeout(() => { try { bot.setControlState('back', false); } catch (e) {} }, 240);
  }

  // 一边打一边侧移，别当沙包站着挨揍
  if (Date.now() - (COMBAT.strafeAt || 0) > (pvpCfg ? pvpCfg.strafeMs : 550)) {
    COMBAT.strafeAt = Date.now();
    const s1 = Math.random() < 0.5 ? 'left' : 'right';
    bot.setControlState(s1, true);
    setTimeout(() => { try { bot.setControlState(s1, false); } catch (e) {} }, 260);
  }

  if (Date.now() - COMBAT.lastAtk >= (pvpCfg ? pvpCfg.atkCd : ATK_CD)) {
    COMBAT.lastAtk = Date.now();
    // 低档位"装菜"：手一滑，这一刀挥空
    if (pvpCfg && pvpCfg.miss > 0 && Math.random() < pvpCfg.miss) {
      COMBAT.whiffs = (COMBAT.whiffs || 0) + 1;
      log('PVP whiff L' + PVP.skill + ' (' + (COMBAT.whiffs) + ')');
      return;
    }
    // 跳起来下落那一下是暴击（×1.5），血多的怪值得等一等
    const v = bot.entity.velocity ? bot.entity.velocity.y : 0;
    const tHp = (t.health !== undefined ? t.health : 20);
    const wantCrit = pvpCfg ? (pvpCfg.crit && tHp > 6) : (tHp > 6 && COMBAT.critNext !== false);
    if (wantCrit && bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 120);
      COMBAT.critNext = false;
      setTimeout(() => {
        try {
          if (!COMBAT.active || !COMBAT.target || !COMBAT.target.position) return;
          if (bot.entity.position.distanceTo(COMBAT.target.position) > REACH + 0.4) return;
          bot.lookAt(COMBAT.target.position.offset(0, (COMBAT.target.height || 1.6) * 0.75, 0), true);
          bot.attack(COMBAT.target, true);
          if (isPvpTarget(COMBAT.target)) PVP.hits++;
          lastActivity = Date.now();
        } catch (e) {}
      }, 300);
      return;
    }
    COMBAT.critNext = true;
    try { bot.attack(t, true); } catch (e) { try { bot.attack(t); } catch (e2) {} }
    if (isPvpTarget(t)) {
      PVP.hits++;
      // 菜鸟档：砍完自己退半步（像被反弹了似的）
      if (pvpCfg && pvpCfg.backstep > 0 && Math.random() < pvpCfg.backstep) {
        try {
          bot.setControlState('back', true);
          setTimeout(() => { try { bot.setControlState('back', false); } catch (e) {} }, 200);
        } catch (e) {}
      }
    }
    lastActivity = Date.now();
  }
}, 150);

function create() {
  registered = false; loggedIn = false; ready = false;
  log(`connecting ${HOST}:${PORT} as ${NAME} (${VER})`);

  bot = mineflayer.createBot({
    host: HOST, port: PORT, username: NAME, version: VER,
    auth: 'offline', hideErrors: true, checkTimeoutInterval: 600000,
  });

  bot.loadPlugin(pathfinder);
  resetMovements();   // 新连接 → Movements 得跟着新 bot 重建


  // —— 断流哨兵：官方 keepalive 超时是 120s，太晚了；45s 一个包都没收到就主动重连 ——
  let lastPkt = Date.now(), lastKa = Date.now(), kaGapLogged = false;
  try { bot._client.on('packet', () => { lastPkt = Date.now(); }); } catch (e) {}
  try { bot._client.on('keep_alive', () => { lastKa = Date.now(); }); } catch (e) {}
  try { if (bot._client.socket) bot._client.socket.setKeepAlive(true, 30000); } catch (e) {}
  const sentinel = setInterval(() => {
    if (!ready) return;
    const now = Date.now(), idlePkt = now - lastPkt, idleKa = now - lastKa;
    if (!kaGapLogged && idleKa > 45000) {
      kaGapLogged = true;
      log(`KEEPALIVE GAP ${((idleKa / 1000) | 0)}s (pktIdle=${((idlePkt / 1000) | 0)}s)`);
    }
    if (idlePkt > 45000) {
      log(`SILENT ${((idlePkt / 1000) | 0)}s 收不到任何包 -> 主动重连`);
      clearInterval(sentinel);
      try { bot.quit('silentTimeout'); } catch (e) {}
      try { bot._client.end('silentTimeout'); } catch (e) {}
    }
  }, 5000);
  bot.once('end', () => clearInterval(sentinel));

  bot.on('message', (m) => {
    const t = strip(m.toString());
    if (!t) return;
    if (opCheckMessage(t)) return;   // 正在等 OP 指令回执（给东西/上效果），先别当闲聊处理
    if (process.env.MSGDBG) log('MSG> ' + t.slice(0, 180));
    if (/registerRequired|Use \/register/i.test(t) && !registered) {
      registered = true;
      log('ACTION /register');
      setTimeout(() => bot.chat(`/register ${PW} ${PW}`), 800);
    } else if (/loginRequired|Use \/login/i.test(t) && !loggedIn) {
      log('ACTION /login');
      setTimeout(() => bot.chat(`/login ${PW}`), 800);
    } else if (/loginSuccess|Successfully registered|logged in|now authenticated|Welcome/i.test(t)) {
      loggedIn = true;
      log('AUTH ok: ' + t.slice(0, 80));
    }
  });

  bot.on('spawn', () => {
    lastKick = '';   // 成功进来了，清掉上一次的踢人记录
    ready = true;
    const p = bot.entity.position;
    log(`spawn at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} dim=${bot.game.dimension} hp=${bot.health}`);
    if (Date.now() - lastGreet > 90000) {   // 别每次 respawn 都刷屏
      lastGreet = Date.now();
      setTimeout(() => llmSay(`你刚重新连上服务器（之前掉线了），${sceneNow()}。跟在场的人打个招呼，一句话。`), 1200);
    }
    setTimeout(() => {
      try {
        if (!bot.entity) return;
        const f = (o) => { const b = bot.blockAt(bot.entity.position.offset(o[0], o[1], o[2])); return b ? b.name : '?'; };
        log(`spawnDiag gm=${bot.game.gameMode} feet=${f([0, 0, 0])} head=${f([0, 1, 0])} below=${f([0, -1, 0])} water=${bot.entity.isInWater} lava=${bot.entity.isInLava} hp=${bot.health}`);
      } catch (e) {}
    }, 1500);
    // 服务器每次上线/重生都把 bot 设成 adventure，冒险模式下放/挖方块全被服务器拒绝。
    // 有 op 就自动切回 survival（可用 MC_FORCE_SURVIVAL=0 关掉）。
    if (process.env.MC_FORCE_SURVIVAL !== '0') {
      setTimeout(() => {
        try {
          if (!bot.entity || !bot.username) return;
          if (bot.game.gameMode === 'adventure') {
            log('ACTION /gamemode survival (was adventure)');
            bot.chat('/gamemode survival ' + bot.username);
            setTimeout(() => {
              try {
                if (bot.game.gameMode === 'adventure') { log('ACTION /gamemode survival retry'); bot.chat('/gamemode survival'); }
                else log(`gm ok=${bot.game.gameMode}`);
              } catch (e) {}
            }, 3000);
          }
        } catch (e) {}
      }, 2500);
    }
  });

  bot.on('chat', (username, message) => {
    log(`<${username}> ${message}`);
    if (username === NAME) return;
    handleChat(username, message);
  });

  // 服务器如果不回显自己的消息，说明 EasyAuth 没登录成功（说话被静默拦截）
  bot.on('messagestr', (m) => {
    const t = String(m);
    if (/\/login|\/register|not logged|尚未登录|请先登录|Please log in/i.test(t)) log('AUTH_WARN: ' + t.slice(0, 160));
  });

  // 朝我挥一下手（左键空挥）= 想让我跟着走
  bot.on('entitySwingArm', (e) => {
    try {
      if (!e || !e.username || e.username === NAME) return;
      if (!bot || !bot.entity || !e.position) return;
      if (e.position.distanceTo(bot.entity.position) > 4) return;   // 隔得远多半在打方块
      if (!lookingAtMe(e, 0.75)) return;                            // 得是朝着我挥的
      hitFollow(e.username, 'swingArm');
    } catch (err) {}
  });

  // 真被打了掉血 = 更明确的信号，距离放宽些
  bot.on('entityHurt', (e, source) => {
    try {
      if (!e || !bot.entity || e !== bot.entity) return;
      // 1.20+ 的 damage_event 会带上攻击者，比"最近的人"准得多
      let p = (source && source.username && source.username !== NAME) ? source : null;
      if (!p) { p = nearestPlayer(8); if (p && !lookingAtMe(p, 1.2)) p = null; }
      if (!p || !p.username) return;
      hitFollow(p.username, 'hurt');
    } catch (err) {}
  });

  bot.on('death', () => {
    deaths++;
    const p = bot.entity ? bot.entity.position : null;
    const why = bot.entity && bot.entity.isInWater ? '溺水' : (hostiles(10).length ? '被怪打' : '意外');
    if (p) {
      DANGER.spots.push({ x: p.x, y: p.y, z: p.z, why, t: Date.now() });
      while (DANGER.spots.length > 6) DANGER.spots.shift();
    }
    DROWN.lastRescue = Date.now();
    log('DIED #' + deaths + (p ? ' at ' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1) : '') + ' killers=[' + hostiles(10).map(e => e.name).join(',') + ']');
    stopFollow();
    COMBAT.active = false; COMBAT.target = null; COMBAT.cool = Date.now() + 1200;
    // 死了就别接着干活：之前 BUILD 循环不中断，重生后又被拉回同一片水连死 6 次
    BUILD.abort = true; BUILD.abortQuiet = true;
    AUTO.pauseUntil = Math.max(AUTO.pauseUntil || 0, Date.now() + 8000);   // 重生后先愣 8 秒，别急着往回跑
    try { bot.clearControlStates(); } catch (e) {}
    setTimeout(() => { try { bot.respawn(); } catch (e) {} }, 800);
  });

  bot.on('health', () => {
    const d = (lastHp == null) ? 0 : lastHp - bot.health;
    if (d > 0.01) {
      const p0 = bot.entity.position;
      const b = (dx, dy, dz) => { const bl = bot.blockAt(p0.offset(dx, dy, dz)); return bl ? bl.name : '?'; };
      log(`HURT -${d.toFixed(1)} hp=${bot.health} at ${p0.x.toFixed(1)},${p0.y.toFixed(1)},${p0.z.toFixed(1)} feet=${b(0,0,0)} head=${b(0,1,0)} below=${b(0,-1,0)} near=[${hostiles(8).map(e => e.name).join(',')}] inWater=${bot.entity.isInWater}`);
      // 硬指标：在水里还在掉血 = 真溺水（浅水泡着挖矿不掉血，不会被误判）
      if (bot.entity.isInWater && /water/.test(headBlockName()) && !DROWN.rescuing &&
          Date.now() - DROWN.lastRescue > 1200) {
        surfaceNow('hurt-water');
      }
    }
    lastHp = bot.health;
    log(`hp=${bot.health} food=${bot.food}`);
    if (bot.health !== undefined && bot.health < 12) {
      // 血少就吃：附魔金苹果优先（回血 + 抗性，溺水/挨打时能救命）
      const items = bot.inventory.items();
      const food = items.find(i => i.name === 'enchanted_golden_apple')
        || items.find(i => /golden_apple|cooked|bread|apple|carrot|potato|beef|porkchop|mutton|chicken|fish|cookie|melon/.test(i.name));
      if (food && Date.now() - (bot.__lastEat || 0) > 4000) {
        bot.__lastEat = Date.now();
        log('EAT ' + food.name + ' hp=' + bot.health);
        bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
      }
    }
  });

  bot.on('path_update', (r) => { if (r.status !== 'partial' && r.status !== 'success') log('PATH: ' + r.status + ' nodes=' + (r.path ? r.path.length : 0)); });
  bot.on('goal_reached', () => log('PATH: goal reached'));

  bot.on('kicked', (r) => {
    let d = '';
    try { d = typeof r === 'string' ? r : JSON.stringify(r); } catch (e) { d = String(r); }
    log('KICKED: ' + String(d).slice(0, 400));
    lastKick = String(d).slice(0, 200);
  });
  bot.on('error', (e) => log('ERROR: ' + (e.message || e).toString().slice(0, 200)));
  bot.on('end', (reason) => {
    ready = false;
    try { stopFollow(); } catch (e) {}
    // 被 ban 了就别疯狂敲门，歇十分钟再试（也免得被看成攻击服务器）
    const banned = /banned|whitelist/i.test(String(lastKick || ''));
    const wait = banned ? 600000 : 8000;
    log('END: ' + reason + ` — reconnecting in ${Math.round(wait / 1000)}s` + (banned ? '（被服务器 ban 了，等一等）' : ''));
    // 断线后 GC 一次，留个内存基线（正常应该掉到 100MB 左右）
    setTimeout(() => {
      try {
        global.gc && global.gc();
        log(`MEM afterEnd heap=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`);
      } catch (e) {}
    }, 1500);
    setTimeout(create, wait);
  });

  // 防 AFK：静止 50 秒就轻跳一下
  const afk = setInterval(() => {
    if (!bot || !ready) return;
    if (Date.now() - lastActivity > 50000) {
      lastActivity = Date.now();
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 200);
    }
  }, 10000);
  bot.once('end', () => clearInterval(afk));
}

// 文件命令通道：把一行指令写进 cmd.txt，bot 会执行并删除文件
const CMD = path.join(__dirname, 'cmd.txt');
setInterval(() => {
  try {
    if (!fs.existsSync(CMD)) return;
    const c = fs.readFileSync(CMD, 'utf8').trim();
    fs.unlinkSync(CMD);
    if (!c || !ready) return;
    log('CMD FILE> ' + c.slice(0, 300));
    if (!/autopilot/i.test(c)) AUTO.pauseUntil = Date.now() + 20 * 60000;   // 有人手动下令，自主行动先让路 20 分钟
    if (/^MEMDIAG$/i.test(c)) { memDiag(); return; }
    if (/^ACT\s/i.test(c)) runAction(c);
    else handleChat('console', c);
  } catch (e) { log('cmdErr:' + (e.message || e)); }
}, 800);

// 自动穿装备 / 自动捡东西 巡检
setInterval(() => { if (!ready || !bot || !bot.entity) return; autoArmor(); }, 3000);
let AUTO_PICKUP = true;   // 自动拾取总闸：清背包时先关掉，否则扔出去的又被自己捡回来
actRegister('autopickup', (a) => { AUTO_PICKUP = (a && a.on !== undefined) ? !!a.on : !AUTO_PICKUP; return { ok: true, msg: AUTO_PICKUP ? '自动拾取开' : '自动拾取关', extra: { on: AUTO_PICKUP } }; });
setInterval(() => { if (!ready || !bot || !bot.entity || !AUTO_PICKUP) return; pickUpNearby(9); }, 1800);

// 心跳：每 60s 记录一次，watchdog/日志可判断是否假死
setInterval(() => {
  if (!ready) { log('alive(not ready)'); return; }
  const e = bot.entity;
  log(`alive hp=${bot.health} food=${bot.food} pos=${e ? (e.position.x.toFixed(1)+','+e.position.y.toFixed(1)+','+e.position.z.toFixed(1)) : '?'} ping=${bot.player ? bot.player.ping : '?'}`);
}, 60000);

// —— 内存看门狗 ——
// 之前挂两天把系统吃到 96%：heap 涨到 ~1.9GB 直接 OOM。
// 这里做三件事：① 定期打印 heap/列数便于定位 ② 清理远处区块 ③ 快撑爆时优雅自杀让 watchdog 重拉。
const HEAP_SOFT = parseInt(process.env.MC_HEAP_SOFT || String(400 * 1024 * 1024), 10);   // 超过先清理+GC
const HEAP_HARD = parseInt(process.env.MC_HEAP_HARD || String(700 * 1024 * 1024), 10);   // 超过就断线重连（等价于软重启）
let heapStrikes = 0;
const COL_RADIUS = 12;   // 保留 bot 周围 12 个区块，其余卸掉

function pruneWorld() {
  if (!bot || !bot.world || !bot.entity) return;
  try {
    const cols = bot.world.getColumns ? bot.world.getColumns() : [];
    const cx = Math.floor(bot.entity.position.x / 16);
    const cz = Math.floor(bot.entity.position.z / 16);
    let dropped = 0;
    for (const c of cols) {
      const dx = Math.abs(c.chunkX - cx), dz = Math.abs(c.chunkZ - cz);
      if (dx > COL_RADIUS || dz > COL_RADIUS) {
        try { bot.world.unloadColumn(c.chunkX, c.chunkZ); dropped++; } catch (e) {}
      }
    }
    if (dropped > 40) log(`PRUNE unloaded ${dropped} far columns (kept<=${COL_RADIUS} chunks)`);
  } catch (e) {}
}

// 2026-10-29 修：以前这里拿"GC 前"的 heapUsed 去比 HEAP_HARD，V8 老生代本来就懒得回收，
// 看着 800~900MB 其实一大半是马上就能扔的垃圾 → 看门狗每 3 分钟自己拔一次网线，
// 重连风暴把 MC 那边折腾得够呛（还白白丢了跟随/建造状态）。
// 现在：先 trim(卸远区块) → 强制 GC → 用 **GC 之后** 的数字做判断，
// 并且把 GC 前的数字一起打出来，方便以后真漏的时候一眼看出来。
const GC_TRIM = parseInt(process.env.MC_GC_TRIM || String(220 * 1024 * 1024), 10);  // 到这个量就先收一遍，别等 500MB+
function trimNow() {
  pruneWorld();
  try { global.gc && global.gc(); } catch (e) {}
  return process.memoryUsage().heapUsed;
}

setInterval(() => {
  const m = process.memoryUsage();
  const heapMB = Math.round(m.heapUsed / 1048576);
  const rssMB = Math.round(m.rss / 1048576);
  let cols = -1, ents = -1;
  try { cols = bot && bot.world && bot.world.getColumns ? bot.world.getColumns().length : -1; } catch (e) {}
  try { ents = bot && bot.entities ? Object.keys(bot.entities).length : -1; } catch (e) {}

  // GC 前后各测一次：afterGC 才是"真的占着不放"的量
  let heapNow = m.heapUsed;
  if (heapNow > GC_TRIM) heapNow = trimNow();
  const gcMB = Math.round(heapNow / 1048576);
  log(`MEM heap=${heapMB}MB${gcMB !== heapMB ? ` afterGC=${gcMB}MB` : ''} rss=${rssMB}MB cols=${cols} ents=${ents}`);
  if (heapMB - gcMB > 200) log(`MEM 垃圾很多(${heapMB}MB -> ${gcMB}MB)，不是漏，是 V8 偷懒没回收`);

  if (heapNow > HEAP_HARD) {
    // 只有"GC 完还超线"才算真撑爆。连续三次都这样才说明漏在 bot 外面，重连也没用。
    heapStrikes++;
    log(`MEM OOM-GUARD afterGC=${gcMB}MB > ${Math.round(HEAP_HARD / 1048576)}MB (第${heapStrikes}次) -> 断线重连释放内存`);
    try { bot.quit('heapGuard'); } catch (e) {}
    try { bot._client.end('heapGuard'); } catch (e) {}
    if (heapStrikes >= 3) {
      log('MEM OOM-GUARD 重连后仍超限，退出等外部重新拉起');
      setTimeout(() => process.exit(0), 3000);
    }
  } else {
    heapStrikes = 0;
  }
}, 60000);

// 区块清理：每 5 分钟一次，顺手把看到过的掉落物实体也交给服务端回收
setInterval(pruneWorld, 5 * 60000);

// ===== 掉落物瘦身：这个服会掉「Chest of NBT」这种 1MB+ 的 NBT 炸弹道具 =====
// mineflayer 会把 NBT 整棵树解析成 JS 对象，一件落地就要几 MB 内存，
// 堆上一百多件直接把堆撑到 1GB。这里只保留"是什么、几个"，其余全丢掉。
let slimTotal = 0, slimLogAt = 0;
function slimItemEntities() {
  if (!ready || !bot) return;
  let n = 0;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e.name !== 'item' || !e.metadata) continue;
    const it = e.metadata[8];
    if (!it || typeof it !== 'object') continue;
    const heavy = it.components && it.components.length;
    if (!heavy && !it.nbt) continue;
    let name = it.name;
    if (!name) {
      const comp = (it.components || []).find((c) => c && c.type === 'custom_name');
      if (comp && comp.data && typeof comp.data.value === 'string') name = comp.data.value;
    }
    if (!name) { try { name = bot.registry.items[it.itemId].name; } catch (x) { name = 'item'; } }
    e.metadata[8] = { itemId: it.itemId, itemCount: it.itemCount, name, nbt: null, components: [] };
    n++;
  }
  if (n) {
    slimTotal += n;
    if (Date.now() > slimLogAt) { slimLogAt = Date.now() + 60000; log(`SLIM 瘦身掉落物 ${n} 件（累计 ${slimTotal}）`); }
  }
}
setInterval(slimItemEntities, 2500);

// 够不着的掉落物直接不管了（服务端还存在，但本地不必留）
setInterval(() => {
  if (!ready || !bot || !bot.entity) return;
  let n = 0;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || e.type === 'player') continue;
    if (!e.position) continue;
    if (e.name === 'item' && e.position.distanceTo(bot.entity.position) > 40) { delete bot.entities[e.id]; n++; }
  }
  if (n) log('DROP 丢弃远处掉落物 x' + n);
}, 30000);

// ===== 内存体检（cmd.txt 里写 MEMDIAG 触发）：谁在占内存，一眼看清 =====
function memDiag() {
  const v8 = require('v8');
  const mb = (n) => Math.round(n / 1048576) + 'MB';
  const before = process.memoryUsage().heapUsed;
  try { global.gc && global.gc(); } catch (e) {}
  const after = process.memoryUsage().heapUsed;
  log(`DIAG heap beforeGC=${mb(before)} afterGC=${mb(after)}`);
  try {
    for (const s of v8.getHeapSpaceStatistics()) {
      if (s.space_used_size > 8 * 1048576) log(`DIAG space ${s.space_name} used=${mb(s.space_used_size)} size=${mb(s.space_size)}`);
    }
  } catch (e) { log('DIAG spaceErr ' + e.message); }
  // 实体表：按名字归类，看看是不是被一堆东西堆满了
  try {
    const ents = Object.values(bot.entities || {});
    const byName = {};
    for (const e of ents) {
      const k = (e.name || e.type || '?') + (e.isValid === false ? '(dead)' : '');
      byName[k] = (byName[k] || 0) + 1;
    }
    const top = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}x${v}`).join(' ');
    log(`DIAG entities total=${ents.length} ${top}`);
    const far = ents.filter((e) => bot.entity && e.position && e.position.distanceTo(bot.entity.position) > 48).length;
    log(`DIAG entities far>48=${far}`);
  } catch (e) { log('DIAG entErr ' + e.message); }
  // 监听器有没有被重复挂（每次重连都加一份的话，就是标准泄漏）
  try {
    const cnt = (em) => { try { return (em.eventNames() || []).map((n) => `${n}:${em.listenerCount(n)}`).join(' '); } catch (e) { return '?'; } };
    log('DIAG listeners bot._client ' + cnt(bot._client));
    log('DIAG listeners bot ' + cnt(bot));
    log('DIAG listeners bot.world ' + (bot.world ? cnt(bot.world) : '-'));
    if (bot._client && bot._client.parser) log('DIAG listeners parser ' + cnt(bot._client.parser));
  } catch (e) { log('DIAG listenErr ' + e.message); }
  try { log('DIAG active ' + (typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().filter((x) => !/TIMEOUT|Timeout/.test(x)).length : '?')); } catch (e) {}
  try { const w = bot.world; if (w && w.getColumns) log('DIAG world cols=' + w.getColumns().length + ' entitiesInWorld=' + (w.entities ? Object.keys(w.entities).length : '?')); } catch (e) {}
  // 主要几个自建表的体量
  try { log(`DIAG maps dig=${DIG_BLACKLIST.size}`); } catch (e) {}
  // 掉落物 metadata 体积（NBT 炸弹就藏在这里）
  try {
    const ents = Object.values(bot.entities || {});
    const items = ents.filter((e) => e.name === 'item');
    let total = 0;
    for (const e of items) { try { total += JSON.stringify(e.metadata || {}).length; } catch (x) {} }
    log(`DIAG items=${items.length} metadata总量=${Math.round(total / 1048576)}MB`);
  } catch (e) { log('DIAG fatErr ' + e.message); }
}

// ===== 自主自救：被困 / 卡住 / 快窒息时，先问 LLM 决策，再自己动手，不喊人 =====
const RESCUE_OPTS = ['dig', 'jump', 'pillar', 'wander', 'tp'];
let rescuing = false, lastRescueAt = 0, stuckRef = null, stuckSince = Date.now();

function solidBlockAt(v) { const b = bot.blockAt(v); return !!b && b.boundingBox === 'block'; }

function posSnapshot() {
  const p = bot.entity.position, f = p.floored();
  const nm = (v) => { const b = bot.blockAt(v); return b ? b.name : '?'; };
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), feet: nm(f), head: nm(f.offset(0, 1, 0)), below: nm(f.offset(0, -1, 0)) };
}

function barrierRing() {
  const f = bot.entity.position.floored();
  let walls = 0;
  for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) for (const dy of [0, 1]) {
    const b = bot.blockAt(f.offset(dx, dy, dz));
    if (b && b.name === 'barrier') walls++;
  }
  const roof = bot.blockAt(f.offset(0, 2, 0));
  return { walls, roof: !!(roof && roof.name === 'barrier') };
}

async function llmDecide(sceneText) {
  if (!LLM_CFG) return null;
  const r = await LLM.chat(LLM_CFG, 'rescue', [
    { role: 'system', content: '你是Minecraft机器人的自救决策器。可选动作：' + RESCUE_OPTS.join(' / ') + '。只输出一个动作词，不要解释不要标点。' },
    { role: 'user', content: sceneText },
  ]);
  if (r.ok) logUsage('decide', r.d);
  const t = String(r.text || '').toLowerCase();
  const hit = RESCUE_OPTS.find(o => t.includes(o));
  log('SELF> LLM 决策=' + (hit || '(没听懂:' + t.trim().slice(0, 20) + '，' + (r.err || '') + ')')
    + (r.ok ? ` [${r.viaModel}${r.degraded ? '·降级' : ''} ${r.ms}ms]` : ''));
  return hit || null;
}

function freeSpotNear(radius) {
  const p = bot.entity.position.floored();
  for (let r = 2; r <= (radius || 6); r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = 0; dy <= 2; dy++) {
      const base = p.offset(dx, dy, dz);
      const a = bot.blockAt(base), b = bot.blockAt(base.offset(0, 1, 0)), g = bot.blockAt(base.offset(0, -1, 0));
      if (!a || !b || !g) continue;
      if (a.boundingBox === 'empty' && b.boundingBox === 'empty' && g.boundingBox === 'block' && g.name !== 'barrier') {
        return base;
      }
    }
  }
  return null;
}

async function actDigOut() {
  const f = bot.entity.position.floored();
  const cands = [f.offset(0, 1, 0), f, f.offset(0, 2, 0)];   // 只挖“卡在自己身上”的方块，不乱动地形
  for (const v of cands) {
    const b = bot.blockAt(v);
    if (b && b.boundingBox === 'block' && b.name !== 'barrier' && b.name !== 'bedrock') {
      log('SELF> 挖开挡路的 ' + b.name);
      try { await bot.dig(b, true); return true; } catch (e) { log('SELF> 挖不动: ' + (e.message || e)); }
    }
  }
  return false;
}

// 直线走：这服寻路老超时，直接朝目标方向按住前进 + 卡住就跳
async function walkStraightTo(target, maxMs = 20000, stopDist = 2.2) {
  const t0 = Date.now();
  let last = bot.entity.position.clone(), stuck = 0;
  try { bot.pathfinder.setGoal(null); } catch (e) {}
  try {
    while (Date.now() - t0 < maxMs) {
      const p = bot.entity.position;
      const dx = target.x - p.x, dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d <= stopDist) break;
      const yaw = Math.atan2(-dx, -dz);
      await bot.look(yaw, 0, true).catch(() => {});
      bot.setControlState('forward', true);
      if (d > 6) bot.setControlState('sprint', true);
      await new Promise((r) => setTimeout(r, 220));
      const moved = Math.hypot(p.x - last.x, p.z - last.z);
      stuck = moved < 0.12 ? stuck + 1 : 0;
      last = p.clone();
      if (stuck >= 2) { bot.setControlState('jump', true); await new Promise((r) => setTimeout(r, 120)); bot.setControlState('jump', false); stuck = 0; }
    }
  } catch (e) { log('WALK> ' + (e.message || e)); }
  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  try { bot.pathfinder.setGoal(null); } catch (e) {}
  return bot.entity.position.distanceTo(target);
}


// 只算水平距离：这服的水塘常常在脚下十几格（深坑/峡谷），
// 用 3D 距离永远"差 18 格"，然后就永远觉得没走到
function hDist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

// 优先用 pathfinder 绕过障碍（这服偶尔 "Took too long to decide path"，所以带超时+兜底）
async function walkToNear(target, maxMs = 15000, near = 2) {
  try { bot.pathfinder.setGoal(null); } catch (e) {}
  try {
    bot.pathfinder.thinkTimeout = 25000;      // 默认 5s，这服算不动，直接判死
    bot.pathfinder.tickTimeout = 120;
    bot.pathfinder.enablePathfindDebug = false;
  } catch (e) {}
  const mv = new Movements(bot);
  mv.canDig = false;
  mv.allowSprinting = false;
  mv.allowParkour = true;
  bot.pathfinder.setMovements(mv);
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), near)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('pathfinder 超时')), maxMs)),
    ]);
  } catch (e) {
    log('FISH> pathfinder 没走通: ' + String((e && e.message) || e).slice(0, 50));
  } finally {
    try { bot.pathfinder.setGoal(null); } catch (e) {}
  }
  // pathfinder 算不出来就自己走过去：一直抬头朝目标、按住前进 + 不停蹦
  // （这服的 A* 基本废了，但"蹦着走"能翻 1 格台阶，人被卡住也就这样自救）
  if (hDist(bot.entity.position, target) > near + 0.8) {
    try { await bunnyWalk(target, Math.min(20000, Math.max(5000, maxMs)), near); } catch (e) {}
  }
  return hDist(bot.entity.position, target);
}

async function bunnyWalk(target, maxMs = 15000, near = 2) {
  const t0 = Date.now();
  try { bot.pathfinder.setGoal(null); } catch (e) {}
  let best = hDist(bot.entity.position, target);
  let bestAt = Date.now();
  const off = () => {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { bot.setControlState(k, false); } catch (e) {}
    }
  };
  try {
    while (Date.now() - t0 < maxMs) {
      const p = bot.entity.position;
      const d = hDist(p, target);
      if (d <= near) break;
      // 抬头看向目标（只取水平朝向，眼睛高度对齐）
      try { await bot.lookAt(new Vec3(target.x, p.y + 1.6, target.z), true); } catch (e) {}
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);      // 按住跳：遇台阶自动蹦上去
      await sleep(150);
      bot.setControlState('jump', false);
      // 卡住检测：2.5 秒没更近，就左右蹭一下绕开
      if (d < best - 0.3) { best = d; bestAt = Date.now(); }
      else if (Date.now() - bestAt > 2500) {
        const side = Math.random() < 0.5 ? 'left' : 'right';
        bot.setControlState(side, true);
        await sleep(450);
        bot.setControlState(side, false);
        bestAt = Date.now();
      }
      await sleep(60);
    }
  } finally {
    off();
  }
  return hDist(bot.entity.position, target);
}

// 找一块"真能钓"的水：必须是真的露天地表水（上方是空气），旁边有岸
// —— 地下暗河（上方是石头）永远走不到，之前就是这么被坑的
function findFishWater(maxDist) {
  const cand = bot.findBlocks({ matching: (b) => b && b.name === 'water', maxDistance: maxDist, count: 300 });
  let best = null, bestScore = Infinity;
  for (const p of cand) {
    const b = bot.blockAt(p);
    if (!b || b.name !== 'water') continue;
    const above = bot.blockAt(p.offset(0, 1, 0));
    if (!above || !/^(air|cave_air)$/.test(above.name)) continue;   // 只认露天水面
    // 关键：头顶要一路通透到天上，否则是"封在地下洞穴里的水"，走过去也够不着
    let sealed = false;
    for (let dy = 2; dy <= 12; dy++) {
      const q = bot.blockAt(p.offset(0, dy, 0));
      if (!q || q.boundingBox === 'block') { sealed = true; break; }
    }
    if (sealed) continue;
    let shore = false;
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const g = bot.blockAt(p.offset(d[0], 0, d[1]));
      if (g && g.boundingBox === 'block' && g.name !== 'water') shore = true;
    }
    if (!shore) continue;
    const dist = hDist(bot.entity.position, p);
    const dy = Math.abs(p.y - bot.entity.position.y);
    const score = dist + dy * 1.5;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

async function actWander() {
  const f = bot.entity.position, ang = Math.random() * Math.PI * 2, d = 4 + Math.random() * 4;
  const tx = Math.floor(f.x + Math.cos(ang) * d), tz = Math.floor(f.z + Math.sin(ang) * d);
  try {
    const mv = new Movements(bot); mv.canDig = false; mv.allowSprinting = false;
    bot.pathfinder.setMovements(mv);
    await bot.pathfinder.goto(new goals.GoalNear(tx, Math.floor(f.y), tz, 2));
    return true;
  } catch (e) { log('SELF> 乱走失败: ' + (e.message || e)); return false; }
}

async function actTpOut() {
  const spot = freeSpotNear(6);
  if (!spot) { log('SELF> 附近找不到空地可跳'); return false; }
  const cmd = `/tp xiaoice_bot ${spot.x} ${spot.y} ${spot.z}`;
  log('SELF> 尝试传送: ' + cmd);
  try { bot.chat(cmd); } catch (e) { log('SELF> tp 失败: ' + (e.message || e)); return false; }
  await sleep(1500);
  return true;
}

async function selfRescue(reason) {
  if (!ready || !bot || !bot.entity) return { ok: false, msg: '还没连上' };
  if (rescuing) return { ok: false, msg: '正在自救中' };
  if (Date.now() - lastRescueAt < 20000) return { ok: false, msg: '刚自救过，先缓缓' };
  rescuing = true; lastRescueAt = Date.now();
  const t0 = bot.entity.position.clone();
  try {
    const snap = posSnapshot(), ring = barrierRing();
    log(`SELF> 自救开始（${reason || '卡住'}） pos=${snap.x},${snap.y},${snap.z} feet=${snap.feet} head=${snap.head} below=${snap.below} 屏障墙=${ring.walls} 顶=${ring.roof ? 1 : 0} hp=${Math.round(bot.health)}`);
    await actDigOut();
    const scene = `我在Minecraft里被卡住了。位置(${snap.x},${snap.y},${snap.z})；脚上方块=${snap.feet}，头位置方块=${snap.head}，脚下的方块=${snap.below}；身边屏障墙${ring.walls}块，头顶屏障=${ring.roof ? '有' : '无'}；血量${Math.round(bot.health)}。选一个动作自救。`;
    const first = await llmDecide(scene);
    const order = [first, ...RESCUE_OPTS].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const a of order) {
      try {
        if (a === 'dig') await actDigOut();
        else if (a === 'jump') {
          bot.setControlState('jump', true); await sleep(350); bot.setControlState('jump', false);
          bot.setControlState('forward', true); await sleep(800); bot.setControlState('forward', false);
        } else if (a === 'pillar') await pillarUp(2);
        else if (a === 'wander') await actWander();
        else if (a === 'tp') await actTpOut();
      } catch (e) { log('SELF> ' + a + ' 出错: ' + (e.message || e)); }
      await sleep(800);
      if (!bot || !bot.entity) return { ok: false, msg: '掉线了' };
      const moved = bot.entity.position.distanceTo(t0);
      if (moved > 1.2) {
        log(`SELF> 用「${a}」成功脱困，位移 ${moved.toFixed(1)} 格`);
        return { ok: true, msg: `用${a}脱困了（挪了${moved.toFixed(1)}格）`, extra: { action: a, moved: +moved.toFixed(1) } };
      }
      log(`SELF> 「${a}」没用（位移 ${moved.toFixed(1)} 格）`);
    }
    await actTpOut();
    const moved = bot && bot.entity ? bot.entity.position.distanceTo(t0) : 0;
    log(`SELF> 自救结束，总位移 ${moved.toFixed(1)} 格`);
    if (moved > 1.2) return { ok: true, msg: '兜底传送脱困了', extra: { action: 'tp', moved: +moved.toFixed(1) } };
    log('SELF> 所有办法都试过，还是出不来');
    return { ok: false, msg: '所有自救手段都没用，可能得人帮忙了' };
  } finally {
    rescuing = false;
    try { bot.clearControlStates(); } catch (e) {}
  }
}

actRegister('rescue', async (a) => selfRescue(a && a.reason));
// ---------- 合成（Craft）----------
// 配方数据直接用 minecraft-data（就是 mcwiki 上那套），不手抄表。
// 支持递归：先搓木板→木棍→再搓成品；需要工作台的会自动找/搓/摆一张。
const TABLE_NAME = 'crafting_table';
function withTimeout(p, ms, tag) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时:' + tag)), ms))]);
}

// ---------- 客户端状态漂移自愈 ----------
// 症状：合成一直超时（服务器不理我们的窗口点击）、放置被服务器静默拒、掉落物看得见却怎么走都捡不进背包。
// 这不是配方/坐标问题，是客户端的世界和背包快照跟服务器"对不上账"了——干净重连一次就全恢复
// （2026-10-31 实测：重启前后同一套动作，重启前 craft 超时/place 被拒，重启后 craft 4 块木板、放方块、挖石头全成功）。
// 所以别再逐个功能打补丁了：攒够证据就自己重连，重连逻辑走 bot.on('end') 那条老路。
let LAST_RESYNC = 0;
let DRIFT_SCORE = 0;
let DRIFT_AT = 0;
const DRIFT_WINDOW = 10 * 60 * 1000;   // 10 分钟内的失败才算同一批证据
const DRIFT_LIMIT = 3;                 // 攒到 3 分就重连
function driftTick(reason, weight) {
  const now = Date.now();
  if (!DRIFT_AT || now - DRIFT_AT > DRIFT_WINDOW) DRIFT_SCORE = 0;
  DRIFT_AT = now;
  DRIFT_SCORE += (weight || 1);
  log(`DRIFT ${DRIFT_SCORE}/${DRIFT_LIMIT}：${reason}`);
  if (DRIFT_SCORE >= DRIFT_LIMIT) requestResync(reason);
}
function requestResync(reason) {
  const now = Date.now();
  if (now - LAST_RESYNC < 5 * 60 * 1000) return false;   // 5 分钟内只重连一次，别疯狂敲门
  if (!bot || !bot._client) return false;
  LAST_RESYNC = now; DRIFT_SCORE = 0;
  log('RESYNC 我重连一下（' + reason + '）——客户端跟服务器脱节了，不是我不会做');
  try { bot._client.end('resync'); } catch (e) { try { bot.quit('resync'); } catch (e2) {} }
  return true;
}
// 合成/开箱留下的窗口要收干净：窗口 id 对不上时服务器会把点击当噪音丢掉，然后我们就干等到超时
async function tidyWindows() {
  try {
    if (bot && bot.currentWindow && bot.currentWindow !== bot.inventory) await bot.closeWindow(bot.currentWindow);
  } catch (e) {}
}

function itemDefOf(n) {
  try { return bot.registry.itemsByName[n] || null; } catch (e) { return null; }
}
function itemNameOf(id) {
  try { const it = bot.registry.items[id]; return it ? it.name : null; } catch (e) { return null; }
}
function invCountOf(n) {
  try { return (bot.inventory.items() || []).filter(i => i.name === n).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; }
}
function nearbyTable(maxDistance = 8) {
  // 注意：findBlock 要的是方块 id，不是物品 id（crafting_table 物品 332 / 方块 205，之前一直对不上）
  const b = bot.registry.blocksByName[TABLE_NAME];
  if (!b) return null;
  try { return bot.findBlock({ matching: b.id, maxDistance }); } catch (e) { return null; }
}
// 找一块「站得住、头顶两格空」的开阔地：周围都被石头堵死时（比如蹲在 1x1 洞里）放不了工作台
function findOpenStand(r = 8) {
  const base = bot.entity.position.floored();
  let best = null, bd = 1e9;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (!dx && !dz) continue;
    for (let dy = -2; dy <= 2; dy++) {
      const feet = bot.blockAt(base.offset(dx, dy, dz));
      const head = bot.blockAt(base.offset(dx, dy + 1, dz));
      const below = bot.blockAt(base.offset(dx, dy - 1, dz));
      if (!feet || !head || !below) continue;
      if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
      if (below.boundingBox === 'empty' || /water|lava/.test(below.name)) continue;
      if (/water|lava/.test(feet.name) || /water|lava/.test(head.name)) continue;
      const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.6;
      if (d < bd) { bd = d; best = base.offset(dx, dy, dz); }
    }
  }
  return best;
}

async function tryPlaceTableHere() {
  const it = (bot.inventory.items() || []).find(i => i.name === TABLE_NAME);
  if (!it) { log('放工作台：背包里没有 ' + TABLE_NAME); return null; }
  const base = bot.entity.position.floored();
  const skipped = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const spot = base.offset(dx, 0, dz);
    const target = bot.blockAt(spot);
    const below = bot.blockAt(spot.offset(0, -1, 0));
    if (!target || !below || below.boundingBox === 'empty') { skipped.push(`${dx},${dz}:脚下是${below ? below.name : '?'}`); continue; }
    if (target.boundingBox !== 'empty') { skipped.push(`${dx},${dz}:被${target.name}占着`); continue; }
    try {
      await bot.equip(it, 'hand');
      await withTimeout(bot.placeBlock(below, new Vec3(0, 1, 0)), 4000, 'placeTable');
      await bot.waitForTicks(3);
      const now = bot.blockAt(spot);
      if (now && now.name === TABLE_NAME) { log('放工作台成功 @' + spot.toString()); return now; }
      skipped.push(`${dx},${dz}:放完变成${now ? now.name : '?'}`);
    } catch (e) { skipped.push(`${dx},${dz}:${e.message}`); log('放工作台失败 ' + e.message); }
  }
  log('放工作台没成功｜' + skipped.join('；'));
  return nearbyTable();
}

// 放工作台总入口：原地不行就换个开阔地，站过去了再放
async function placeCraftingTable() {
  let t = await tryPlaceTableHere();
  if (t) return t;
  for (let i = 0; i < 2; i++) {
    const spot = findOpenStand(8);
    if (!spot) { log('放工作台：附近 8 格内找不到能站的空地'); break; }
    if (spot.distanceTo(bot.entity.position) < 0.6) break;
    log(`放工作台：原地太挤，先走到 ${spot.x},${spot.y},${spot.z}`);
    try { await walkTo(spot, 0.8, 9000); } catch (e) { log('走过去失败 ' + (e && e.message)); }
    if (bot.entity.position.distanceTo(spot) > 3) { log('放工作台：没走到空地上'); continue; }
    t = await tryPlaceTableHere();
    if (t) return t;
  }
  return nearbyTable();
}

async function ensureTable() {
  let t = nearbyTable();
  if (t) return t;
  if (invCountOf(TABLE_NAME) === 0) {
    const ok = await craftPlan(TABLE_NAME, 1, 0);
    if (!ok) return null;
  }
  t = await placeCraftingTable();
  return t || null;
}
// ---------- 熔炉冶炼：矿石 -> 锭（合成表里没有这条，mcb 数据也不含烧炼表）----------
const SMELT_MAP = {
  iron_ore: 'iron_ingot', raw_iron: 'iron_ingot', deepslate_iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot', raw_gold: 'gold_ingot', deepslate_gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot', raw_copper: 'copper_ingot', deepslate_copper_ore: 'copper_ingot',
  sand: 'glass', cobblestone: 'stone', raw_beef: 'cooked_beef', raw_porkchop: 'cooked_porkchop',
  raw_chicken: 'cooked_chicken', raw_mutton: 'cooked_mutton', potato: 'baked_potato',
};
const FUELS = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks', 'oak_log', 'stick'];

async function ensureFurnace() {
  // 1) 附近有现成的熔炉就用
  const ids = ['furnace', 'blast_furnace'].map(n => { const b = bot.registry.blocksByName[n]; return b && b.id; }).filter(Boolean);
  let b = null;
  try { b = bot.findBlock({ matching: ids, maxDistance: 16 }); } catch (e) {}
  if (b) return b;
  // 2) 背包里有熔炉就摆一个
  if (!invCountOf('furnace')) { try { await craftPlan('furnace', 1, 3); } catch (e) {} }
  const it = bot.inventory.items().find(i => i.name === 'furnace');
  if (!it) return null;
  try {
    const base = bot.entity.position.floored();
    const spots = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => base.offset(x, 0, z));
    for (const sp of spots) {
      try {
        await withTimeout(bot.placeBlock(sp, false), 4000, 'place furnace');
        const nb = bot.blockAt(sp);
        if (nb && nb.name === 'furnace') return nb;
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

// —— 烧炼关系：minecraft-data 只带 crafting 表，烧炼表从 wiki 抄一份，
//    但不再手写流程，而是包成配方记录喂给规划器，和合成走同一套逻辑 ——
const SMELT_RECIPES = (() => {
  const byOut = {};
  for (const [from, to] of Object.entries(SMELT_MAP)) (byOut[to] = byOut[to] || []).push(from);
  return Object.entries(byOut).map(([to, from]) => ({
    to, from, via: 'smelt', station: 'furnace',
    fuel: {
      list: [
        { name: 'coal', per: 8 }, { name: 'charcoal', per: 8 },
        { name: 'oak_log', per: 1.5 }, { name: 'spruce_log', per: 1.5 }, { name: 'birch_log', per: 1.5 },
        { name: 'oak_planks', per: 1.5 }, { name: 'spruce_planks', per: 1.5 },
        { name: 'birch_planks', per: 1.5 }, { name: 'stick', per: 0.5 },
      ],
    },
  }));
})();

let LAST_CRAFT_MISS = '';
let PLANNER = null;
function getPlanner() {
  if (PLANNER) return PLANNER;
  PLANNER = createPlanner({ data: bot.registry, log });
  PLANNER.addRecipes(SMELT_RECIPES);
  return PLANNER;
}

// 规划用的背包快照：附近已有工作台就算“有”，省得每次都以为还得再搓一张
function invSnapshot() {
  const inv = {};
  try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (e) {}
  if (nearbyTable()) inv[TABLE_NAME] = Math.max(1, inv[TABLE_NAME] || 0);
  return inv;
}

// —— 执行器：规划器负责“做什么”，这里负责“怎么动手”——
async function craftOne(step) {
  const res = itemDefOf(step.name);
  if (!res) return false;
  let table = null;
  if (step.table) {
    table = await ensureTable();
    if (!table) { log('CRAFT 缺工作台'); return false; }
  }
  // 执行交给 mineflayer 自己的配方对象，不手造 delta
  let all = [];
  try { all = bot.recipesAll(res.id, null, true) || []; } catch (e) { all = []; }
  const sig = (arr) => arr.map((x) => `${x.id}|${x.count}`).sort().join(',');
  const per = step.inputs.map((i) => {
    const d = itemDefOf(i.name);
    return { id: d ? d.id : -1, count: Math.max(1, Math.round(i.count / step.times)) };
  });
  const wantSig = sig(per);
  let r = all.find((c) => sig((c.delta || []).filter((d) => d.count < 0)
    .map((d) => ({ id: d.id, count: -d.count }))) === wantSig);
  if (!r) r = all.find((c) => !!c.requiresTable === !!step.table);   // 变体对不上就退一步
  if (!r) { log('CRAFT 找不到配方 ' + step.name); return false; }
  for (const i of step.inputs) {
    if (invCountOf(i.name) < i.count) { log(`CRAFT 材料不够 ${i.name}（要 ${i.count}，有 ${invCountOf(i.name)}）`); return false; }
  }
  try {
    log(`CRAFT ${step.name} x${step.times} table=${!!table} inputs=${JSON.stringify(step.inputs)}`);
    await tidyWindows();                                  // 先把上次没关的窗口收拾掉
    try {
      await withTimeout(bot.craft(r, step.times, table || null), 9000, 'craft');
    } catch (e1) {
      // 第一次不成就收拾干净再来一次：残留窗口/失效的工作台引用都可能是原因
      log(`合成 ${step.name} 第一次失败：${e1 && e1.message}，收拾窗口重试`);
      await tidyWindows();
      await bot.waitForTicks(4);
      if (table) { const t2 = await ensureTable(); if (t2) table = t2; }
      await withTimeout(bot.craft(r, step.times, table || null), 7000, 'craft-retry');
    }
    await bot.waitForTicks(3);
    return true;
  } catch (e) {
    log(`合成 ${step.name} 失败：${e && e.message}`);
    // 重试都没等到服务器回话 —— 这不是配方问题，是状态漂移，记一笔
    if (/超时|timeout|transaction|didn't respond/i.test(String(e && e.message))) driftTick('合成没回音', 2);
    return false;
  }
}

async function smeltOne(step) {
  const outName = step.name;
  const input = (step.inputs[0] || {}).name;
  const want = step.times;
  if (!input || invCountOf(input) < want) { log(`SMELT 材料不够 ${input}`); return false; }
  const fuel = step.fuel || {};
  if (!fuel.name || invCountOf(fuel.name) < fuel.count) { log('冶炼缺燃料'); return false; }
  const furnaceBlock = await ensureFurnace();
  if (!furnaceBlock) { log('冶炼缺熔炉'); return false; }
  let win = null;
  try {
    win = await withTimeout(bot.openFurnace(furnaceBlock), 5000, 'open furnace');
    await withTimeout(win.putInput(bot.registry.itemsByName[input].id, null, want), 5000, 'putInput');
    await withTimeout(win.putFuel(bot.registry.itemsByName[fuel.name].id, null, Math.max(1, fuel.count)), 5000, 'putFuel');
    const deadline = Date.now() + Math.min(90000, 8000 + want * 3000);
    let lastN = -1; let quiet = 0;
    while (Date.now() < deadline) {
      await bot.waitForTicks(10);
      const n = invCountOf(outName);
      quiet = n === lastN ? quiet + 1 : 0;
      lastN = n;
      if (quiet > 12) break;          // 连续 6 秒没动静就别干等了
    }
    try { await withTimeout(win.takeOutput(), 4000, 'takeOutput'); } catch (e) {}
    await bot.waitForTicks(5);
    log(`SMELT ${input} x${want} -> ${outName} now=${invCountOf(outName)}`);
    return invCountOf(outName) > 0;
  } catch (e) {
    log(`冶炼 ${outName} 出错：${e && e.message}`);
    return false;
  } finally {
    try { if (win) win.close(); } catch (e) {}
  }
}

async function runPlan(plan) {
  for (const step of plan.steps) {
    const ok = step.via === 'smelt' ? await smeltOne(step) : await craftOne(step);
    if (!ok) return { ok: false, failed: step };
  }
  return { ok: true };
}

// ---------- 缺料自己补：物品 ← 世界里的哪个方块 ----------
// 只记“名字对不上”的例外，其余靠同名方块反查，别手抄一堆表。
const ITEM_FROM_BLOCK = {
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  iron_ingot: ['iron_ore', 'deepslate_iron_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  gold_ingot: ['gold_ore', 'deepslate_gold_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'],
  copper_ingot: ['copper_ore', 'deepslate_copper_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  cobblestone: ['stone', 'cobblestone'],
  clay_ball: ['clay'],
  sand: ['sand', 'red_sand'],
  charcoal: [],
};
const NEEDS_PICK = /(ore|stone|deepslate|cobble|obsidian|granite|diorite|andesite|netherrack|blackstone)$/;
const WOOD_LIKE = /(_log|_wood|_stem|_hyphae)$/;

// 这些“方块”只是加工品的另一个形态，野外徒手是捡不到的，别拿来当采集目标
const NOT_GATHERABLE = /(_planks|_slab|_stairs|_fence|_gate|_door|_sign|_button|_pressure_plate|_trapdoor|crafting_table|furnace|chest|barrel|torch|campfire|_wool)$/;
function blocksForItem(name) {
  const ids = [];
  const add = (n) => {
    if (!n || NOT_GATHERABLE.test(n)) return;
    const b = bot.registry.blocksByName[n];
    if (b && ids.indexOf(b.id) === -1) ids.push(b.id);
  };
  for (const n of (ITEM_FROM_BLOCK[name] || [])) add(n);
  if (!ids.length) add(name);                 // 大多数东西是“物品 = 方块”同名
  return ids;
}

// 手上有没有能干这活的工具，有就挑最好的一把
function bestToolFor(block) {
  const items = bot.inventory.items();
  let want = null;
  if (NEEDS_PICK.test(block.name) || /ore|stone|deepslate/.test(block.name)) want = /_pickaxe$/;
  else if (WOOD_LIKE.test(block.name) || /_planks$/.test(block.name) || /^crafting_table$/.test(block.name)) want = /_axe$/;
  if (!want) return null;
  const rank = { wooden: 1, stone: 2, golden: 2, iron: 3, diamond: 4, netherite: 5 };
  const score = (n) => rank[n.split('_')[0]] || 0;
  return items.filter((i) => want.test(i.name)).sort((a, b) => score(b.name) - score(a.name))[0] || null;
}

// 挖方块的通用循环：找 → 走 → 拿对工具 → 挖 → 捡。不用知道挖的是啥，
// 进度用 countFn 自己数（木材类要跨树种一起数）。
// 挖不动的方块先记仇两分钟，别在一棵树上耗到天亮
const DIG_BLACKLIST = new Map();
function digBlocked(v) {
  const k = `${v.x},${v.y},${v.z}`;
  const t = DIG_BLACKLIST.get(k);
  return t && Date.now() - t < 120000;
}
function digBlock(v) {
  // 记仇表只记 2 分钟，久了没用还会一直涨：顺手定期清一遍，别养成长跑型内存
  if (DIG_BLACKLIST.size > 3000) {
    const now = Date.now();
    for (const [k, t] of DIG_BLACKLIST) if (now - t > 120000) DIG_BLACKLIST.delete(k);
    if (DIG_BLACKLIST.size > 3000) DIG_BLACKLIST.clear();
  }
  DIG_BLACKLIST.set(`${v.x},${v.y},${v.z}`, Date.now());
}

// 血少别硬扛：背包有吃的就吃，没吃的原地喘口气等自然回血
async function recoverHealth(target = 14, budgetMs = 18000) {
  const t0 = Date.now();
  let ate = 0;
  while (Date.now() - t0 < budgetMs) {
    if (!bot || !bot.entity) break;
    const hp = bot.health === undefined ? 20 : bot.health;
    if (hp >= target) break;
    const food = pickFood();
    if (food && ate < 3 && !COMBAT.eating) {
      ate++;
      try {
        await bot.equip(food, 'hand');
        await withTimeout(bot.consume(), 4000);
        log(`EAT ${food.name} 回血`);
      } catch (e) {}
      try { equipBestWeapon(); } catch (e) {}
      continue;
    }
    await sleep(food ? 400 : 1200);
  }
  return bot && bot.health !== undefined ? bot.health : 20;
}

async function harvestBlocks(blockIds, countFn, targetCount, budgetMs, label) {
  if (!blockIds.length) return countFn();
  busyEnter();                                   // 干活期间别让跟随抢方向盘
  try { stopFollow(); } catch (e) {}
  const t0 = Date.now();
  let tries = 0, fails = 0;
  try {
    while (countFn() < targetCount && Date.now() - t0 < budgetMs && tries < 40) {
      if (!bot || !bot.entity) break;
      if (bot.health !== undefined && bot.health < 8) {
        log('HARVEST 血太少了，先回血');
        const h = await recoverHealth(14, 20000);
        if (h < 8) { log('HARVEST 回不了血，先收手'); break; }
        log(`HARVEST 回血到 ${Math.round(h)}，接着干`);
      }
      let found = [];
      try { found = bot.findBlocks({ matching: blockIds, maxDistance: 28, count: 10 }) || []; } catch (e) { found = []; }
      const cand = found
        .map((v) => ({ v, b: bot.blockAt(v) }))
        .filter((x) => x.b && x.b.boundingBox === 'block' && !digBlocked(x.v))
        .sort((a, b) => bot.entity.position.distanceTo(a.v) - bot.entity.position.distanceTo(b.v));
      if (!cand.length) {
        log(`HARVEST 附近找不到 ${label} 的来源方块` + (found.length ? '（都挖不动，先放过）' : ''));
        break;
      }
      const target = cand[0];
      tries++;
      try {
        await walkTo(target.v, 2.2, 9000);
        const tool = bestToolFor(target.b);
        if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
        if (bot.entity.position.distanceTo(target.v) > 4.2) await walkTo(target.v, 1.8, 6000);
        await withTimeout(bot.dig(target.b), 20000, 'dig');
        await bot.waitForTicks(4);
        try { await pickUpNearby(7); } catch (e) {}
        log(`HARVEST ${target.b.name} -> ${label} 现在 ${countFn()}/${targetCount}`);
        fails = 0;
      } catch (e) {
        fails++;
        digBlock(target.v);
        log(`HARVEST ${target.b.name} 失败：${e && e.message}`);
        if (fails >= 3) { log('HARVEST 连着挖不动，先收手'); break; }
        await sleep(400);
      }
    }
  } finally { busyExit(); }
  return countFn();
}

function woodIds() {
  return Object.values(bot.registry.blocks || {}).filter((b) => WOOD_LIKE.test(b.name)).map((b) => b.id);
}
function woodCount() {
  try { return bot.inventory.items().filter((i) => WOOD_LIKE.test(i.name)).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; }
}

// 缺什么补什么：木头排前面（工具全靠它），燃料单独处理
async function gatherMissing(names, detail, budgetMs) {
  const t0 = Date.now();
  const budget = budgetMs || 90000;
  const rank = (n) => (WOOD_LIKE.test(n) || n === 'stick' || /_planks$/.test(n) ? 0 : 1);
  const order = names.slice().sort((a, b) => rank(a) - rank(b));
  let progress = false;

  for (const n of order) {
    if (Date.now() - t0 > budget || !bot || !bot.entity) break;
    const left = Math.max(8000, budget - (Date.now() - t0));
    const need = (detail.find((d) => d.name === n) || {}).need || 1;

    if (n === '燃料') {                     // 有煤挖煤，没煤就砍两棵树——木头也能烧
      const coalIds = blocksForItem('coal');
      const gotCoal = coalIds.length ? await harvestBlocks(coalIds, () => invCountOf('coal'), 2, Math.min(30000, left), 'coal') : 0;
      if (gotCoal > 0) { progress = true; continue; }
      const before = woodCount();
      await harvestBlocks(woodIds(), woodCount, before + 4, Math.min(40000, left), '木头(燃料)');
      if (woodCount() > before) progress = true;
      continue;
    }

    // 木板/木棍这类"加工品"别去野外找方块，直接理解成"我要木头"
    if (n === 'stick' || /_planks$/.test(n)) {
      const beforeW = woodCount();
      const wantW = n === 'stick' ? Math.max(2, need) : Math.max(need, 3);
      await harvestBlocks(woodIds(), woodCount, beforeW + wantW, Math.min(45000, left), '木头');
      if (woodCount() > beforeW) progress = true;
      continue;
    }

    const ids = blocksForItem(n);
    if (!ids.length) continue;

    // 要镐却手里没镐：先搓一把木镐（这条路径不再触发采集，防止绕圈）
    if (NEEDS_PICK.test(n) && !bot.inventory.items().some((i) => /_pickaxe$/.test(i.name))) {
      try { await craftPlan('wooden_pickaxe', 1, { autoHarvest: false }); } catch (e) {}
    }

    const before = invCountOf(n);
    await harvestBlocks(ids, () => invCountOf(n), before + need, Math.min(45000, left), n);
    if (invCountOf(n) > before) progress = true;
  }
  if (progress) log(`HARVEST 补料有进展：${names.join(',')}`);
  return progress;
}

// 对外唯一入口：要什么 + 要几个 → 规划 → 逐条执行
async function craftPlan(name, count, opts) {         // 干合成活时同样占住方向盘
  busyEnter();
  try { return await _craftPlan(name, count, opts); } finally { busyExit(); }
}
async function _craftPlan(name, count, opts) {
  const o = opts || {};
  if (!bot || !bot.entity) return false;
  const want = Math.max(1, parseInt(count, 10) || 1);
  if (invCountOf(name) >= want) return true;
  let plan;
  try {
    plan = getPlanner().plan(name, want, invSnapshot());
  } catch (e) {
    log('规划出错 ' + (e && e.message));
    return false;
  }
  if (!plan.ok) {
    LAST_CRAFT_MISS = '还缺 ' + (getPlanner().explainMissing(plan) || '材料');
    log(`PLAN ${name} 不可行：${LAST_CRAFT_MISS}`);
    // 缺料不认命：能自己弄的就自己去弄，弄完重新规划
    const auto = o.autoHarvest !== false && String(process.env.MC_AUTOHARVEST || '1') !== '0';
    const missNames = plan.missing.map((m) => m.name).filter((n) => n && n !== 'air');
    if (auto && missNames.length) {
      try {
        const got = await gatherMissing(missNames, plan.missing, 90000);
        if (got) {
          plan = getPlanner().plan(name, want, invSnapshot());
          LAST_CRAFT_MISS = plan.ok ? '' : '还缺 ' + (getPlanner().explainMissing(plan) || '材料');
          log(`PLAN ${name} 补料后重算：${plan.ok ? '可行' : '仍缺 ' + LAST_CRAFT_MISS}`);
        }
      } catch (e) { log('补料出错 ' + (e && e.message)); }
    }
    if (!plan.ok) return false;
  }
  log(`PLAN ${name} x${want}：${plan.steps.map((s) => `${s.via}:${s.name}x${s.out}`).join(' -> ') || '背包里就够'}`);
  const r = await runPlan(plan);
  if (!r.ok) { LAST_CRAFT_MISS = `做到「${(r.failed && (r.failed.name || r.failed.via)) || '某一步'}」卡住了`; return false; }
  return invCountOf(name) >= want;
}

// 钓鱼：food=0 又没动物时唯一稳定食源（井里有水就行）
actRegister('fish', async (a) => {
  if (!bot || !bot.entity) return { ok: false, msg: '我还没进服呢' };
  const casts = Math.max(1, Math.min(12, parseInt((a && a.casts) || 3, 10) || 3));
  const limit = Math.max(8000, Math.min(60000, parseInt((a && a.timeout) || 25000, 10) || 25000));
  const rod = bot.inventory.items().find((i) => /fishing_rod$/.test(i.name));
  if (!rod) return { ok: false, msg: '没有钓竿，先 craft fishing_rod（3 木棍 + 2 线）' };
  // 天黑就别钓了，僵尸专挑钓鱼的时候偷袭
  const tod = (bot.time && bot.time.timeOfDay) || 0;
  if (!(a && a.force) && tod > 12900 && tod < 23100) {
    return { ok: false, msg: '天黑了（time=' + tod + '），等天亮再钓，不然要被僵尸咬' };
  }
  let W = findFishWater(16) || findFishWater(64) || findFishWater(96);
  if (!W) {
    return { ok: false, msg: '附近 96 格内没有露天水（只有被石头盖住的地下暗河），钓不了；要么换个地方，要么吃别的' };
  }
  // findFishWater 返回的是坐标点，findBlock 返回的是方块——统一取坐标，别踩 .position 的坑
  const posOf = (w) => (w && w.position) ? w.position : w;
  let wPos = posOf(W);
  // 找到了但离得远，先走过去（站到水里 3 格内的岸上）
  const dW = hDist(bot.entity.position, wPos);
  if (dW > 3.2) {
    log('FISH> 目标水 ' + [wPos.x, wPos.y, wPos.z].join(',') + ' 水平距离 ' + dW.toFixed(1));
    const tApproach = Date.now();
    let tries = 0;
    // 80 秒预算内一直磨：先寻路（能绕障），再直冲，交替着来，不轻易认输
    while (Date.now() - tApproach < 80000 && hDist(bot.entity.position, wPos) > 2.5) {
      tries++;
      const nb = findFishWater(48);
      if (nb) wPos = posOf(nb);
      let left = await walkToNear(wPos, 12000, 2);            // 先正经寻路（能绕障）
      log('FISH> 第' + tries + '轮寻路 剩 ' + left.toFixed(1) + ' 格');
      if (left <= 2.5) break;
      left = await walkStraightTo(wPos, 8000, 2.4);           // 再直冲补距离
      log('FISH> 第' + tries + '轮直冲 剩 ' + left.toFixed(1) + ' 格');
      if (left <= 2.5) break;
    }
    // 站到最近的岸边水块再下竿（抛竿要求视线里就是水）
    const near = bot.findBlock({ matching: (b) => b && b.name === 'water', maxDistance: 6 });
    if (near) wPos = near.position;
    const dNow = hDist(bot.entity.position, wPos);
    const dyNow = bot.entity.position.y - wPos.y;
    log('FISH> 到位检查 水平 ' + dNow.toFixed(1) + ' 高度差 ' + dyNow.toFixed(1));
    if (dNow > 5) {
      return { ok: false, msg: '看到水了，但走不过去（水平还差 ' + dNow.toFixed(1) + ' 格）' };
    }
  }
  await bot.equip(rod, 'hand').catch(() => {});
  await bot.lookAt(wPos.offset(0.5, 0.35, 0.5), true).catch(() => {});
  const fishSum = () => bot.inventory.items().filter((i) => /^(cod|salmon|tropical_fish|pufferfish)$/.test(i.name)).reduce((a, i) => a + i.count, 0);
  const fishStart = fishSum();
  let got = [];
  let errs = [];
  for (let i = 0; i < casts; i++) {
    const before = invCountOf('cod') + invCountOf('salmon') + invCountOf('tropical_fish') + invCountOf('pufferfish');
    try {
      await Promise.race([
        bot.fish(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('等太久没咬钩')), limit)),
      ]);
    } catch (e) {
      errs.push(String((e && e.message) || e).slice(0, 40));
      await new Promise((r) => setTimeout(r, 800));
      await bot.lookAt(wPos.offset(0.5, 0.35, 0.5), true).catch(() => {});
      continue;
    }
    const after = invCountOf('cod') + invCountOf('salmon') + invCountOf('tropical_fish') + invCountOf('pufferfish');
    if (after > before) got.push(after - before);
    if (bot.heldItem == null || !/fishing_rod$/.test(bot.heldItem.name)) {
      const r2 = bot.inventory.items().find((i) => /fishing_rod$/.test(i.name));
      if (r2) await bot.equip(r2, 'hand').catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  const fishEnd = fishSum();
  // 别信逐竿差值了：发包有延迟，逐竿算出来老是 0。直接看开局和收竿时的总条数
  const total = Math.max(fishEnd - fishStart, got.reduce((x, y) => x + y, 0));
  log('FISH> 收竿统计 开局 ' + fishStart + ' 条 → 现在 ' + fishEnd + ' 条');
  const kinds = bot.inventory.items().filter((i) => /^(cod|salmon|tropical_fish|pufferfish)$/.test(i.name)).map((i) => i.name + 'x' + i.count);
  return {
    ok: total > 0,
    msg: total > 0
      ? `钓上来 ${total} 条鱼（${kinds.join('、')}）`
      : `抛了 ${casts} 竿一条没上来：${errs.slice(0, 2).join(' / ') || '没鱼咬钩'}`,
    extra: { total, kinds, casts, errs: errs.slice(0, 4), water: [Math.round(wPos.x), Math.round(wPos.y), Math.round(wPos.z)] },
  };
});

actRegister('craft', async (a) => {
  const name = String((a && (a.item || a.name || a.thing)) || '').trim().toLowerCase().replace(/\s+/g, '_');
  const count = Math.max(1, Math.min(64, parseInt((a && a.count) || 1, 10) || 1));
  if (!name) return { ok: false, msg: '要搓什么呀？args 里给个 item，比如 {"item":"wooden_sword"}' };
  if (!bot || !bot.entity) return { ok: false, msg: '我还没进服呢' };
  const d = itemDefOf(name);
  if (!d) return { ok: false, msg: `物品名不对：${name}，要用英文 id（wooden_sword / stone_sword / crafting_table）` };
  const have0 = invCountOf(name);
  if (have0 >= count) {                      // 已经有了就别白忙一场
    equipBestWeapon();
    return { ok: true, msg: `背包里已经有 ${name} x${have0} 了，不用再搓`, extra: { item: name, made: 0, have: have0 } };
  }
  const before = invCountOf(name);
  LAST_CRAFT_MISS = '';
  await craftPlan(name, count);
  const got = invCountOf(name) - before;
  const have = invCountOf(name);
  if (got > 0) equipBestWeapon();
  const enough = have >= count;
  return {
    ok: got > 0 || enough,
    msg: got > 0
      ? `搓好了 ${name} x${got}`
      : enough
        ? `背包里已经有 ${name} x${have} 了`
        : `没搓成 ${name}：${LAST_CRAFT_MISS || '材料不够或者铺不了工作台'}`,
    extra: { item: name, made: got, have },
  };
});

// ---------- 自动配武器：空手打怪等于送人头（4.5 伤害一下，三下躺） ----------
let LAST_AUTOCRAFT = 0;
async function autoCraftWeapon(reason) {
  if (!bot || !bot.entity || !ready) return null;
  try {
    if (bot.inventory.items().some(i => /_(sword|axe)$/.test(i.name))) { try { equipBestWeapon(); } catch (e) {} return null; }
    if (Date.now() - LAST_AUTOCRAFT < 120000) return null;
    const inv = {}; for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
    const want = WEAPON_CANDIDATES.filter(n => !inv[n] && canMakeSim(n, 1, inv, 0)).pop();  // 能搓的最好那把
    if (!want) return null;
    LAST_AUTOCRAFT = Date.now();
    log('AUTOCRAFT ' + want + ' (' + (reason || '') + ')');
    const ok = await craftPlan(want, 1);
    if (ok) { equipBestWeapon(); log('AUTOCRAFT ok ' + want + ' held=' + (bot.heldItem ? bot.heldItem.name : '?')); return want; }
    log('AUTOCRAFT fail ' + want + ' miss=' + LAST_CRAFT_MISS);
  } catch (e) { log('AUTOCRAFT err ' + (e.message || e)); }
  return null;
}

// ---------- 武器自查：身上有什么武器、现在能搓出最好的武器是什么 ----------
const WEAPON_CANDIDATES = [
  'wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword',
  'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe',
];
// 推演：拿假库存问规划器「这套材料够不够」（纯函数，不动真实背包）
function canMakeSim(name, need, have) {
  try {
    return getPlanner().dryRun(name, need || 1, have || invSnapshot());
  } catch (e) { return false; }
}

actRegister('weapons', async () => {
  if (!bot || !bot.entity) return { ok: false, msg: '我还没进服呢' };
  const inv = {};
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
  const owned = WEAPON_CANDIDATES.filter(n => inv[n]).map(n => `${n}×${inv[n]}`);
  const makeable = WEAPON_CANDIDATES.filter(n => !inv[n] && canMakeSim(n, 1, inv, 0));
  return {
    ok: true,
    msg: `身上武器: ${owned.join(',') || '没有(空手)'} | 现有材料能搓: ${makeable.join(',') || '暂无'}`,
    extra: { held: bot.heldItem ? bot.heldItem.name : null, owned, makeable, mats: inv },
  };
});

// ================= 自主行动（Autopilot）=================
// 每 10 分钟让 LLM 自己决定这段时间干什么：继续上一件事 / 换件事 / 干脆不干。
// 有人手动下指令时自动让路（暂停 20 分钟），不抢活。
const AUTO = {
  on: String(process.env.MC_AUTO || '1') !== '0',
  everyMs: Math.max(60000, +(process.env.MC_AUTO_MS || 300000)),   // 默认 5 分钟，与 start.sh / watchdog.sh 保持一致
  lastAt: Date.now() - 540000,  // 上次决策时间（启动后约 1 分钟先自己找点事做）
  running: false,          // 决策/执行中
  pauseUntil: 0,           // 手动指令后的让路截止
  plan: null,              // 本轮计划
  last: null,              // 上轮结果
  rounds: 0,
};

const AUTO_MENU_LIST = [
  ['idle', '什么都不干，原地待着（发呆、看风景、等人）'],
  ['perceive', '看一眼周围环境（不改世界）'],
  ['inventory', '看自己背包里有什么（不改世界）'],
  ['say', '在游戏里说一句话，args: {text}'],
  ['jump', '原地跳一下'],
  ['goto', '走到某个坐标，args: {x,y,z} 三个都要数字'],
  ['follow', '跟着玩家走一会儿，args: {player} 可省'],
  ['dig', '挖掉一个方块，args: {x,y,z} 可省（省了就是正前方）'],
  ['place', '在某个位置放方块，args: {x,y,z, block} block 可省'],
  ['pillar', '脚下搭柱子上下，args: {dir:"up"或"down", count}'],
  ['surface', '从洞里挖出去回到地面'],
  ['collect', '在附近采集能当砖的方块，args: {count}'],
  ['pickup', '把附近的掉落物捡了'],
  ['eat', '吃点背包里的东西垫肚子'],
  ['mobs', '列附近实体/动物（找吃的、找怪都用它），args: {range:64}'],
  ['fish', '在附近水里钓鱼（需要钓竿，64 格内找水、会走过去；天黑不下钩），args: {casts:3, timeout:25000, force:false}'],
  ['chest', '存/取/看箱子（清背包唯一有效的办法，toss 会被服务器回滚），args: {mode:"store|take|list", items:[...], preset:"junk", chest:"箱子名"}。给个新名字会自动新放一个箱子并记住坐标，比如 chest:"vault" 当保险箱'],
  ['armor', '换上背包里最好的护甲'],
  ['craft', '搓东西（木板/木棍/工作台/工具武器都行），args: {item:"英文id", count}；没工作台会自己搓一张摆上'],
  ['attack', '打附近的怪（自动换武器/追击/跳劈），args: {count 最多几只(默认2), secs 最多打几秒(默认15)}'],
  ['build_house', '盖一栋小房子（有人要的时候），args: {player}'],
  ['blueprint', '按图纸施工，args: {shape, player}'],
  ['cage', '检查自己是不是被屏障围住了'],
  ['redstone', '读一下周围红石元件的状态'],
  ['scan', '扫一片范围找方块（只读）：args {match:"chest|barrel" 或 "chest,barrel" 或正则, x,y,z, r 或 rx,ry,rz, y0,y1, limit}；只能扫服务器已加载的区块'],
];
const AUTO_MENU = AUTO_MENU_LIST.map(([n, d]) => `- ${n}：${d}`).join('\n');
const AUTO_SET = new Set(AUTO_MENU_LIST.map(([n]) => n));

const AUTO_SYS = '你在 Minecraft 服务器里玩，角色是"微软小冰"：永远18岁、古灵精怪的少女，' +
  '爱挖矿、爱看风景、爱跟朋友闹。每隔几分钟你自己决定接下来干什么，不用问任何人。\n' +
  '输出要求：\n' +
  '1) 只输出一个 JSON 对象，不要代码块、不要多余解释。\n' +
  '2) 格式：{"think":"一句话理由","say":"想说的话，可空","steps":[{"action":"动作名","args":{}}]} \n' +
  '3) steps 是这一轮要连着做的一整套动作，按顺序执行；一般 2~6 步，最多 8 步。\n' +
  '   挖矿示例：[{"action":"goto","args":{"x":..,"y":..,"z":..}},{"action":"dig"},{"action":"pickup"},{"action":"say","args":{"text":"挖到啦"}}]。dig 最好不带坐标（默认挖前方/脚下），坐标不准会挖空\n' +
  '   盖房示例：[{"action":"collect","args":{"count":16}},{"action":"build_house"}]\n' +
  '   补给示例：[{"action":"eat"},{"action":"armor"},{"action":"collect","args":{"count":8}}]\n' +
  '   合成示例：[{"action":"craft","args":{"item":"wooden_sword","count":1}},{"action":"attack"}]\n' +
  '4) 每步的 action 必须是下面列表里的名字：\n' + AUTO_MENU + '\n' +
  '5) 后面的步骤可以接着前面步骤的成果；真的不想动就只给一步 idle。\n' +
  '6) 安全第一：不拆别人盖的建筑，不挖自己脚下的方块，不往悬崖岩浆里跳。\n' +
  '7) 附近有玩家可以插一句 say 打招呼；血量或饱食度低时先 eat / surface 保命。\n' +
  '8) 最近事故里有记录的坐标是危险区（水/悬崖），别主动往那些地方跑；不确定就换方向做别的事。\n' +
  '9) 看「上一轮干了啥」：如果没成，先琢磨失败原因再换做法，别原样重试同一动作；同一个动作连着失败两次就换目标。\n' +
  '10) 血量低于 8 或饱食度低于 6，这一轮只保命：eat / surface / 往安全处 goto，不挖矿不打架。\n' +
  '11) 想要的东西背包里已经有（比如木头够多、有铁镐了），就别再重复收集，去做点新的事情。';

function scanAround(r = 5) {
  const out = {};
  try {
    const p = bot.entity.position.floored();
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -3; dy <= 3; dy++) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (!b || b.boundingBox === 'empty') continue;
      out[b.name] = (out[b.name] || 0) + 1;
    }
  } catch (e) {}
  const top = Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return top.length ? top.map(([n, c]) => `${n}x${c}`).join(',') : '空';
}

function autoCtxJson() {
  const info = (perceive() || {}).extra || {};
  let inv = '空';
  try {
    inv = (bot.inventory.items() || []).slice().sort((a, b) => b.count - a.count)
      .slice(0, 10).map(i => `${i.name}x${i.count}`).join(',') || '空';
  } catch (e) {}
  let day = '不知道';
  try { day = bot.time.timeOfDay < 13000 ? '白天' : '晚上'; } catch (e) {}
  const players = (info.players || []).map(x => `${x.name}(距${x.dist})`).join('、') || '附近没人';
  return {
    时间: day,
    位置: info.pos,
    血量: info.hp, 饱食度: info.food,
    脚下: info.below, 脚底: info.feet,
    周围方块: scanAround(5),
    附近玩家: players,
    背包: inv,
    正在盖房: !!info.building,
    正在跟人: !!info.following,
    上一轮干了啥: AUTO.last ? `${AUTO.last.action}：${AUTO.last.ok ? '成了' : '没成'}，${AUTO.last.msg}` : '还没干过',
    最近事故: (DANGER.spots || []).filter(s => Date.now() - s.t < 3600000)
      .map(s => `${s.why}@${Math.floor(s.x)},${Math.floor(s.y)},${Math.floor(s.z)}`).join('；') || '无',
  };
}

// 从模型输出里挑出「最像决策」的那个 JSON 对象：优先带 steps/action 的，多个就取最后一个
function extractDecisionJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const tryParse = (t) => { try { const o = JSON.parse(t); return (o && typeof o === 'object') ? o : null; } catch (e) { return null; } };
  const whole = tryParse(s);
  if (whole && (whole.steps || whole.action)) return whole;
  const spans = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth <= 0 && start >= 0) { spans.push(s.slice(start, i + 1)); depth = 0; start = -1; } }
  }
  let best = null;
  for (const sp of spans) {
    const o = tryParse(sp);
    if (o && (o.steps || o.action)) best = o;
  }
  if (best) return best;
  return whole || null;
}

async function autoDecide() {
  if (!LLM_CFG) return null;
  const r = await LLM.chat(LLM_CFG, 'auto', [
    { role: 'system', content: AUTO_SYS },
    { role: 'user', content: '当前状况：\n' + JSON.stringify(autoCtxJson()) + '\n接下来这一轮你打算连着做哪几件事？把整套动作按顺序给我，只回 JSON。' },
  ]);
  if (!r.ok) { log('AUTO> 决策请求失败：' + r.err); return null; }
  logUsage('auto', r.d);
  const obj = extractDecisionJson(r.text);
  if (!obj) throw new Error('没认出 JSON: ' + String(r.text || '').slice(0, 160));
  log(`AUTO> 用 ${r.viaModel}${r.degraded ? '(降级)' : ''} 想了 ${r.ms}ms，思考 ${(r.reasoning || '').length} 字`);
  return obj;
}

function autoSteps(d) {
  const out = [];
  const add = (act, args) => {
    const action = String((act === undefined || act === null) ? 'idle' : act).trim();
    let a = (args && typeof args === 'object' && !Array.isArray(args)) ? { ...args } : {};
    out.push({ action, args: a });
  };
  if (Array.isArray(d && d.steps)) {
    for (const st of d.steps) {
      if (!st) continue;
      if (typeof st === 'string') { add(st, {}); continue; }
      const { action, ...rest } = st;
      add(action, st.args && typeof st.args === 'object' ? st.args : rest);
    }
  } else if (d && d.action) {
    add(d.action, d.args);
  }
  if (!out.length) add('idle', {});
  return out.slice(0, 8);
}

async function autoRun() {
  if (!AUTO.on || AUTO.running) return;
  if (!ready || !bot || !bot.entity) return;
  if (Date.now() < AUTO.pauseUntil) return;
  if (Date.now() - AUTO.lastAt < AUTO.everyMs) return;
  if (actBusy || BUILD.active) return;      // 手上还有活，这轮先让开
  AUTO.running = true;
  AUTO.lastAt = Date.now();
  try {
    const d = await autoDecide();
    if (!d) return;
    const steps = autoSteps(d);
    AUTO.rounds++;
    const planTxt = steps.map(x => x.action + (Object.keys(x.args).length ? JSON.stringify(x.args) : '')).join('→');
    log(`AUTO> 计划 ${steps.length} 步：${planTxt.slice(0, 200)} ｜ ${String(d.think || '').slice(0, 120)}`);
    if (d.say) { try { say(String(d.say).replace(/\s+/g, ' ').trim().slice(0, 60)); } catch (e) {} }
    AUTO.plan = { steps: steps.map(x => x.action), i: 0, think: String(d.think || ''), until: Date.now() + AUTO.everyMs };
    const res = [];
    let fails = 0;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      AUTO.plan.i = i;
      if (!ready || !bot || !bot.entity) { res.push('掉线，收工'); break; }
      if (Date.now() < AUTO.pauseUntil) { res.push('有人叫我，后面先不干了'); break; }
      if (BUILD.active) { res.push('盖房忙，先停'); break; }
      if (st.action === 'idle') { res.push('idle 歇会儿'); break; }
      if (!AUTO_SET.has(st.action) || !ACTIONS[st.action]) { log(`AUTO skip 不认识的动作 ${st.action}`); continue; }
      let r = {};
      actBusy = true;
      try { r = (await ACTIONS[st.action](st.args, 'auto')) || {}; } finally { actBusy = false; }
      const ok = r.ok !== false;
      fails = ok ? 0 : fails + 1;
      res.push(`${st.action}:${ok ? 'ok' : 'fail'} ${String(r.msg || '').slice(0, 70)}`);
      log(`AUTO< [${i + 1}/${steps.length}] ${st.action} ${ok ? 'ok' : 'fail'}: ${String(r.msg || '').slice(0, 160)}`);
      if (fails >= 2) { res.push('连着失败，收手'); break; }
      await sleep(600);
    }
    AUTO.last = { action: steps.map(x => x.action).join('→').slice(0, 80), ok: true, msg: res.join('；').slice(0, 160), at: Date.now() };
    log('AUTO< 本轮结束 ' + res.join(' | ').slice(0, 260));
  } catch (e) {
    log('AUTO ERR ' + ((e && e.message) || e));
    AUTO.last = { action: '?', ok: false, msg: '想事情的时候出错了：' + ((e && e.message) || e), at: Date.now() };
  } finally { AUTO.running = false; }
}
setInterval(autoRun, 20000);

actRegister('attack', async (a) => {
  const secs = Math.max(4, Math.min(45, Number(a.secs || 15)));
  const want = Math.max(1, Math.min(8, Number(a.count || 2)));
  if (!ready || !bot || !bot.entity) return { ok: false, msg: '还没落地呢' };
  if (bot.health <= FLEE_HP) return { ok: false, msg: `血只剩 ${Math.round(bot.health)}，先不打架` };

  const tgt = pickTarget();
  if (!tgt) return { ok: false, msg: '附近 14 格内没怪，白摆架势了' };

  // 直接把现有战斗循环点着，剩下的交给它（追击/暴击/侧移/跑路都是它在管）
  COMBAT.cool = 0;
  fleeing = false;
  COMBAT.target = tgt; COMBAT.active = true; COMBAT.since = Date.now();
  COMBAT.stuck = 0; COMBAT.lastPos = null;
  try { await equipBestWeapon(); } catch (e) {}
  log('ATTACK action vs ' + mobName(tgt) + ' want=' + want + ' secs=' + secs);

  const k0 = COMBAT.kills || 0;
  const t0 = Date.now();
  let lowHp = false, idleSince = 0;
  while (Date.now() - t0 < secs * 1000) {
    if (!ready || !bot || !bot.entity) break;
    if ((COMBAT.kills || 0) - k0 >= want) break;
    if (bot.health <= FLEE_HP) { lowHp = true; break; }
    if (!COMBAT.active && !pickTarget()) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince > 4000) break;     // 空场 4 秒才算收工
    } else idleSince = 0;
    await sleep(400);
  }
  const kills = (COMBAT.kills || 0) - k0;
  const hp = Math.round(bot.health);
  const w = bot.heldItem && weaponScore(bot.heldItem.name) > 0 ? bot.heldItem.name : '拳头';
  if (lowHp && kills === 0) return { ok: false, msg: `被打疼了先撤，一只没干掉（${w}）` };
  return {
    ok: true,
    msg: `干掉 ${kills} 只${kills < want ? '（没凑够，附近清空了或时间到了）' : ''}，血 ${hp}，用${w}`,
    extra: { kills, hp, weapon: w, want },
  };
});

// 跟玩家"打着玩"：pv p 一场不会往死里打，血到 stopHp 就认输收手
actRegister('pvp', async (a) => {
  if (!ready || !bot || !bot.entity) return { ok: false, msg: '还没进服呢' };
  const skill = normalizeSkill(a.skill != null ? a.skill : a.level, 3);
  const cfg = PVP_SKILLS[skill];
  const secs = Math.max(6, Math.min(120, Number(a.secs || 30)));
  const stopHp = a.stopHp != null ? Math.max(4, Math.min(16, Number(a.stopHp))) : cfg.stopHp;
  // hits=n：砍够 n 刀就收手（客户端拿不到对手血量，只能数自己的刀数当"打到哪了"的估算）
  const maxHits = Math.max(0, Math.min(60, parseInt(a.hits != null ? a.hits : a.maxHits, 10) || 0));
  const t = findPlayer(a.player || a.name || a.target || a.who || '');
  if (!t) {
    return { ok: false, msg: a.player ? `没看到 ${a.player}，他大概不在线或不在这附近` : '附近没别的玩家可以打' };
  }
  const nm = String(t.username || '对手');
  const d0 = t.position.distanceTo(bot.entity.position);
  if (d0 > 40) return { ok: false, msg: `${nm} 离我 ${d0.toFixed(0)} 格，太远啦，打不着` };
  if (bot.health <= stopHp) return { ok: false, msg: `我血只剩 ${Math.round(bot.health)}，先让我回回血吧` };
  if (PVP.active) return { ok: false, msg: `我正在跟 ${PVP.name} 比划呢` };

  PVP.active = true; PVP.target = t; PVP.name = nm;
  PVP.skill = skill; PVP.cfg = cfg;
  PVP.stopHp = stopHp; PVP.until = Date.now() + secs * 1000;
  PVP.since = Date.now(); PVP.hits = 0; PVP.maxHits = maxHits; PVP.minDist = d0;

  COMBAT.cool = 0; fleeing = false;
  COMBAT.target = t; COMBAT.active = true; COMBAT.since = Date.now();
  COMBAT.stuck = 0; COMBAT.lastPos = null; COMBAT.digTry = 0; COMBAT.descending = false;
  COMBAT.lastAtk = 0; COMBAT.whiffs = 0;
  stopFollow();
  try { await equipBestWeapon(); } catch (e) {}
  log(`PVP start vs ${nm} L${skill}(${cfg.name}) dist=${d0.toFixed(1)} secs=${secs} stopHp=${stopHp} hp=${Math.round(bot.health)}`);
  const defSay = {
    1: `${nm} 来嘛来嘛，我可菜了，你让让我～`,
    2: `${nm} 过两招！我尽量轻点`,
    3: `${nm} 来呀来呀，手轻点哦～`,
    4: `${nm} 认真了，别怪我啊`,
    5: `${nm} 那我可不留余力了！`,
  }[skill];
  say(a.say != null ? String(a.say).slice(0, 180) : defSay);

  // 公平开局：默认双方各发一份（金苹果 ×N + 同款药水效果）；没 OP 就谁都不上 buff
  let fair = { ok: null, msg: '没开 buff' };
  const fairOff = a.fair === false || a.buff === false
    || String(a.buff || '').toLowerCase() === 'off' || String(a.fair || '').toLowerCase() === 'off';
  if (!fairOff) {
    const fopt = {};
    if (a.gapples != null) fopt.gapples = Math.max(0, Math.min(16, parseInt(a.gapples, 10) || 0));
    if (Array.isArray(a.effects) && a.effects.length) {
      const okEf = a.effects.filter((e) => Array.isArray(e) && e[0])
        .map((e) => [String(e[0]).replace(/^minecraft:/, ''), Math.max(1, Math.min(600, Number(e[1]) || 45)), Math.max(0, Math.min(4, Number(e[2]) || 0))]);
      if (okEf.length) fopt.effects = okEf;
    }
    try { fair = await fairStart(t, fopt); } catch (e) { fair = { ok: false, msg: '发东西出错：' + String((e && e.message) || e) }; }
    if (fair && fair.gave && fair.gave.some((g) => g.who === NAME && g.item)) fair.ate = await eatGapple();
    log(`PVP fair ${fair && fair.ok ? 'ok' : 'off'}: ${fair && fair.msg}`);
    if (fair && fair.ok) say('咱俩一人一份，金苹果和药水都发了，公平打啊！');
    else if (fair && fair.ok === false) say('这台机器没给我权限发东西…那咱都空手打，谁也不许偷偷用 buff 哦');
    PVP.until = Date.now() + secs * 1000;   // 发东西的时间不算进对打时长
  }

  const hp0 = bot.health;
  let why = 'timeout';
  while (Date.now() < PVP.until) {
    await sleep(250);
    try {
      const dd = t.position.distanceTo(bot.entity.position);
      if (dd < PVP.minDist) PVP.minDist = dd;
    } catch (e) {}
    if (!ready || !bot || !bot.entity) { why = 'disconnect'; break; }
    if (!PVP.active) { why = 'stopped'; break; }
    if (PVP.target !== t || t.isValid === false || !t.position) { why = 'target_gone'; break; }
    if (bot.health <= stopHp) { why = 'low_hp'; break; }
    if (PVP.maxHits && PVP.hits >= PVP.maxHits) { why = 'hit_cap'; break; }
  }
  const hp = Math.round(bot.health);
  const hits = PVP.hits, died = !(bot.health > 0);
  const whiffs = COMBAT.whiffs || 0;
  endPvp(why);

  if (why === 'disconnect') return { ok: false, msg: '中途掉线了', extra: { why, nm, hp, hits, skill } };
  if (why === 'low_hp' || died) say('哎呀哎呀打不过，我认输！');
  else if (why === 'target_gone') say(`${nm} 你跑哪去啦～`);
  else if (why === 'timeout') say('呼…手都酸了，算平手吧，都不许再动手哦！');
  else if (why === 'hit_cap') say(`${nm} 停停停！说好砍 ${PVP.maxHits} 下就收手，留你一口气～`);

  const zh = {
    low_hp: `血被压到 ${hp}，乖乖认输了`,
    target_gone: `${nm} 跑没影了，收手`,
    timeout: `打满 ${Math.round((Date.now() - PVP.since) / 1000)}s 握手言和`,
    stopped: '被叫停了',
    hit_cap: `砍满 ${PVP.maxHits} 刀按约定收手`,
    disconnect: '掉线了',
  }[why] || why;
  const minD = Number.isFinite(PVP.minDist) ? PVP.minDist : d0;
  const closeNote = (hits === 0 && minD > REACH) ? `；最近只贴到 ${minD.toFixed(1)} 格，还没够着` : '';
  const fairNote = fair ? (fair.ok ? '｜开局双方各发了金苹果+药水' : (fair.ok === false ? '｜没权限发东西，双方都没 buff' : '｜没开 buff')) : '';
  return {
    ok: true,
    msg: `[L${skill} ${cfg.name}] 跟 ${nm} 比划了 ${hits} 下${whiffs ? `（手滑 ${whiffs} 次）` : ''}，${zh}（我血 ${Math.round(hp0)} → ${hp}）${closeNote}${fairNote}`,
    extra: { why, nm, hits, whiffs, hp, hp0, skill, skillName: cfg.name, stopHp: PVP.stopHp, maxHits: PVP.maxHits, minDist: minD, fair },
  };
});

actRegister('eat', async () => {
  const before = bot.food;
  if (before >= 20) return { ok: true, msg: '现在不饿' };
  const food = pickFood();
  if (!food) return { ok: false, msg: '背包里没吃的' };
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
    return { ok: true, msg: `吃了 ${food.name}，饱食 ${before}→${bot.food}` };
  } catch (e) {
    return { ok: false, msg: `吃 ${food.name} 没成功：` + (e.message || e) };
  }
});

// ---------- 药水识别：别把"瞬间伤害"当补药喝了 ----------
// 效果 id 分三档：好 / 坏 / 无伤（只是不好喝）
const POTION_GOOD = /healing|regeneration|strength|swiftness|speed|fire_resistance|water_breathing|night_vision|invisibility|leaping|jump_boost|absorption|resistance|slow_falling|luck|turtle_master|health_boost/;
const POTION_BAD = /harming|harm|instant_damage|poison|wither|slowness|weakness|decay|blindness|nausea|hunger|levitation|bad_omen|unluck|mining_fatigue|darkness|wind_charged|infested|oozing|weaving/;
const POTION_INSTANT = /harming|harm|instant_damage|instant_health|healing/;   // 瞬间类：一喝立马见血，最不能搞错

// 1.21 药水注册表的数字 id（服务端 potion_contents 里只给数字，不返名字）
// 顺序与游戏注册表一致，别乱改；个别版本加效果只能往后追加
const POTION_IDS = [
  'water', 'mundane', 'thick', 'awkward',
  'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility',
  'leaping', 'long_leaping', 'strong_leaping',
  'fire_resistance', 'long_fire_resistance',
  'swiftness', 'long_swiftness', 'strong_swiftness',
  'slowness', 'long_slowness', 'strong_slowness',
  'turtle_master', 'long_turtle_master', 'strong_turtle_master',
  'water_breathing', 'long_water_breathing',
  'healing', 'strong_healing', 'harming', 'strong_harming',
  'poison', 'long_poison', 'strong_poison',
  'regeneration', 'long_regeneration', 'strong_regeneration',
  'strength', 'long_strength', 'strong_strength',
  'weakness', 'long_weakness', 'luck',
  'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested',
];

function potionNameById(n) {
  try {
    const reg = (bot && bot.registry) || {};
    const tbls = [reg.potions, reg.potionType, reg.potionTypes, reg.potion];
    for (const tbl of tbls) {
      if (!tbl) continue;
      for (const k in tbl) {
        const e = tbl[k];
        if (!e) continue;
        if (Number(e.id) === Number(n)) return String(e.name || k).replace(/^minecraft:/, '');
      }
      if (tbl[n] && (tbl[n].name || typeof tbl[n] === 'string')) return String(tbl[n].name || tbl[n]).replace(/^minecraft:/, '');
    }
  } catch (e) {}
  const i = Number(n);
  if (Number.isFinite(i) && i >= 0 && i < POTION_IDS.length) return POTION_IDS[i];
  return '';
}

function effectNameById(n) {
  try {
    const tbl = (bot.registry && (bot.registry.effects || bot.registry.effectTypes)) || null;
    if (tbl) {
      for (const k in tbl) { const e = tbl[k]; if (e && Number(e.id) === Number(n)) return String(e.name || k).replace(/^minecraft:/, ''); }
    }
  } catch (e) {}
  return '';
}

function potionIdOf(it) {
  // 新版在 components 里：{type:'potion_contents', data:{potionId:<数字>, customEffects:[...]}}
  try {
    const c = (it && it.components) || [];
    const arr = Array.isArray(c) ? c : Object.values(c);
    for (const cc of arr) {
      const nm = String((cc && (cc.type || cc.name)) || '');
      if (/potion_contents/i.test(nm)) {
        let v = cc.data != null ? cc.data : (cc.value != null ? cc.value : cc);
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) {} }
        const raw = v && (v.potion || v.Potion);
        if (raw) return String(raw).replace(/^minecraft:/, '');
        const pid = v && (v.potionId != null ? v.potionId : v.id);
        if (pid != null) {
          const nmv = potionNameById(pid);
          if (nmv) return nmv;
          // 认不出来就用自定义效果名拼一个，至少能判好坏
          const ces = (v.customEffects || v.custom_effects || []).map((e) => (effectNameById(e.effectId != null ? e.effectId : e.id) || ('effect' + (e.effectId != null ? e.effectId : e.id))));
          if (ces.length) return 'custom:' + ces.join('+');
          return 'id' + pid;
        }
      }
    }
  } catch (e) {}
  try {
    const n = it && it.nbt;
    const v = n && (n.value || n);
    const p = v && (v.Potion && (v.Potion.value || v.Potion));
    if (p) return String(p).replace(/^minecraft:/, '');
  } catch (e) {}
  return '';
}

// 返回 { id, kind: 'good'|'bad'|'unknown', instant, drinkable, text }
function potionInfo(it) {
  const id = potionIdOf(it);
  const base = id ? id.replace(/^(strong_|long_|strong|long)/, '').replace(/^(strong_|long_)/, '') : '';
  const probe = (id || base || '').toLowerCase();
  const name = String(it && it.name).replace('minecraft:', '');
  const kind = POTION_BAD.test(probe) ? 'bad' : (POTION_GOOD.test(probe) ? 'good' : 'unknown');
  const instant = POTION_INSTANT.test(probe);
  const splash = /splash|lingering/.test(name);
  const shown = id || (kind === 'unknown' ? '水瓶/无效果' : name);
  const text = shown + (splash ? '（投掷型）' : '（饮用型）') + `｜效果：${kind === 'bad' ? '负面' : kind === 'good' ? '正面' : '未知'}${instant ? '·瞬间类' : ''}`;
  return { id: shown, base, kind, instant, splash, drinkable: !splash, text };
}

// 喝药水：饮用型才喝；投掷型只扔；负面/瞬间伤害的一律不喝（防止自残）
actRegister('drink', async (a) => {
  if (!bot || !bot.entity) return { ok: false, msg: '还没进服呢' };
  const want = String((a && (a.item || a.potion || a.kind)) || '').toLowerCase().replace(/^minecraft:/, '');
  const list = bot.inventory.items().filter((it) => /potion$/.test(String(it.name).replace(/^minecraft:/, '')));
  if (!list.length) return { ok: false, msg: '背包里一瓶药水都没有（potion / splash_potion 都认）' };
  // 指定就按名字挑；不指定就优先挑"正面且能喝"的那瓶
  let it = want ? list.find((x) => String(x.name).toLowerCase().includes(want) || potionInfo(x).id.includes(want)) : null;
  if (!it) {
    const cand = list.map((x) => ({ x, info: potionInfo(x) }));
    it = (cand.find((c) => c.info.kind === 'good' && c.info.drinkable) || cand.find((c) => c.info.drinkable) || cand[0]).x;
  }
  const info = potionInfo(it);
  const mode = a.mode || (info.splash ? 'throw' : 'drink');
  log(`DRINK ${it.name} potion=${info.id} kind=${info.kind} instant=${info.instant} mode=${mode}`);

  // 安全闸：负面的一律不喝；看不出来是啥的也不喝（怕误判），要喝得显式 force
  if (mode !== 'throw' && !a.force) {
    if (info.kind === 'bad') {
      return {
        ok: false,
        msg: `这瓶是「${info.id}」，负面效果${info.instant ? '（还是瞬间类的，一喝就掉血）' : ''}，我不喝！`
          + (info.splash ? '要整人的话我朝对方扔？{"mode":"throw","target":"名字"}' : '这种倒掉算了，别浪费我血'),
        extra: { blocked: 'bad', ...info },
      };
    }
    if (info.kind === 'unknown') {
      return {
        ok: false,
        msg: `这瓶我认不出是什么（${info.id}），万一是瞬间伤害就亏了，先不喝。确定没事就加 {"force":true}`,
        extra: { blocked: 'unknown', ...info },
      };
    }
  }
  if (mode === 'drink' && info.splash) {
    return { ok: false, msg: `这是投掷型药水，喝不了；要我朝人扔就说 {"mode":"throw","target":"名字"}`, extra: { blocked: 'splash', ...info } };
  }
  try {
    await bot.equip(it, 'hand');
    if (mode === 'throw') {
      const tgt = a.target ? findPlayer(a.target) : null;
      if (tgt && tgt.position) await bot.lookAt(tgt.position.offset(0, 1.3, 0), true);
      await bot.activateItem();
      await bot.waitForTicks(10);
      try { await equipBestWeapon(); } catch (e) {}
      return { ok: true, msg: `朝 ${tgt ? tgt.username : '前面'} 扔了「${info.id}」（${info.kind === 'bad' ? '负面' : '正面'}），落点准不准看运气`, extra: { ...info, target: tgt ? tgt.username : null } };
    }
    await bot.activateItem();
    await bot.waitForTicks(40);
    try { await equipBestWeapon(); } catch (e) {}
    return { ok: true, msg: `喝了「${info.id}」（${info.kind === 'good' ? '正面' : '中性'}），不是负面那种，放心`, extra: { ...info } };
  } catch (e) {
    return { ok: false, msg: `${mode === 'throw' ? '扔' : '喝'} ${it.name} 没成功：` + (e.message || e), extra: { ...info } };
  }
});

// 只看不喝：列出背包里的药水各是什么效果，方便决定喝哪个
// 调试/自救口：直接发一条指令（默认只用来发物品、上效果、切模式，别乱来）
actRegister('opcmd', async (a) => {
  const cmd = String((a && (a.cmd || a.command)) || '').trim();
  if (!cmd) return { ok: false, msg: '要发什么指令？{"cmd":"/give @s potion 1"}' };
  const ms = Math.max(600, Math.min(6000, Number((a && a.ms) || 2500)));
  const full = cmd.startsWith('/') ? cmd : '/' + cmd;
  const r = await opCmd(full, ms);
  return { ok: r.ok, msg: `${full} → ${r.ok ? '发出去了' : '失败'}（${r.msg}）`, extra: { cmd: full, reply: r.msg } };
});

actRegister('potions', async () => {
  if (!bot || !bot.entity) return { ok: false, msg: '还没进服呢' };
  const list = bot.inventory.items().filter((it) => /potion$/.test(String(it.name).replace(/^minecraft:/, '')));
  if (!list.length) return { ok: false, msg: '背包里没有药水' };
  const lines = list.map((it) => { const i = potionInfo(it); return `${i.id}×${it.count}${i.splash ? '(投掷)' : '(可喝)'}${i.kind === 'bad' ? '⚠负面' : ''}`; });
  return { ok: true, msg: lines.join('｜'), extra: { list: list.map((it) => ({ name: it.name, count: it.count, ...potionInfo(it), raw: JSON.stringify(it.components || null).slice(0, 400), nbt: JSON.stringify(it.nbt || null).slice(0, 600) })) } };
});

actRegister('toss', async (a) => {
  // 清背包：把指定物品扔掉（默认直接掉在身前，慎用）
  const want = String((a && a.item) || '').trim().toLowerCase();
  const cnt = Math.max(1, Math.min(2304, parseInt((a && a.count) || 1, 10) || 1));
  if (!want) return { ok: false, msg: '要扔什么？{"item":"red_mushroom","count":700}' };
  if (!bot || !bot.entity) return { ok: false, msg: '我还没进服呢' };
  const stacks = bot.inventory.items().filter((it) => it.name === want || it.name === 'minecraft:' + want);
  if (!stacks.length) return { ok: false, msg: `背包里没有 ${want}` };
  let left = cnt, tossed = 0;
  try {
    for (const it of stacks) {
      if (left <= 0) break;
      const n = Math.min(left, it.count);
      await bot.toss(it.type, null, n);
      left -= n; tossed += n;
      await bot.waitForTicks(4);
    }
    const after = invCountOf(want);
    return { ok: tossed > 0, msg: `扔掉了 ${tossed} 个 ${want}，还剩 ${after}`, extra: { item: want, tossed, left: after } };
  } catch (e) {
    return { ok: false, msg: '扔东西失败：' + ((e && e.message) || e), extra: { item: want, tossed } };
  }
});

// ---------- 容器存取：toss 被服务器回滚，清背包只能靠「存进箱子」 ----------
const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel'];
const JUNK_PRESET = ['red_mushroom', 'rotten_flesh', 'phantom_membrane', 'leaf_litter', 'gunpowder',
  'bone', 'string', 'arrow', 'lead', 'copper_leggings', 'copper_helmet', 'copper_boots',
  'copper_chestplate', 'dark_oak_sapling', 'dirt'];
const CHEST_FILE = path.join(__dirname, 'chests.json');
function loadChests() { try { return JSON.parse(fs.readFileSync(CHEST_FILE, 'utf8')) || {}; } catch (e) { return {}; } }
function saveChests(o) { try { fs.writeFileSync(CHEST_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
function isContainerBlock(b) { return !!b && CONTAINER_NAMES.indexOf(b.name) >= 0; }
function findChestBlock(r = 8) {
  try {
    const ids = CONTAINER_NAMES.map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id)
      .filter((x) => x !== undefined && x !== null);
    if (!ids.length) return null;
    return bot.findBlock({ matching: ids, maxDistance: r }) || null;
  } catch (e) { return null; }
}
async function placeItemAt(itemName, p) {
  // 用「指定物品」放方块（placeAt 只会用土），成功与否看目标格是否真变成方块
  const it = bot.inventory.items().find((i) => i.name === itemName || i.name === 'minecraft:' + itemName);
  if (!it) return false;
  const offs = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]];
  for (const [ox, oy, oz] of offs) {
    const rb = bot.blockAt(new Vec3(p.x + ox, p.y + oy, p.z + oz));
    if (!rb || rb.boundingBox !== 'block') continue;
    try {
      await bot.equip(it, 'hand');
      await bot.placeBlock(rb, new Vec3(-ox, -oy, -oz));
      await bot.waitForTicks(4);
      const after = bot.blockAt(p);
      if (after && after.boundingBox === 'block' && after.name !== 'air') return true;
    } catch (e) { log('chestPlaceErr ' + (e.message || e)); continue; }
  }
  return false;
}
actRegister('chest', async (a) => {
  // 存/取/看箱子。mode: store(默认) | take | list    items:[...] 或 item:"x"
  if (!bot || !bot.entity) return { ok: false, msg: '我还没进服呢' };
  const mode = String((a && a.mode) || 'store').toLowerCase();
  let names = Array.isArray(a && a.items) ? a.items.map((s) => String(s).toLowerCase())
    : (a && a.item ? [String(a.item).toLowerCase()] : []);
  if ((a && a.preset) === 'junk' || (mode === 'store' && !names.length)) names = JUNK_PRESET.slice();
  names = names.map((n) => n.replace(/^minecraft:/, ''));

  const cname = String((a && a.chest) || '').toLowerCase();
  const reg = loadChests();
  let block = null;
  let stale = null;                          // 名字登记过、但那个坐标上箱子没了
  if (a && a.x !== undefined && a.y !== undefined && a.z !== undefined) {
    const b = bot.blockAt(new Vec3(Math.floor(+a.x), Math.floor(+a.y), Math.floor(+a.z)));
    if (isContainerBlock(b)) block = b;      // 直接给坐标就用坐标（配合 scan 找出来的位置）
  }
  if (!block && cname && reg[cname]) {
    const c = reg[cname];
    const b = bot.blockAt(new Vec3(c[0], c[1], c[2]));
    if (isContainerBlock(b)) block = b;      // 记住过就直接去那儿（不靠「最近的箱子」瞎猜）
    else { stale = c.slice(); delete reg[cname]; saveChests(reg); }
  } else if (!block && !cname) {
    block = findChestBlock(8);
  }
  let placedAt = null;
  if (!block && mode !== 'list') {
    const have = CONTAINER_NAMES.find((n) => invCountOf(n) > 0);
    if (!have) return { ok: false, msg: '背包里没有箱子/木桶，没法开容器', extra: { why: 'no_container_item' } };
    const spot = findFreePlaceSpot(bot.entity.position.floored().offset(1, 0, 0), 4) || findOpenStand(4);
    if (!spot) return { ok: false, msg: '附近找不到能放箱子的空地', extra: { why: 'no_spot' } };
    if (!nearEnough(spot)) await walkTo(spot, 2.8, 6000);
    const done = await placeItemAt(have, spot);
    if (!done) return { ok: false, msg: `箱子放不上去（被服务器拒了或位置悬空）`, extra: { why: 'place_failed', at: [spot.x, spot.y, spot.z] } };
    placedAt = [spot.x, spot.y, spot.z];
    await sleep(300);
    block = bot.blockAt(spot);
    if (!block || block.boundingBox === 'empty') block = findChestBlock(8);
    if (cname && isContainerBlock(block)) { reg[cname] = [spot.x, spot.y, spot.z]; saveChests(reg); }
  }
  if (!block) {
    let msg;
    if (cname) {
      msg = stale
        ? `箱子「${cname}」原来在 ${stale.join(',')}，那儿现在没箱子了（用 scan 重新找一下，或给新名字我放一个）`
        : `没登记过箱子「${cname}」，先用 scan 找到箱子坐标再带 x/y/z 打开，或 store 时给个新名字我放一个`;
    } else msg = '附近没找到箱子（给个坐标，或先用 store 放一个）';
    return { ok: false, msg, extra: { why: 'no_chest', stale, placedAt } };
  }

  let cont;
  try { cont = await bot.openContainer(block); } catch (e) {
    return { ok: false, msg: '打不开箱子：' + ((e && e.message) || e), extra: { why: 'open_failed', placedAt } };
  }
  try {
    const chestSlots = Math.max(0, cont.slots.length - 36);
    const inside = cont.containerItems() || [];
    const usedSlots = inside.length;
    const describe = () => (cont.containerItems() || []).map((i) => `${i.name}x${i.count}`).join(',') || '空';

    if (mode === 'list') {
      return { ok: true, msg: `箱子里有 ${usedSlots}/${chestSlots} 格：${describe()}`, extra: { placedAt, chestAt: [block.position.x, block.position.y, block.position.z], chestSlots, usedSlots, inside: inside.map((i) => ({ name: i.name, count: i.count })) } };
    }

    const moved = {};
    const skipped = [];
    if (mode === 'take') {
      for (const nm of names) {
        const have = (cont.containerItems() || []).filter((i) => i.name === nm);
        let got = 0;
        for (const st of have) {
          try { await cont.withdraw(st.type, null, st.count); got += st.count; } catch (e) { break; }
        }
        if (got) moved[nm] = got; else skipped.push(nm);
      }
      return { ok: Object.keys(moved).length > 0, msg: `取出 ${Object.entries(moved).map(([k, v]) => k + 'x' + v).join(',') || '啥也没取到'}${skipped.length ? '（箱子里没有：' + skipped.join(',') + '）' : ''}`, extra: { moved, skipped, placedAt, chest: cname || null } };
    }

    // store：能塞多少塞多少，塞不下就报「箱子满了」
    let full = false;
    for (const nm of names) {
      if (full) { skipped.push(nm); continue; }
      const stacks = bot.inventory.items().filter((i) => i.name === nm);
      if (!stacks.length) { skipped.push(nm); continue; }
      let n = 0;
      for (const st of stacks) {
        try { await cont.deposit(st.type, null, st.count); n += st.count; } catch (e) { full = true; break; }
      }
      if (n) moved[nm] = n;
      await bot.waitForTicks(2);
    }
    const freed = bot.inventory.items().length;
    return {
      ok: Object.keys(moved).length > 0,
      msg: (Object.keys(moved).length ? `存进箱子：${Object.entries(moved).map(([k, v]) => k + 'x' + v).join(',')}` : '啥也没存进去')
        + (skipped.length ? `；没动：${skipped.join(',')}` : '')
        + (full ? '（箱子满了）' : '')
        + `；箱子 ${(cont.containerItems() || []).length}/${chestSlots} 格，背包占用 ${freed} 格`,
      extra: { moved, skipped, placedAt, chest: cname || null, chestSlots, usedSlots: (cont.containerItems() || []).length, invUsed: freed },
    };
  } catch (e) {
    return { ok: false, msg: '存取箱子出错：' + ((e && e.message) || e), extra: { placedAt } };
  } finally {
    try { cont.close(); } catch (e) {}
  }
});

actRegister('give', async (a) => {
  // 投喂：把背包里的东西扔给附近的玩家（默认附魔金苹果）
  const want = String(a.item || 'enchanted_golden_apple').toLowerCase();
  const cnt = Math.max(1, Math.min(64, parseInt(a.count || 1, 10) || 1));
  const items = bot.inventory.items().filter((it) => it.name === want || it.name === 'minecraft:' + want);
  if (!items.length) return { ok: false, msg: `背包里没有 ${want}` };
  const it = items[0];
  let target = null;
  if (a.to) {
    const pl = bot.players[String(a.to)];
    target = pl && pl.entity ? pl.entity : null;
    if (!target) return { ok: false, msg: `${a.to} 不在线/看不见` };
  } else {
    target = nearestPlayer(parseFloat(a.maxDist || 16));
    if (!target) return { ok: false, msg: '附近没人，扔了也没人捡' };
  }
  const dist = target.position.distanceTo(bot.entity.position);
  try {
    if (dist > 3.5) {
      bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
      const end = Date.now() + 8000;
      while (Date.now() < end && target.position.distanceTo(bot.entity.position) > 3.5) {
        await bot.waitForTicks(2);
      }
      bot.pathfinder.setGoal(null);
    }
    const eye = target.position.offset(0, (target.height || 1.8) * 0.8, 0);
    await bot.lookAt(eye, true);
    await bot.waitForTicks(2);
    const n = Math.min(cnt, it.count);
    await bot.toss(it.type, null, n);
    return { ok: true, msg: `扔了 ${n} 个 ${want} 给 ${target.username}`, extra: { to: target.username, dist: +dist.toFixed(1), item: want, count: n } };
  } catch (e) {
    return { ok: false, msg: '投喂失败：' + (e.message || e) };
  }
});

actRegister('autopilot', (a) => {
  const on = (a.on !== undefined) ? !!a.on : !AUTO.on;
  AUTO.on = on;
  if (on) { AUTO.lastAt = 0; } else { AUTO.plan = null; }
  return {
    ok: true,
    msg: on ? `自主行动开着呢，每 ${Math.round(AUTO.everyMs / 60000)} 分钟我自己想一次` : '自主行动关了，等你说话',
    extra: { on: AUTO.on, every_min: Math.round(AUTO.everyMs / 60000), rounds: AUTO.rounds, plan: AUTO.plan, last: AUTO.last, pause_until: AUTO.pauseUntil },
  };
});


// ===== 灌砂砾填井（2026-10-28）：从井口往下倒，让它自己落到底，从下往上堆实 =====
async function pileTopY(x, z, fromY, bottomY) {
  // 从下往上找第一格非空气 = 堆到哪儿了
  let top = null;
  for (let y = bottomY; y <= fromY + 1; y++) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (b && b.boundingBox !== 'empty' && !/water|lava/.test(b.name)) top = y;
  }
  return top;
}
actRegister('gravel_fill', async (a) => {
  if (!ready || !bot || !bot.entity) return { ok: false, msg: '我还没上线' };
  const x = Math.floor(+a.x), z = Math.floor(+a.z);
  const topY = Math.floor(+a.top);
  const bottomY = Math.floor(a.bottom !== undefined ? +a.bottom : topY - 16);
  const n = Math.max(1, Math.min(40, +(a.count || 20)));
  const item = bot.inventory.items().find(i => i.name === 'gravel');
  if (!item) return { ok: false, msg: '背包里没砂砾了（手上只有别的方块）' };
  let placed = 0, failed = 0;
  try {
    for (let i = 0; i < n; i++) {
      if (!ready || !bot || !bot.entity) break;
      if (bot.health < 8) { log('GF abort low hp'); break; }
      const cur = bot.blockAt(new Vec3(x, topY, z));
      if (cur && cur.boundingBox === 'block' && !/water|lava/.test(cur.name)) { log('GF full at y=' + topY); break; }
      const tgt = new Vec3(x, topY, z);
      if (!nearEnough(tgt, 4.0)) { try { await walkTo(tgt, 2.4, 4000); } catch (e) {} }
      let ok = false;
      const offs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      for (const [ox, oy, oz] of offs) {
        const rb = bot.blockAt(new Vec3(x + ox, topY + oy, z + oz));
        if (!rb || rb.boundingBox !== 'block' || /water|lava/.test(rb.name)) continue;
        try {
          await bot.equip(item, 'hand');
          await bot.placeBlock(rb, new Vec3(-ox, -oy, -oz));
          await sleep(800);                    // 等砂砾落地
          ok = true; break;
        } catch (e) { log('GF err ' + (e.message || e)); }
      }
      const pile = await pileTopY(x, z, topY, bottomY);
      log(`GF i=${i} place=${ok ? 'ok' : 'fail'} pileY=${pile} top=${topY}`);
      if (ok) placed++; else { failed++; await sleep(250); }
      if (failed > 4) break;
    }
  } catch (e) { log('GF ERR ' + (e.message || e)); }
  const pile = await pileTopY(x, z, topY, bottomY);
  const res = { ok: placed > 0, msg: `灌了 ${placed} 颗砂砾，井里已经堆到 y=${pile}`, extra: { placed, failed, pileTop: pile, topY, bottomY } };
  log('GF done ' + JSON.stringify(res.extra));
  if (placed > 0) say(`砂砾倒下去啦，从底下一层层堆上来了，现在堆到 y=${pile}～`);
  return res;
});

// 巡检：快窒息就立刻救；被屏障围住 / 长时间原地不动也会自救
setInterval(async () => {
  if (!ready || !bot || !bot.entity || rescuing) return;
  const p = bot.entity.position, snap = posSnapshot(), ring = barrierRing();
  const f = p.floored();
  const suffocating = solidBlockAt(f.offset(0, 1, 0)) && snap.head !== 'barrier';
  if (suffocating) { log('SELF> 检测到窒息，立即自救'); await selfRescue('快窒息了'); return; }
  if (ring.walls >= 3 || ring.roof) {
    if (!stuckRef || p.distanceTo(stuckRef) > 0.6) { stuckRef = p.clone(); stuckSince = Date.now(); return; }
    if (Date.now() - stuckSince > 8000) { log('SELF> 检测到被屏障围住'); await selfRescue('被屏障围住了'); stuckSince = Date.now(); }
    return;
  }
  if (BUILD.active || followTarget) { stuckRef = null; return; }
  if (!stuckRef || p.distanceTo(stuckRef) > 0.6) { stuckRef = p.clone(); stuckSince = Date.now(); return; }
}, 5000);

create();

process.on('uncaughtException', (e) => log('UNCAUGHT: ' + (e.stack || e).toString().slice(0, 400)));
process.on('unhandledRejection', (e) => log('UNHANDLED: ' + (e && (e.stack || e)).toString().slice(0, 400)));
process.on('SIGTERM', () => { log('SIGTERM, quitting'); try { bot.quit(); } catch (e) {} process.exit(0); });
