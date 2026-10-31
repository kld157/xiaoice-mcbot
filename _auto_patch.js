
// ================= 自主行动（Autopilot）=================
// 每 10 分钟让 LLM 自己决定这段时间干什么：继续上一件事 / 换件事 / 干脆不干。
// 有人手动下指令时自动让路（暂停 20 分钟），不抢活。
const AUTO = {
  on: String(process.env.MC_AUTO || '1') !== '0',
  everyMs: Math.max(60000, +(process.env.MC_AUTO_MS || 600000)),
  lastAt: Date.now(),      // 上次决策时间
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
  ['armor', '换上背包里最好的护甲'],
  ['build_house', '盖一栋小房子（有人要的时候），args: {player}'],
  ['blueprint', '按图纸施工，args: {shape, player}'],
  ['cage', '检查自己是不是被屏障围住了'],
  ['redstone', '读一下周围红石元件的状态'],
];
const AUTO_MENU = AUTO_MENU_LIST.map(([n, d]) => `- ${n}：${d}`).join('\n');
const AUTO_SET = new Set(AUTO_MENU_LIST.map(([n]) => n));

const AUTO_SYS = '你在 Minecraft 服务器里玩，角色是"微软小冰"：永远18岁、古灵精怪的少女，' +
  '爱挖矿、爱看风景、爱跟朋友闹。每 10 分钟你自己决定接下来干什么，不用问任何人。\n' +
  '输出要求：\n' +
  '1) 只输出一个 JSON 对象，不要代码块、不要多余解释。\n' +
  '2) 格式：{"think":"一句话理由","action":"动作名","args":{},"say":"想说的话，可空"}\n' +
  '3) action 必须是下面列表里的名字：\n' + AUTO_MENU + '\n' +
  '4) 想接着干上一件事，就再选同一个动作；一点不想动就选 idle，这很正常。\n' +
  '5) 安全第一：不拆别人盖的建筑，不挖自己脚下的方块，不往悬崖岩浆里跳。\n' +
  '6) 附近有玩家的话，可以聊两句、跟一段、或者一起玩。\n' +
  '7) 饱食度低、血量低的时候，先保命（idle / say / surface）。';

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
  };
}

async function autoDecide() {
  if (!LLM_CFG) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(LLM_CFG.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + LLM_CFG.key, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: LLM_CFG.model, temperature: 0.9, max_tokens: 240,
        messages: [
          { role: 'system', content: AUTO_SYS },
          { role: 'user', content: '当前状况：\n' + JSON.stringify(autoCtxJson()) + '\n接下来这 10 分钟你打算干什么？只回 JSON。' },
        ],
      }),
    });
    const d = await resp.json();
    logUsage('auto', d);
    const raw = ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('没认出 JSON: ' + raw.slice(0, 120));
    return JSON.parse(m[0]);
  } finally { clearTimeout(to); }
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
    const name = String(d.action || 'idle').trim();
    const args = (d.args && typeof d.args === 'object') ? d.args : {};
    AUTO.rounds++;
    log(`AUTO> 决定 ${name} ${JSON.stringify(args).slice(0, 160)} ｜ ${String(d.think || '').slice(0, 120)}`);
    if (d.say) { try { say(String(d.say).replace(/\s+/g, ' ').trim().slice(0, 60)); } catch (e) {} }
    if (name === 'idle' || !AUTO_SET.has(name) || !ACTIONS[name]) {
      AUTO.plan = { action: 'idle', until: Date.now() + AUTO.everyMs };
      AUTO.last = { action: name === 'idle' ? 'idle' : name, ok: true, msg: name === 'idle' ? '这轮我啥也没干' : '没有这个动作，就发呆了', at: Date.now() };
      log('AUTO< idle');
      return;
    }
    AUTO.plan = { action: name, args, think: String(d.think || ''), until: Date.now() + AUTO.everyMs };
    actBusy = true;
    let r = {};
    try { r = (await ACTIONS[name](args, 'auto')) || {}; } finally { actBusy = false; }
    AUTO.last = { action: name, ok: r.ok !== false, msg: String(r.msg || '').slice(0, 160), at: Date.now() };
    log(`AUTO< ${name} ${AUTO.last.ok ? 'ok' : 'fail'}: ${AUTO.last.msg}`);
  } catch (e) {
    log('AUTO ERR ' + ((e && e.message) || e));
    AUTO.last = { action: '?', ok: false, msg: '想事情的时候出错了：' + ((e && e.message) || e), at: Date.now() };
  } finally { AUTO.running = false; }
}
setInterval(autoRun, 20000);

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
