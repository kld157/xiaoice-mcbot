'use strict';
/**
 * test_craft_engine.js — craft_engine 的离线自测（不连服务器）
 * 跑法：node test_craft_engine.js
 */
const mcdata = require('minecraft-data')(process.env.MC_VER || '1.21.11');
const { createPlanner } = require('./craft_engine.js');

let pass = 0;
let fail = 0;
function check(title, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + title); }
  else { fail++; console.log('  ❌ ' + title + (detail ? '  → ' + detail : '')); }
}

const planner = createPlanner({ data: mcdata });

function show(r) {
  return r.steps.map((s) => `${s.via}:${s.name}x${s.out}${s.times > 1 ? `(x${s.times})` : ''}${s.table ? '[台]' : ''}`).join(' → ');
}

console.log('\n== 1. 木板 / 木棍（2x2，不该用工作台）==');
{
  const r = planner.plan('oak_planks', 4, { oak_log: 1 });
  check('1 原木 → 4 木板', r.ok && r.steps.length === 1, show(r));
  check('  不需要工作台', r.steps[0] && r.steps[0].table === false);
}
{
  const r = planner.plan('stick', 4, { oak_planks: 2 });
  check('2 木板 → 4 木棍', r.ok && r.steps.length === 1, show(r));
}

console.log('\n== 2. 递归：木剑（原木 → 木板 → 木棍 → 成品）==');
{
  const r = planner.plan('wooden_sword', 1, { oak_log: 1 });
  check('1 原木够做一把木剑', r.ok, show(r) || planner.explainMissing(r));
  check('  步骤含 木板/木棍/木剑', r.ok && ['oak_planks', 'stick', 'wooden_sword'].every((n) => r.steps.some((s) => s.name === n)), show(r));
  check('  木剑步骤需要工作台', r.ok && r.steps.find((s) => s.name === 'wooden_sword').table === true);
}

console.log('\n== 3. 变体回退：橡木不够就用别的木板 ==');
{
  const r = planner.plan('stick', 4, { oak_planks: 0, spruce_planks: 2 });
  check('只有云杉木板也能搓木棍', r.ok, show(r) || planner.explainMissing(r));
}

console.log('\n== 4. 工作台自己搓 ==');
{
  const r = planner.plan('crafting_table', 1, { oak_planks: 4 });
  check('4 木板 → 工作台', r.ok && r.steps[0].name === 'crafting_table' && !r.steps[0].table, show(r));
}

console.log('\n== 5. 缺料诊断 ==');
{
  const r = planner.plan('diamond_sword', 1, { stick: 1 });
  check('没钻石 → 失败', !r.ok);
  check('  说得出缺钻石', /diamond/.test(planner.explainMissing(r)), planner.explainMissing(r));
}

console.log('\n== 6. 铁剑：2 铁锭 + 1 木棍 ==');
{
  const r = planner.plan('iron_sword', 1, { iron_ingot: 2, stick: 1 });
  check('材料齐 → 一把铁剑', r.ok && r.steps.length === 1, show(r));
  check('  铁剑 1x3 → 要工作台', r.steps[0] && r.steps[0].table === true);
}

console.log('\n== 7. 注入烧炼：粗铁 → 铁锭 ==');
{
  const r0 = planner.plan('iron_ingot', 1, { raw_iron: 3 });
  check('未注入烧炼时搓不出铁锭', !r0.ok, show(r0));

  planner.addRecipes([
    {
      to: 'iron_ingot',
      from: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
      via: 'smelt',
      station: 'furnace',
      fuel: { per: 8, names: ['coal', 'charcoal'] },
    },
  ]);
  const r1 = planner.plan('iron_ingot', 2, { raw_iron: 3, coal: 1 });
  check('注入后：粗铁+煤 → 铁锭', r1.ok, show(r1) || planner.explainMissing(r1));
  check('  步骤标了 via=smelt 且带燃料', r1.ok && r1.steps[0].via === 'smelt' && r1.steps[0].fuel && r1.steps[0].fuel.name === 'coal', JSON.stringify(r1.steps[0] && r1.steps[0].fuel));

  const r2 = planner.plan('iron_sword', 1, { raw_iron: 3, coal: 1, oak_log: 1 });
  check('连贯：粗铁 → 铁锭 → 铁剑', r2.ok, show(r2) || planner.explainMissing(r2));

  const r3 = planner.plan('iron_ingot', 1, { raw_iron: 1 });
  check('没燃料烧不了', !r3.ok && /燃料/.test(planner.explainMissing(r3)), planner.explainMissing(r3));
}

console.log('\n== 8. 边界 ==');
{
  const r = planner.plan('air', 1, {});
  check('空气没有配方 → 失败而不是崩', !r.ok);
  planner.addRecipes([{ to: 'stone', from: ['cobblestone'], via: 'smelt', station: 'furnace', fuel: { per: 8, names: ['coal'] } }]);
  const r2 = planner.plan('stone', 2, { cobblestone: 2, coal: 1 });
  check('注入后圆石能烧成石头', r2.ok && r2.steps[0].via === 'smelt', show(r2) || planner.explainMissing(r2));
  check('hasRecipe 认得注入的配方', planner.hasRecipe('stone'));
  const r3 = planner.plan('stick', 0, {});
  check('count=0 按 1 处理', typeof r3.ok === 'boolean');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
