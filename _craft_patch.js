// ---------- 合成（Craft）----------
// 配方数据直接用 minecraft-data（就是 mcwiki 上那套），不手抄表。
// 支持递归：先搓木板→木棍→再搓成品；需要工作台的会自动找/搓/摆一张。
const TABLE_NAME = 'crafting_table';

function itemDefOf(n) {
  try { return bot.registry.itemsByName[n] || null; } catch (e) { return null; }
}
function itemNameOf(id) {
  try { const it = bot.registry.items[id]; return it ? it.name : null; } catch (e) { return null; }
}
function invCountOf(n) {
  try { return (bot.inventory.items() || []).filter(i => i.name === n).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; }
}
function nearbyTable() {
  const d = itemDefOf(TABLE_NAME);
  if (!d) return null;
  try { return bot.findBlock({ matching: d.id, maxDistance: 6 }); } catch (e) { return null; }
}
async function placeCraftingTable() {
  const it = (bot.inventory.items() || []).find(i => i.name === TABLE_NAME);
  if (!it) return null;
  const base = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const spot = base.offset(dx, 0, dz);
    const target = bot.blockAt(spot);
    const below = bot.blockAt(spot.offset(0, -1, 0));
    if (!target || !below || below.boundingBox === 'empty') continue;
    if (target.boundingBox !== 'empty') continue;
    try {
      await bot.equip(it, 'hand');
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      await bot.waitForTicks(3);
      const now = bot.blockAt(spot);
      if (now && now.name === TABLE_NAME) return now;
    } catch (e) { log('放工作台失败 ' + e.message); }
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
async function craftPlan(name, count, depth) {
  depth = depth || 0;
  if (depth > 5 || !bot || !bot.entity) return false;
  let need = count - invCountOf(name);
  if (need <= 0) return true;
  const d = itemDefOf(name);
  if (!d) return false;
  let all = [];
  try { all = bot.recipesAll(d.id, null, true) || []; } catch (e) { all = []; }
  if (!all.length) return false;                     // 没有这种配方（或得用熔炉/别的方块）
  // 先试不用工作台的（2x2），再试要工作台的（3x3）
  const sorted = all.slice().sort((a, b) => (a.requiresTable ? 1 : 0) - (b.requiresTable ? 1 : 0));
  for (const r of sorted) {
    let table = null;
    if (r.requiresTable) {
      table = await ensureTable();
      if (!table) continue;
    }
    const times = Math.max(1, Math.ceil(Math.min(need, 64 * 8) / r.result.count));
    let okMat = true;
    for (const dd of r.delta) {
      if (dd.count >= 0) continue;
      const ing = itemNameOf(dd.id);
      if (!ing) { okMat = false; break; }
      const want = -dd.count * times;
      if (invCountOf(ing) < want) {
        if (!await craftPlan(ing, want, depth + 1)) { okMat = false; break; }
      }
      if (invCountOf(ing) < want) { okMat = false; break; }
    }
    if (!okMat) continue;
    try {
      await bot.craft(r, times, table || null);
      await bot.waitForTicks(3);
      if (invCountOf(name) >= count) return true;
    } catch (e) { log(`合成 ${name} 失败（换配方）：${e && e.message}`); }
  }
  return invCountOf(name) >= count;
}

actRegister('craft', async (a) => {
  const name = String((a && (a.item || a.name || a.thing)) || '').trim().toLowerCase().replace(/\s+/g, '_');
  const count = Math.max(1, Math.min(64, parseInt((a && a.count) || 1, 10) || 1));
  if (!name) return { ok: false, msg: '要搓什么呀？args 里给个 item，比如 {"item":"wooden_sword"}' };
  if (!bot || !bot.entity) return { ok: false, msg: '我还没进服呢' };
  const d = itemDefOf(name);
  if (!d) return { ok: false, msg: `物品名不对：${name}，要用英文 id（wooden_sword / stone_sword / crafting_table）` };
  const before = invCountOf(name);
  const ok = await craftPlan(name, count, 0);
  const got = invCountOf(name) - before;
  if (got > 0) equipBestWeapon();
  return {
    ok: got > 0,
    msg: got > 0 ? `搓好了 ${name} x${got}` : `没搓成 ${name}：材料不够或者铺不了工作台`,
    extra: { item: name, made: got, have: invCountOf(name) },
  };
});
