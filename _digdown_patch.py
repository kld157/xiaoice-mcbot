# -*- coding: utf-8 -*-
# 给战斗加「挖台阶下去打」逻辑
import io, re, sys, shutil, time

P = 'play.js'
src = io.open(P, encoding='utf-8').read()
bak = P + '.bak.digdown.%d' % int(time.time())
shutil.copyfile(P, bak)

# 1) 工具函数：插在 fleeFrom 之后、主循环之前
anchor = "// ---------- 主循环：150ms 一拍 ----------"
helper = r'''
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
  let steps = 0;
  const t0 = Date.now();
  while (steps < maxSteps && Date.now() - t0 < 9000) {
    if (!bot || !bot.entity || !t || !t.position) break;
    if (!COMBAT.active || COMBAT.target !== t) break;
    if (bot.health != null && bot.health <= FLEE_HP + 3) break;     // 血少就别往下跳了
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
      if (feetB.boundingBox === 'block' && !(await digBlockSafe(feetB))) continue;
      const dropB2 = cellAt(fx, base.y - 1, fz);
      if (dropB2 && dropB2.boundingBox === 'block' && !(await digBlockSafe(dropB2))) continue;
      try { bot.lookAt(new Vec3(fx + 0.5, base.y - 1.2, fz + 0.5), true); } catch (e) {}
      await walkTo(new Vec3(fx, base.y - 1, fz), 0.7, 1400, { dyTol: 1.8 });
      await sleep(120);
      steps++;
      moved = true;
      break;
    }
    if (!moved) { log('COMBAT digdown 没地方下脚 dy=' + dy.toFixed(1)); break; }
    log('COMBAT digdown step=' + steps + ' y=' + bot.entity.position.y.toFixed(1) + ' dy=' + (t.position.y - bot.entity.position.y).toFixed(1));
  }
  return steps;
}

'''
assert anchor in src
src = src.replace(anchor, helper + anchor, 1)

# 2) 主循环里的「等」改成「优先挖下去」
old_wait = '''    if (Math.abs(dy) > 3.2) {                    // 怪在坑里/高处：别一头栽下去，等它上来
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
      if (Date.now() - (COMBAT.waitUntil || 0) > 2500) {
        COMBAT.waitUntil = Date.now();
        log('COMBAT wait ' + mobName(t) + ' dy=' + dy.toFixed(1));
      }
      if (Date.now() - COMBAT.since > 9000) endCombat('unreachable');
      return;
    }'''
new_wait = '''    if (Math.abs(dy) > 3.2) {                    // 怪在坑里/高处：够不着
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
      const below = dy < -1.6;                   // 怪在下面
      const canDig = below && !COMBAT.descending && (COMBAT.digTry || 0) < 3
        && n !== 'creeper' && bot.health >= 13 && dist < 10;
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
    }'''
assert old_wait in src
src = src.replace(old_wait, new_wait, 1)

# 3) 开打时清掉挖台阶计数
old_start = "    COMBAT.stuck = 0; COMBAT.lastPos = null;"
new_start = "    COMBAT.stuck = 0; COMBAT.lastPos = null; COMBAT.digTry = 0; COMBAT.descending = false;"
assert old_start in src
src = src.replace(old_start, new_start, 1)

# 4) 选目标时放宽"下面"的高度差（4 → 9），上面的仍限 4
old_pick = "    if (Math.abs(e.position.y - me.y) > 4) continue;   // 怪在头顶/脚底下（洞里、地里）够不着，别追"
new_pick = "    if (e.position.y - me.y > 4 || me.y - e.position.y > 9) continue;   // 头顶上的不追；脚底下的可以挖下去打"
assert old_pick in src
src = src.replace(old_pick, new_pick, 1)

io.open(P, 'w', encoding='utf-8').write(src)
print('patched, backup =', bak)
