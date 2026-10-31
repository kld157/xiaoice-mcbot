#!/usr/bin/env node
/** where.js — 处理 EasyAuth 注册/登录，报出当前位置后退出 */
const mineflayer = require('mineflayer');

// 连接参数一律走环境变量：真实值放同目录 mc.env（已被 .gitignore 忽略）
const HOST = process.env.MC_HOST || '';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VER = process.env.MC_VER || '1.21.11';
const NAME = process.env.MC_NAME || 'xiaoice_bot';
const PW = process.env.MC_PW || '';

const log = [];
const L = (s) => log.push(s);

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: NAME, version: VER,
  auth: 'offline', hideErrors: true, checkTimeoutInterval: 15000,
});

let registered = false, loggedIn = false, lastPos = null;

bot._client.on('packet', (data, meta) => {
  if (meta.name === 'position' || meta.name === 'position_look') {
    lastPos = { x: data.x, y: data.y, z: data.z };
  }
});

function done(obj) {
  console.log(JSON.stringify({ ...obj, log: log.slice(-10) }));
  try { bot.quit(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
}

const timer = setTimeout(() => done({ ok: false, err: '超时', pos: lastPos, registered, loggedIn }), 45000);

bot.on('message', (m) => {
  const t = m.toString().replace(/§./g, '').trim();
  if (!t) return;
  L('msg:' + t.slice(0, 140));
  if (/registerRequired|Use \/register/i.test(t) && !registered) {
    registered = true;
    L('ACTION /register');
    setTimeout(() => bot.chat(`/register ${PW} ${PW}`), 800);
  } else if (/loginRequired|Use \/login/i.test(t) && !loggedIn) {
    L('ACTION /login');
    setTimeout(() => bot.chat(`/login ${PW}`), 800);
  } else if (/loginSuccess|Successfully registered|logged in|Welcome|now authenticated/i.test(t)) {
    loggedIn = true;
    setTimeout(() => {
      clearTimeout(timer);
      const p = bot.entity ? bot.entity.position : null;
      done({
        ok: true,
        pos: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : lastPos,
        dimension: bot.game && bot.game.dimension,
        health: bot.health, food: bot.food,
        version: bot.version,
        players: Object.keys(bot.players),
      });
    }, 2500);
  }
});

bot.on('error', (e) => { L('err:' + (e.message || e).toString().slice(0, 120)); });
bot.on('kicked', (r) => { L('kick:' + String(r).slice(0, 200)); });
bot.on('end', (r) => { L('end:' + r); });
