'use strict';
/**
 * craft_engine.js — 通用合成规划器（纯逻辑，不连服务器、不发网络包）
 *
 * 为什么单独拆出来：
 *   play.js 里原来有两份几乎一样的递归（craftPlan 真搓、canMakeSim 假推演），
 *   改一处忘一处。这里只留一份：给定「要什么 + 背包里有什么」，算出该按什么顺序做。
 *   真正动手（bot.craft / 开熔炉）交给调用方，因为只有它知道 bot 在哪。
 *
 * 配方从哪来：
 *   crafting 记录直接用 minecraft-data 的 recipes（就是 wiki 合成表的导出，不手抄）。
 *   minecraft-data 没有烧炼表，所以烧炼由调用方用 addRecipes() 注入，格式一样，
 *   规划器不区分来源 —— 加高炉/切石机/锻造台也只要再注一组记录。
 *
 * 用法：
 *   const planner = require('./craft_engine').createPlanner({ data: bot.registry });
 *   const r = planner.plan('wooden_sword', 1, { oak_log: 2 });
 *   if (r.ok) r.steps.forEach(s => ...);   // [{via:'craft', name:'oak_planks', times:1, recipe}]
 *   else console.log(planner.explainMissing(r));
 */

const MAX_DEPTH = 6;
const MAX_TIMES = 512;      // 一次规划最多做多少轮，防手滑写个 9999

function toCount(n) {
  const v = parseInt(n, 10);
  return v > 0 ? v : 1;
}

