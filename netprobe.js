/**
 * netprobe.js — 连服前的连通性探测
 *
 * 为什么有它：服务器一挂，play.js 每 8 秒就 createBot 一次，每次都撞 ECONNREFUSED，
 * 一天能攒出几千条无用日志（play.log 里已经 3605 条）。
 * 先做一次 TCP 探测：端口都不通，就别创建 mineflayer 实例了，省得刷屏也省得反复握手。
 *
 * 注意：只做 TCP 层探测，不代表"能登进去"（可能还在维护/白名单）。
 *      它的定位是"快速排除明显连不上的情况"，所以失败判定要保守（超时算不通）。
 */
'use strict';

const net = require('net');

/**
 * 探一下 host:port 能不能建 TCP 连接
 * @returns {Promise<boolean>} true=端口开着
 */
function tcpProbe(host, port, timeoutMs) {
  const t = timeoutMs || 4000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) {}
      resolve(ok);
    };

    const sock = new net.Socket();
    sock.setTimeout(t);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try {
      sock.connect(port, host);
    } catch (e) {
      done(false);
    }
  });
}

module.exports = { tcpProbe };
