'use strict';
/**
 * death.js — 死亡找回：分级判断，不睁眼瞎跑
 *
 * 死了别无脑往回跑。MC 的规则不友好：
 *   - 掉岩浆：物品直接销毁（只有下界合金会浮着），跑回去等于白跑还得搭桥
 *   - 掉虚空：全没了
 *   - 掉落物 5 分钟消失，来不及就是来不及
 *   - 装备爆一地，怪可能还在原地等你
 * 所以先记账（坐标 + 死因 + 身上有什么），再判断值不值得跑，
 * 只有「地面死、跑得回、还来得及」才真的回去。
 *
 * 两层判断：
 *   1. 规则层（0 毫秒）：岩浆/虚空/别的维度/太远/来不及 —— 这些是物理事实，问模型也是浪费时间
 *   2. 灰区（规则说能去）：值不值一趟得看上下文（掉了钻石还是一背包土、手头有没有活、
 *      刚有没有人拦），这块交给模型；开关 MC_DEATH_LLM=1，默认关，出问题随时退回规则
 *
 * 这个模块不直接持有 bot，所有能力由 play.js 注入，方便单测和替换。
 */
const fs = require('fs');

const ITEM_TTL = 300000;      // 掉落物 5 分钟后消失
const SPEED = 3.0;            // 保守估速（格/秒）：带地形绕行，不按冲刺算
const MAX_DIST = 200;         // 超过这个距离就不跑
const NEAR_R = 12;            // 跟上次死亡点这么近，算"同一片地方"
const KEEP = 20;              // death.json 最多留多少条
const LAVA_RE = /lava|magma|fire|campfire|soul_fire/;