function createPlanner(options) {
  const o = options || {};
  const data = o.data;
  if (!data || !data.items || !data.itemsByName || !data.recipes) {
    throw new Error('craft_engine: 需要 minecraft-data 实例（通常是 bot.registry）');
  }
  const log = o.log || function () {};
  const MAXD = o.maxDepth || MAX_DEPTH;
  const MAXT = o.maxTimes || MAX_TIMES;

  const id2name = (id) => {
    const it = data.items[id];
    return it ? it.name : null;
  };
  const idOf = (name) => {
    const it = data.itemsByName[name];
    return it ? it.id : null;
  };

  const injected = [];              // 注入的配方（烧炼等）
  const cache = new Map();          // name -> 归一化后的配方列表

  /** 把一条 crafting 原始记录转成统一格式 */
  function fromCrafting(name, raw) {
    const rows = raw.inShape || null;
    const inputs = [];
    let width = 0;
    let height = 0;

    if (rows && rows.length) {
      height = rows.length;
      width = rows.reduce((m, row) => Math.max(m, row.length), 0);
      const agg = new Map();
      for (const row of rows) {
        for (const cell of row) {
          if (cell === null || cell === undefined) continue;
          const n = Array.isArray(cell) ? id2name(cell[0]) : id2name(cell);
          if (!n) continue;
          agg.set(n, (agg.get(n) || 0) + 1);
        }
      }
      for (const [n, c] of agg) inputs.push({ names: [n], count: c, label: n });
    } else {
      const list = raw.ingredients || [];
      const agg = new Map();
      for (const cell of list) {
        const n = Array.isArray(cell) ? id2name(cell[0]) : id2name(cell);
        if (!n) continue;
        agg.set(n, (agg.get(n) || 0) + 1);
      }
      for (const [n, c] of agg) inputs.push({ names: [n], count: c, label: n });
      width = height = list.length <= 4 ? 2 : 3;
    }
    if (!inputs.length) return null;

    // 2x2 摆得下就不用工作台：宽高都 <=2
    const table = width > 2 || height > 2;
    return {
      via: 'craft',
      result: { name, id: idOf(name), count: (raw.result && raw.result.count) || 1 },
      inputs,
      table,
      station: table ? 'crafting_table' : null,
      raw,
      source: 'data',
    };
  }

  /** 取某个物品的候选配方（数据源 + 注入），按「少铺工作台、材料种数少」排序 */
  function recipesFor(name) {
    if (cache.has(name)) return cache.get(name);
    const out = [];
    const id = idOf(name);
    if (id !== null && data.recipes[id]) {
      for (const raw of data.recipes[id]) {
        const r = fromCrafting(name, raw);
        if (r) out.push(r);
      }
    }
    for (const r of injected) {
      if (r.result.name === name) out.push(r);
    }
    // crafting 优先（材料通常是背包现成的），同档再比「要不要工作台」「材料种数」
    out.sort((a, b) =>
      (a.via === 'craft' ? 0 : 1) - (b.via === 'craft' ? 0 : 1) ||
      (a.table ? 1 : 0) - (b.table ? 1 : 0) ||
      a.inputs.length - b.inputs.length);
    cache.set(name, out);
    return out;
  }

  /**
   * 注入额外配方（例如烧炼：raw_iron -> iron_ingot）。
   * 形如：
   *   { to:'iron_ingot', from:['iron_ore','raw_iron'], via:'smelt',
   *     station:'furnace', fuel:{ per:8, names:['coal','charcoal'] } }
   */
  function addRecipes(list) {
    for (const d of list || []) {
      for (const from of [].concat(d.from || [])) {
        const fromId = idOf(from);
        if (fromId === null) continue;
        injected.push({
          via: d.via || 'craft',
          result: { name: d.to, id: idOf(d.to), count: d.out || 1 },
          inputs: [{ names: [from], count: 1, label: from }],
          table: false,
          station: d.station || null,
          fuel: d.fuel || null,
          raw: d,
          source: 'injected',
        });
      }
    }
    cache.clear();
    return injected.length;
  }

  const stockOf = (stock, names) => {
    let best = 0;
    for (const n of names) best = Math.max(best, stock[n] || 0);
    return best;
  };

  /** 在候选里挑一个还有库存的；都没有就挑第一个（让后续递归去造） */
  function pickName(stock, names) {
    let best = null;
    let bestN = -1;
    for (const n of names) {
      const c = stock[n] || 0;
      if (c > bestN) { bestN = c; best = n; }
    }
    return best;
  }

  function snapshot(state) {
    return { stock: Object.assign({}, state.stock), steps: state.steps.length };
  }
  function rollback(state, snap) {
    state.stock = snap.stock;
    state.steps.length = snap.steps;
  }

  /** 递归：保证 stock 里至少有 count 个 name（不够就现场造），成功返回 true */
  function ensure(state, name, count, depth, chain) {
    const have = state.stock[name] || 0;
    if (have >= count) return true;
    if (depth > MAXD) return false;
    if (chain.indexOf(name) !== -1) return false;      // 循环配方，别绕死
    const need = count - have;
    const recs = recipesFor(name);
    if (!recs.length) {
      noteMissing(state, name, count, have);
      return false;
    }

    const deeper = chain.concat(name);
    for (const r of recs) {
      const snap = snapshot(state);
      let times = Math.max(1, Math.ceil(need / r.result.count));
      if (times > MAXT) times = MAXT;

      // 燃料（烧炼）：单独扣，不进入 steps
      // 燃料有不同档位：煤 1 个烧 8 个，木板 1.5 个，木棍 0.5 个
      let fuelUse = null;
      if (r.fuel) {
        const list = (r.fuel.list && r.fuel.list.length)
          ? r.fuel.list
          : (r.fuel.names || []).map((n) => ({ name: n, per: r.fuel.per || 1 }));
        for (const f of list) {
          const per = Math.max(0.5, f.per || 1);
          const fuelNeed = Math.ceil(times / per);
          if ((state.stock[f.name] || 0) >= fuelNeed) {
            fuelUse = { name: f.name, count: fuelNeed };
            break;
          }
        }
        if (!fuelUse) {
          const top = list.slice().sort((a, b) => (state.stock[b.name] || 0) - (state.stock[a.name] || 0))[0];
          const per = Math.max(0.5, (top && top.per) || 1);
          noteMissing(state, '燃料', Math.ceil(times / per), top ? state.stock[top.name] || 0 : 0);
          rollback(state, snap);
          continue;
        }
      }

      // 先把要用的材料定下来（变体回退时不能中途换人），再逐个补，最后一起扣
      const uses = r.inputs.map((inp) => ({
        name: pickName(state.stock, inp.names),
        want: inp.count * times,
      }));

      let ok = true;
      for (const u of uses) {
        if (!ensure(state, u.name, u.want, depth + 1, deeper)) { ok = false; break; }
      }
      if (!ok) { rollback(state, snap); continue; }

      // 真扣材料
      for (const u of uses) {
        state.stock[u.name] = (state.stock[u.name] || 0) - u.want;
      }
      if (fuelUse) state.stock[fuelUse.name] = (state.stock[fuelUse.name] || 0) - fuelUse.count;

      const produced = r.result.count * times;
      state.stock[name] = (state.stock[name] || 0) + produced;
      state.steps.push({
        via: r.via,
        name,
        times,
        out: produced,
        inputs: uses.map((u) => ({ name: u.name, count: u.want })),
        fuel: fuelUse,
        station: r.station,
        table: !!r.table,
        recipe: r,
      });
      return true;
    }
    noteMissing(state, name, count, have);
    return false;
  }

  // need 一律是「总共要多少」，have 是「手上有多少」；缺口 = need - have。
  // （以前这里混传过「差额」，库存不为 0 时缺口会被算成负数，need 就报「配方算不出来」）
  function noteMissing(state, name, need, have) {
    const prev = state.missing.get(name);
    const info = { name, need: Math.max(need, 1), have };
    if (!prev || (info.need - info.have) > (prev.need - prev.have)) state.missing.set(name, info);
  }

  /**
   * 计划：把库存里的材料变成 count 个 target。
   * @returns {{ok:boolean, steps:Array, missing:Array, stock:Object}}
   *   steps 已按执行顺序排好（依赖在前），直接照着做即可。
   */
  function plan(target, count, have) {
    const state = {
      stock: Object.assign({}, have || {}),
      steps: [],
      missing: new Map(),
    };
    const ok = ensure(state, target, toCount(count), 0, []);
    return {
      ok,
      steps: state.steps,
      missing: Array.from(state.missing.values()),
      stock: state.stock,
    };
  }

  /** 只要一个「做不做得出」的答案（护甲/武器自查用） */
  function dryRun(target, count, have) {
    try { return plan(target, count, have).ok; } catch (e) { log('dryRun 出错 ' + e.message); return false; }
  }

  function explainMissing(result) {
    if (!result || !result.missing || !result.missing.length) return '';
    return result.missing
      .map((m) => (m.name === '燃料' ? `燃料差${m.need - m.have}` : `${m.name}差${m.need - m.have}`))
      .join('、');
  }

  function hasRecipe(name) {
    return recipesFor(name).length > 0;
  }

  return { plan, dryRun, addRecipes, recipesFor, hasRecipe, explainMissing, id2name, idOf };
}

module.exports = { createPlanner, MAX_DEPTH };
