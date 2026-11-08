/**
 * mc_ipc.js — play.js 与 AstrBot「minecraft」平台适配器之间的本地通道
 *
 * 为什么要有它：chat_in.jsonl / cmd.txt 那套文件轮询本质上是在自造消息总线，
 * 轮询间隔白扔 0.5~1s。这里换成 Unix domain socket 单行 JSON，
 * 同机通信基本零延迟，文件通道原样保留当兜底。
 *
 * 方向：
 *   play.js  --(chat/self/ready)-->  adapter
 *   adapter  --(say)-------------->  play.js  （逐条 bot.chat，切句在 python 侧做）
 *
 * 协议：一行一个 JSON 对象，UTF-8 无 BOM。
 *   {t:'chat', user:'A', msg:'...', ts:169...}   玩家公屏发言
 *   {t:'self', msg:'...', ts:...}                我自己说的话（公共层要排掉自己）
 *   {t:'ready', name:'xiaoice_bot', ver:'1.21.11'} 上线/重连后同步状态
 *   {t:'hb', ts:...}                             心跳，5s 一次
 *   {t:'say', text:'...'}                        adapter 让我说话
 *   {t:'ping'} / {t:'pong'}                      探活
 *
 * 这是个「锦上添花」的通道：任何异常都只 log，绝不 throw，
 * 不允许因为它把 play.js 主循环搞崩。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const DEFAULT_SOCK = path.join(__dirname, '.mc_ipc.sock');

function attach({ log = console.log, onSay = null, sockPath = null } = {}) {
  const SOCK = sockPath || process.env.MC_IPC_SOCK || DEFAULT_SOCK;
  const clients = new Set();
  let server = null;
  let closed = false;
  let hbTimer = null;

  function send(client, obj) {
    try {
      if (client.destroyed || !client.writable) return;
      client.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      log('IPC sendErr: ' + (e.message || e));
    }
  }

  function broadcast(obj) {
    for (const c of clients) send(c, obj);
  }

  // 每个连接一条读缓冲，按 \n 切行
  function onLine(client, line) {
    const s = line.trim();
    if (!s) return;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      return; // 半行/脏行直接丢，不值得为它写日志
    }
    if (!obj || typeof obj !== 'object') return;
    switch (obj.t) {
      case 'say':
        if (typeof obj.text === 'string' && onSay) {
          try { onSay(obj.text); } catch (e) { log('IPC onSayErr: ' + (e.message || e)); }
        }
        break;
      case 'ping':
        send(client, { t: 'pong', ts: Date.now() });
        break;
      default:
        break;
    }
  }

  function start() {
    if (server) return;
    // 上一次没退干净的残留 socket 会让 listen 报 EADDRINUSE，先清
    try {
      const st = fs.statSync(SOCK);
      if (st.isSocket()) fs.unlinkSync(SOCK);
    } catch (e) { /* 不存在就是好事 */ }

    server = net.createServer((client) => {
      clients.add(client);
      client.setEncoding('utf8');
      client.setNoDelay(true);
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk;
        // 防御：万一对方不发换行，别让 buffer 无限涨
        if (buf.length > 256 * 1024) { buf = ''; return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          onLine(client, line);
        }
      });
      client.on('error', (e) => log('IPC clientErr: ' + (e.message || e)));
      client.on('close', () => clients.delete(client));
      log('IPC adapter 接入（当前 ' + clients.size + ' 个）');
      if (READY_INFO) send(client, READY_INFO);
    });

    server.on('error', (e) => {
      log('IPC serverErr: ' + (e.message || e));
      // 端口/文件被占之类的，别反复重生，等下一轮重启再说
      try { server.close(); } catch (e2) {}
      server = null;
    });

    try {
      server.listen(SOCK, () => {
        // 顺手关掉其他人的读取权限（同机同用户即可）
        try { fs.chmodSync(SOCK, 0o600); } catch (e) {}
        log('IPC 监听 ' + SOCK);
      });
    } catch (e) {
      log('IPC listenErr: ' + (e.message || e));
      server = null;
      return;
    }

    // 心跳：让 python 侧知道 play.js 还活着（比 stat 文件干净）
    if (!hbTimer) {
      hbTimer = setInterval(() => {
        if (clients.size) broadcast({ t: 'hb', ts: Date.now() });
      }, 5000);
      if (hbTimer.unref) hbTimer.unref();
    }
  }

  let READY_INFO = null;

  function stop() {
    if (closed) return;
    closed = true;
    try { if (hbTimer) clearInterval(hbTimer); } catch (e) {}
    hbTimer = null;
    for (const c of clients) { try { c.destroy(); } catch (e) {} }
    clients.clear();
    try { if (server) server.close(); } catch (e) {}
    server = null;
    try { fs.unlinkSync(SOCK); } catch (e) {}
  }

  return {
    start,
    stop,
    sockPath: SOCK,
    clientCount: () => clients.size,
    pushChat(user, msg) {
      broadcast({ t: 'chat', user: String(user).slice(0, 40), msg: String(msg).slice(0, 300), ts: Date.now() });
    },
    pushSelf(msg) {
      broadcast({ t: 'self', msg: String(msg).slice(0, 300), ts: Date.now() });
    },
    setReady(info) {
      READY_INFO = Object.assign({ t: 'ready', ts: Date.now() }, info || {});
      broadcast(READY_INFO);
    },
  };
}

module.exports = { attach, DEFAULT_SOCK };
