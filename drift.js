#!/usr/bin/env node
/**
 * mc_drift.js — Minecraft 服务器 registry 漂移检测
 *
 * 用法:
 *   node mc_drift.js baseline    抓当前服务器 registry，存为基线
 *   node mc_drift.js check       抓当前，与基线比对，输出差异
 *
 * 数据来源: configuration 阶段的 minecraft:registry_data 包（服务器真实下发）
 */
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');

const HOST = process.env.MC_HOST || 'mc.example.com';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VER = process.env.MC_VER || '1.21.11';
const NAME = process.env.MC_NAME || 'xiaoice_bot';
const DIR = __dirname;
const BASE = path.join(DIR, 'baseline.json');

const MODE = process.argv[2] || 'check';

function grab() {
  return new Promise((resolve, reject) => {
    const regs = {};
    let brand = null;
    const timer = setTimeout(() => {
      try { bot.quit(); } catch (e) {}
      reject(new Error('抓取超时（25s）'));
    }, 25000);

    const bot = mineflayer.createBot({
      host: HOST, port: PORT, username: NAME, version: VER,
      auth: 'offline', hideErrors: true, checkTimeoutInterval: 15000,
    });

    bot._client.on('packet', (data, meta) => {
      if (bot._client.state !== 'configuration') return;
      if (meta.name !== 'registry_data') return;
      const name = String(data.name || data.registry_id || data.id || '?');
      const e = data.entries;
      let keys = [];
      if (Array.isArray(e)) keys = e.map(x => String(x && (x.key || x.name || x.id) || '?'));
      else if (e && Array.isArray(e.entries)) keys = e.entries.map(x => String(x && (x.key || x.name) || '?'));
      regs[name] = [...new Set(keys)].sort();
    });

    bot.on('login', () => {
      brand = (bot.game && bot.game.serverBrand) || null;
      setTimeout(() => {
        clearTimeout(timer);
        try { bot.quit(); } catch (e) {}
        resolve({ brand, version: VER, host: `${HOST}:${PORT}`, at: new Date().toISOString(), regs });
      }, 3500);
    });
    bot.on('kicked', r => { clearTimeout(timer); reject(new Error('被踢: ' + JSON.stringify(r))); });
    bot.on('error', e => { /* 忽略中间态错误，靠超时兜底 */ });
  });
}

function ns(key) { return key.includes(':') ? key.split(':')[0] : 'minecraft'; }

function summarize(regs) {
  const s = { total: 0, byNs: {}, regCount: Object.keys(regs).length };
  for (const keys of Object.values(regs)) {
    s.total += keys.length;
    for (const k of keys) { const n = ns(k); s.byNs[n] = (s.byNs[n] || 0) + 1; }
  }
  return s;
}

(async () => {
  const cur = await grab();
  const sum = summarize(cur.regs);

  if (MODE === 'baseline') {
    fs.writeFileSync(BASE, JSON.stringify(cur, null, 2));
    console.log(`✅ 基线已保存 -> ${BASE}`);
    console.log(`   服务器: ${cur.host}  版本: ${cur.version}  brand: ${cur.brand}`);
    console.log(`   registry 数: ${sum.regCount}  条目总数: ${sum.total}`);
    console.log('   命名空间分布:');
    Object.entries(sum.byNs).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`     ${n}: ${c}`));
    return;
  }

  if (!fs.existsSync(BASE)) { console.log('❌ 还没有基线，先跑: node mc_drift.js baseline'); process.exit(1); }
  const old = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const changes = [];

  const allReg = new Set([...Object.keys(old.regs), ...Object.keys(cur.regs)]);
  for (const r of [...allReg].sort()) {
    const a = old.regs[r] || null, b = cur.regs[r] || null;
    if (!a) { changes.push({ reg: r, type: 'REG_ADDED', items: b }); continue; }
    if (!b) { changes.push({ reg: r, type: 'REG_REMOVED', items: a }); continue; }
    const sa = new Set(a), sb = new Set(b);
    const added = b.filter(x => !sa.has(x));
    const removed = a.filter(x => !sb.has(x));
    if (added.length) changes.push({ reg: r, type: 'ADDED', items: added });
    if (removed.length) changes.push({ reg: r, type: 'REMOVED', items: removed });
  }

  console.log(`比对: ${old.at} -> ${cur.at}`);
  console.log(`brand: ${old.brand} -> ${cur.brand}\n`);
  if (!changes.length) {
    console.log('✨ 零漂移 —— 一个字都没动');
  } else {
    console.log(`⚠️  发现 ${changes.length} 处变化:\n`);
    for (const c of changes) {
      console.log(`[${c.type}] ${c.reg} (${c.items.length})`);
      c.items.forEach(i => console.log(`    ${c.type === 'REMOVED' ? '-' : '+'} ${i}`));
    }
    fs.writeFileSync(path.join(DIR, `drift-${Date.now()}.json`), JSON.stringify({ old: old.at, cur: cur.at, changes }, null, 2));
  }
  process.exit(0);
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