// 「这一趟值不值得跑」交给模型判断（默认关，MC_DEATH_LLM=1 才问）。
// 能算准的（岩浆/虚空/维度/时间算术）永远走规则，模型只在灰区说话，而且只能否决。
const LLM_DEFAULT_TIMEOUT = 5000;
function llmOn() {
  const v = String(process.env.MC_DEATH_LLM || '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}
function llmTimeout() {
  const n = parseInt(process.env.MC_DEATH_LLM_TIMEOUT || '', 10);
  return (isFinite(n) && n >= 1000) ? Math.min(n, 15000) : LLM_DEFAULT_TIMEOUT;
}
// 掉了这些才算"肉疼"：给模型看的就是这几样
const VALUABLE_RE = /diamond|emerald|netherite|ancient_debris|lapis|amethyst|quartz|_ingot|_gem|shulker|elytra|totem|enchanted|_pickaxe|_sword|_axe|helmet|chestplate|leggings|boots|bucket|name_tag|saddle/;

function create(api) {
  const {
    getBot, log, say, sleep, Vec3,
    hostiles, mobName, walkTo, pickUpNearby, autoArmor, equipBestWeapon, invTotalCount,
    noteEvent, isBusy, addDanger, atomicWrite, file,
    askModel, recentChat, goalText,
  } = api;

  const S = { auto: true, busy: false, recs: [], last: null, lastAt: 0, hurt: { t: 0, dmg: 0 } };

  // ---------- 落盘 ----------
  function load() {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(o)) return o;
      if (o && Array.isArray(o.recs)) {
        if (typeof o.auto === 'boolean') S.auto = o.auto;
        return o.recs;
      }
    } catch (e) {}
    return [];
  }
  function save() {
    try { atomicWrite(file, { auto: S.auto, recs: S.recs.slice(-KEEP) }); } catch (e) {}
  }

  // 掉血：死的时候用来猜"是不是摔的/砸的"
  function noteHurt(dmg) {
    if (dmg > 0.01) S.hurt = { t: Date.now(), dmg };
  }

  function invSnapshot() {
    const b = getBot();
    try { return b.inventory.items().map(i => ({ n: i.name, c: i.count })); } catch (e) { return []; }
  }

  function blocksAt(p) {
    const out = [], b = getBot();
    if (!p || !b) return out;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    for (const o of [[0, 0, 0], [0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      try {
        const bl = b.blockAt(new Vec3(bx + o[0], by + o[1], bz + o[2]));
        if (bl && bl.name && bl.name !== 'air') out.push(bl.name);
      } catch (e) {}
    }
    return out;
  }

  // ---------- 死因 ----------
  // 只认"东西肯定没了"的几种，其余都当还能捡
  function classify(p, ctx) {
    const b = getBot();
    const blocks = blocksAt(p);
    const y = (p && isFinite(p.y)) ? p.y : 0;
    let mobs = [];
    try { mobs = hostiles(10).map(e => mobName(e)); } catch (e) {}
    if (y < -63) return { kind: 'void', label: '掉虚空里了', hopeless: true, why: '虚空里的东西全没了' };
    if ((ctx && ctx.lava) || blocks.some(n => LAVA_RE.test(n))) {
      return { kind: 'lava', label: '死在岩浆里', hopeless: true, why: '岩浆里的东西直接销毁（只有下界合金会浮着），跑回去也是白跑' };
    }
    if (ctx && ctx.drown) return { kind: 'drown', label: '淹死了', hopeless: false, why: '东西就沉在水里' };
    if (mobs.length) return { kind: 'mob', label: '被' + mobs[0] + '打死了', hopeless: false, why: '东西掉在原地，不过怪可能还在', mobs: mobs.slice(0, 3) };
    if (ctx && ctx.fall) return { kind: 'fall', label: '摔死了', hopeless: false, why: '摔在地面上，东西还在' };
    return { kind: 'unknown', label: '意外死了', hopeless: false, why: '不清楚怎么死的，先当能捡' };
  }

  const where = (r) => isFinite(r.x) ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.z)}` : '不知道哪儿';

  // ---------- 分级判断：值不值得跑这一趟 ----------
  function judge(rec) {
    if (!rec) return { go: false, why: '没有死亡记录' };
    const b = getBot();
    const leftMs = Math.max(0, ITEM_TTL - (Date.now() - (rec.t || 0)));
    let dist = NaN;
    try { if (b && b.entity) dist = b.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)); } catch (e) {}
    const needMs = isFinite(dist) ? (dist / SPEED) * 1000 + 15000 : NaN;   // +15 秒：穿甲、绕路、认门
    const sameDim = !rec.dim || !b || !b.game || rec.dim === b.game.dimension;
    let go = true, why = '';
    if (rec.hopeless) { go = false; why = rec.hopelessWhy || '东西已经没了'; }
    else if (!sameDim) { go = false; why = '死在别的维度，没门过不去'; }
    else if (isFinite(rec.y) && rec.y < 0 && rec.kind !== 'fall') { go = false; why = `死在 y=${Math.round(rec.y)} 的深处，跑下去大概率喂怪`; }
    else if (!isFinite(needMs)) { go = false; why = '现在算不出路，先别跑'; }
    else if (dist > MAX_DIST) { go = false; why = `死在 ${Math.round(dist)} 格外，太远了`; }
    else if (needMs > leftMs) { go = false; why = `只剩 ${Math.round(leftMs / 1000)} 秒，跑过去要 ${Math.round(needMs / 1000)} 秒，来不及`; }
    return { go, why, dist, needMs, leftMs, sameDim };
  }

  // 身上最值钱的几样：模型判断"值不值"就看这个，别把一背包土豆列给它
  function topInv(inv, n) {
    return (inv || []).slice()
      .sort((a, b) => (VALUABLE_RE.test(b.n) ? 1 : 0) - (VALUABLE_RE.test(a.n) ? 1 : 0) || b.c - a.c)
      .slice(0, n).map(i => `${i.n}x${i.c}`);
  }

  // ---------- 灰区问模型：硬规则说"能去"，再问一句"值不值" ----------
  // 只在 rules 判 go=true 时才问；模型只能否决，不能把"岩浆里"翻成"去吧"。
  // 一次死亡只问一次（结果记在 rec.llm 上），不许边跑边纠结。
  async function askLLM(rec, v) {
    if (!llmOn() || typeof askModel !== 'function') return null;
    if (rec.llm && typeof rec.llm.go === 'boolean') return rec.llm;
    let chat = [], goal = '';
    try { chat = (typeof recentChat === 'function' ? recentChat() : []) || []; } catch (e) { chat = []; }
    try { goal = (typeof goalText === 'function' ? goalText() : '') || ''; } catch (e) { goal = ''; }
    const ctx = {
      死因: rec.label, 代号: rec.kind,
      掉在: where(rec), 离我格数: Math.round(v.dist),
      东西还剩秒: Math.round(v.leftMs / 1000), 跑过去约秒: Math.round(v.needMs / 1000),
      维度: rec.dim || 'overworld',
      身上: topInv(rec.inv, 4), 总共几个: rec.invTotal,
      同一片地方第几次死: rec.sameSpot || 1,
      手头的活: goal || '没有明确目标',
      刚才公屏: chat.slice(-10),
    };
    const sys = '你在替一个 Minecraft 机器人决定：刚死了，要不要跑回去捡掉落物。硬规则已经算过' +
      '（不是岩浆/虚空、维度对得上、时间够、路能走），你要判断的只是「值不值」。' +
      '看：掉了什么贵不贵、远近、剩多少时间、手头有没有更重要的活、刚才聊天里有没有人拦着。' +
      '保守优先，拿不准就说不去。只回一行 JSON，不要解释、不要代码块：{"go":true,"why":"不超过20字"}';
    try {
      const raw = await Promise.race([
        askModel(sys, JSON.stringify(ctx)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('等太久')), llmTimeout())),
      ]);
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      if (!m) throw new Error('没给出 JSON');
      const o = JSON.parse(m[0]);
      if (typeof o.go !== 'boolean') throw new Error('go 不是 true/false');
      const out = {
        go: o.go,
        why: String(o.why || '').trim().slice(0, 40) || (o.go ? '还值得跑一趟' : '不值当跑这一趟'),
      };
      rec.llm = out;
      log(`DEATH llm: go=${out.go} why=${out.why}`);
      return out;
    } catch (e) {
      log('DEATH llm 退回规则: ' + (e && e.message ? e.message : e));
      return null;   // 超时/乱答/没 key：照规则办，规则已经判过，保守值不丢人
    }
  }

  // ---------- 记账 ----------
  function record(p) {
    const b = getBot();
    const info = classify(p, {
      lava: !!(b && b.entity && b.entity.isInLava),
      drown: !!(b && b.entity && b.entity.isInWater),
      fall: !!(S.hurt.t && Date.now() - S.hurt.t < 2500 && S.hurt.dmg >= 6),
    });
    const inv = invSnapshot();
    const rec = {
      n: S.recs.length + 1,
      t: Date.now(),
      x: p ? p.x : NaN, y: p ? p.y : NaN, z: p ? p.z : NaN,
      dim: (b && b.game && b.game.dimension) || '',
      kind: info.kind, label: info.label,
      hopeless: !!info.hopeless, hopelessWhy: info.why || '',
      mobs: info.mobs || [],
      inv: inv.slice(0, 40), invTotal: inv.reduce((s, i) => s + i.c, 0),
    };
    const near = S.recs.filter(r => isFinite(r.x) && isFinite(rec.x) &&
      Math.hypot(r.x - rec.x, r.z - rec.z) < NEAR_R && r.dim === rec.dim);
    rec.sameSpot = near.length + 1;
    S.recs.push(rec);
    if (S.recs.length > KEEP) S.recs = S.recs.slice(-KEEP);
    S.last = rec;
    save();
    return rec;
  }

  // 说给玩家听的那一句：判完了再开口，别只会喊救命
  function line(rec, v) {
    const spot = rec.sameSpot >= 3 ? `（同一片地方第 ${rec.sameSpot} 次了）` : '';
    if (!v.go) return `我${rec.label}${spot}，掉在 ${where(rec)}，${v.why}，我就不去白跑了`;
    return `我${rec.label}${spot}！掉在 ${where(rec)}，${Math.round(v.dist)} 格、还来得及，我这就回去捡～`;
  }

  // ---------- 去捡 ----------
  async function recover(rec, opt = {}) {
    const b = getBot();
    if (!b || !b.entity) return { ok: false, msg: '现在人都没上线' };
    if (S.busy) return { ok: false, msg: '已经在回去捡的路上了' };
    const v = judge(rec);
    if (!v.go && !opt.force) return { ok: false, msg: `不去捡——${v.why}`, extra: { verdict: v } };
    S.busy = true;
    const t0 = Date.now();
    let before = 0;
    try { before = invTotalCount(); } catch (e) {}
    try {
      await autoArmor(true).catch(() => {});
      await equipBestWeapon().catch(() => {});
      const p = new Vec3(rec.x, rec.y, rec.z);
      const d0 = b.entity.position.distanceTo(p);
      log(`DEATH recover start d=${d0.toFixed(0)} at ${where(rec)} kind=${rec.kind}`);
      await walkTo(p, 2.2, Math.min(120000, 10000 + d0 * 800), { sprint: d0 > 12 });
      let got = 0;
      for (let i = 0; i < 6; i++) {
        const n = await pickUpNearby(10, { force: true, keepJunk: true });
        got += n;
        if (!n) {
          await sleep(600);
          const again = await pickUpNearby(10, { force: true, keepJunk: true });
          if (!again) break;
          got += again;
        }
        await sleep(400);
      }
      let after = before;
      try { after = invTotalCount(); } catch (e) {}
      const back = Math.max(0, after - before);
      const d = b.entity.position.distanceTo(p);
      const spent = Math.round((Date.now() - t0) / 1000);
      log(`DEATH recover end got=${got} back=${back} d=${d.toFixed(1)} spent=${spent}s`);
      let msg;
      if (d > 12) msg = `绕不过去，离掉落点还差 ${d.toFixed(0)} 格，先放弃了`;
      else if (back > 0) msg = `捡回来了～多了 ${back} 件东西（${spent} 秒）`;
      else if (got > 0) msg = '到了，地上有东西，但都塞不进背包…';
      else msg = `到了 ${where(rec)}，地上已经没剩下什么了`;
      return { ok: back > 0, msg, extra: { got, back, dist: +d.toFixed(1), spent } };
    } catch (e) {
      return { ok: false, msg: '去捡的路上出问题了：' + (e && e.message ? e.message : e) };
    } finally {
      S.busy = false;
      S.lastAt = Date.now();
    }
  }

  // 重生后自动去捡：只在"划算且手上没别的活"时动手
  function scheduleRecover(rec, v) {
    if (!v || !v.go) return;
    setTimeout(async () => {
      if (!S.auto || !getBot()) return;
      if (isBusy()) { log('DEATH recover skip: busy'); return; }
      if (rec.llm && rec.llm.go === false) { log('DEATH recover skip: 模型说不值'); return; }
      const v2 = judge(rec);
      if (!v2.go) { log('DEATH recover skip: ' + v2.why); return; }
      say('我回去把东西捡一下，马上回来～');
      const r = await recover(rec);
      try { say(r.msg); } catch (e) {}
      noteEvent(null, `死后回去捡东西：${r.msg}`, r.ok ? 0.6 : 0.7);
    }, 6000);
  }

  /**
   * 死亡主入口。bot-loop 那边的收尾（停跟随、断战斗、重生）留在 play.js，
   * 这里只管"死在哪、怎么死的、值不值得捡"。
   * 返回 { rec, verdict, line }，play.js 决定什么时候开口。
   */
  async function handleDeath(p) {
    const rec = record(p);
    let verdict = judge(rec);
    // 灰区补一刀：规则说"能去"，再问模型"值不值"；模型只能否决
    if (verdict.go) {
      const lv = await askLLM(rec, verdict);
      if (lv && !lv.go) verdict = { ...verdict, go: false, why: lv.why, byLLM: true };
      else if (lv) verdict = { ...verdict, byLLM: true, llmWhy: lv.why };
    }
    S.hurt = { t: 0, dmg: 0 };
    log(`DIED ${rec.label} at ${where(rec)} kind=${rec.kind} items=${rec.invTotal} ` +
      `recover=${verdict.go ? 'yes(' + Math.round(verdict.dist) + 'm)' : 'no(' + verdict.why + ')'}`);
    noteEvent(null, `我${rec.label}（第 ${rec.n} 次死${rec.sameSpot >= 3 ? `，同一片地方第 ${rec.sameSpot} 次` : ''}），` +
      `掉在 ${where(rec)}，${verdict.go ? '东西还来得及捡' : verdict.why}`, rec.sameSpot >= 3 ? 0.85 : 0.75);
    // 同一个坑反复要人命：记成黑名单，别让自主行动再往那儿送
    if (addDanger) {
      try {
        addDanger({ x: rec.x, y: rec.y, z: rec.z, why: rec.kind, t: Date.now() });
        if (rec.sameSpot >= 3) addDanger({ x: rec.x, y: rec.y, z: rec.z, why: rec.kind + '-repeat', t: Date.now() });
      } catch (e) {}
    }
    scheduleRecover(rec, verdict);
    return { rec, verdict, line: line(rec, verdict) };
  }

  // 给 function-calling 用：last / list / recover / on / off
  async function action(a) {
    const op = String((a && (a.op || a.mode)) || 'last').toLowerCase();
    if (op === 'on' || op === 'off') {
      S.auto = (op === 'on');
      save();
      return { ok: true, msg: `死后自动回去捡：${S.auto ? '开' : '关'}` };
    }
    if (op === 'list' || op === 'log') {
      const list = S.recs.slice(-5).reverse();
      if (!list.length) return { ok: true, msg: '最近一次都没死过' };
      return {
        ok: true,
        msg: list.map(r => `#${r.n} ${r.label}@${where(r)}`).join('；'),
        extra: { list: list.map(r => ({ n: r.n, kind: r.kind, at: where(r), items: r.invTotal, sameSpot: r.sameSpot })) },
      };
    }
    const rec = S.last || (S.recs.length ? S.recs[S.recs.length - 1] : null);
    if (!rec) return { ok: false, msg: '我还没死过呢' };
    if (op === 'recover' || op === 'go') return recover(rec, { force: !!(a && a.force) });
    const v = judge(rec);
    return {
      ok: true,
      msg: `${rec.label}，掉在 ${where(rec)}：` + (v.go
        ? `值得去（${Math.round(v.dist)} 格，东西还剩 ${Math.round(v.leftMs / 1000)} 秒，跑过去约 ${Math.round(v.needMs / 1000)} 秒）`
        : `不去——${v.why}`) + (rec.sameSpot >= 3 ? `（同一片地方第 ${rec.sameSpot} 次）` : ''),
      extra: { death: rec, verdict: v, auto: S.auto },
    };
  }

  // 重启也记得上次死在哪
  S.recs = load();
  if (S.recs.length) S.last = S.recs[S.recs.length - 1];

  return { S, noteHurt, judge, askLLM, recover, handleDeath, action, load, save };
}

module.exports = { create };
