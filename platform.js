/**
 * platform.js — 平台抽象层
 *
 * 为什么有它：play.js 原来到处直接碰 Linux 特有的东西（/proc、固定 8 秒退避、
 * 非原子写盘）。要出 Windows 版时这些全会水土不服。所以把"操作系统的脾气"
 * 全部关进这一个文件，业务代码只调这里的函数。
 *
 * 现阶段覆盖：
 *   sleep / sleepSync        异步、同步的等待
 *   pidLooksAlive            pid 是否真是活着的同类进程（Linux 读 /proc，Windows 问 tasklist）
 *   acquireLock / releaseLock 单实例锁（'wx' 创建 + 陈旧锁接管，Win 上带重试）
 *   writeJsonAtomic          原子写 JSON（临时文件 + rename，Win 被占用会 EPERM/EBUSY，重试）
 *   discoverLanPort          从 .minecraft/logs/latest.log 抓"对局域网开放"的随机端口
 *   IS_WIN / MINECRAFT_DIR   平台相关常量
 *
 * 约定：这个文件不许 require play.js 里的任何东西（保持叶子节点，方便单测）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- 等待

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
}

/** 同步睡：同步上下文里做重试时用（不想为了重试把整条调用链改成 async） */
function sleepSync(ms) {
  const n = Math.max(0, ms | 0);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  } catch (e) {
    const t = Date.now();
    while (Date.now() - t < n) { /* busy wait：Atomics 不可用时的兜底 */ }
  }
}

// ---------------------------------------------------------------- 进程

/**
 * pid 是不是"还在跑的同类进程"。
 * @param {number} pid
 * @param {string} [keyword] 命令行里必须出现的关键字，如 'play.js'。
 *                            Windows 拿不到 cmdline，所以传了也只校验存活（宁可保守）。
 * Linux：/proc/<pid>/stat 第 3 字段是进程状态，Z/X 是僵尸——kill(pid,0) 对僵尸仍返回成功，
 *        所以要显式排除，否则一个僵尸会让新进程永远以为"还有人在跑"。
 */
function pidLooksAlive(pid, keyword) {
  const p = parseInt(pid, 10);
  if (!p || p < 2) return false;

  if (IS_WIN) {
    try {
      const { execFileSync } = require('child_process');
      // tasklist 对不存在的 pid 返回 "信息: 没有运行的任务..."，所以要看输出里有没有这个 pid
      const out = execFileSync('tasklist', ['/FI', `PID eq ${p}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });
      return new RegExp(`,"${p}"|,${p},`).test(out);
    } catch (e) {
      return false;
    }
  }

  try {
    const stat = fs.readFileSync('/proc/' + p + '/stat', 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    if (state === 'Z' || state === 'X' || state === 'x') return false;
    if (!keyword) return true;
    const cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8');
    return cmd.indexOf(keyword) !== -1;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- 单实例锁

/**
 * 抢单实例锁。语义与旧实现一致，但换成原子创建：
 *   锁文件存在 → 读 pid → 活着的同类进程就放弃，死进程就清掉接管。
 * 锁内容 = 本进程 pid（保留字符串格式，别加 JSON，别的地方可能直接 parseInt）。
 *
 * @returns {{ok: boolean, pid?: number}} ok=false 表示已有实例在跑
 */
function acquireLock(lockPath, keyword, onWarn) {
  const warn = typeof onWarn === 'function' ? onWarn : () => {};
  for (let attempt = 0; attempt < 3; attempt++) {
    // 先看有没有锁
    let raw = null;
    try { raw = fs.readFileSync(lockPath, 'utf8'); } catch (e) { raw = null; }

    if (raw !== null) {
      const old = parseInt(String(raw).trim(), 10);
      if (old && old !== process.pid && pidLooksAlive(old, keyword)) {
        return { ok: false, pid: old };
      }
      if (old) warn(`锁定的是死进程(pid ${old})，清掉假锁继续启动`);
      try { fs.unlinkSync(lockPath); } catch (e) {}
    }

    // 'wx' = 只新建、不覆盖。比 existsSync + writeFileSync 少一个竞态窗口
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return { ok: true, pid: process.pid };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Windows 上被杀软/索引器短暂占用会 EPERM：等一会儿再试，别一上来就崩
        if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') {
          sleepSync(30 * (attempt + 1));
          continue;
        }
        warn('锁文件写不进去: ' + (e.message || e));
        return { ok: true, pid: process.pid }; // 锁坏了也别拦着 bot 干活
      }
      sleepSync(20 * (attempt + 1)); // 别人刚创建，重新读一遍判断死活
    }
  }
  return { ok: false, pid: null };
}

/** 只在自己持锁的情况下释放，避免把别人的锁删了 */
function releaseLock(lockPath) {
  try {
    const cur = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (cur === process.pid) fs.unlinkSync(lockPath);
  } catch (e) {}
}

// ---------------------------------------------------------------- 原子写

/**
 * 原子写 JSON：写临时文件 → rename 覆盖。
 * 好处：进程在写盘中途被 kill，也不会留下半个 JSON 让下次启动解析失败。
 * Windows 特例：目标文件被杀软/编辑器占用时 rename 会 EPERM/EBUSY（Linux 上几乎不会），
 *              所以带退避重试，最后兜底直接覆盖写——宁可非原子，也不能丢数据。
 *
 * @param {string} file
 * @param {*} obj  传 null 表示删掉这个文件（沿用旧约定）
 * @returns {boolean} 是否成功
 */
function writeJsonAtomic(file, obj, opts) {
  const space = opts && opts.space !== undefined ? opts.space : 2;
  if (obj === null) {
    try { fs.unlinkSync(file); return true; } catch (e) { return false; }
  }

  let body;
  try { body = JSON.stringify(obj, null, space); } catch (e) { return false; }

  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, body); } catch (e) { tmpFailed(); return false; }

  function tmpFailed() { try { fs.unlinkSync(tmp); } catch (e) {} }

  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      if (i === 2) break;
      sleepSync(25 * (i + 1));
    }
  }
  // 兜底：直接覆盖（非原子，但内容至少写进去了）
  try { fs.writeFileSync(file, body); tmpFailed(); return true; } catch (e) { tmpFailed(); return false; }
}

// ---------------------------------------------------------------- Minecraft 目录

/** 各平台默认 .minecraft 位置（可用 MC_DIR 环境变量覆盖） */
const MINECRAFT_DIR = process.env.MC_DIR
  || (IS_WIN
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
    : path.join(os.homedir(), '.minecraft'));

/**
 * 从 latest.log 抓"对局域网开放"的端口。
 *
 * 为什么需要：单人世界点「对局域网开放」时端口是随机的（聊天栏里那串 5 位数），
 * 不是 25565。陶瓦联机场景下 bot 和房主在同一台机器，得先知道这个端口才能连 localhost。
 *
 * 原版日志形如：
 *   [12:34:56] [Server thread/INFO]: Started serving on 51234
 *   [12:34:56] [Server thread/INFO]: 本地游戏已在端口 51234 上开放
 * 取最后一次出现的（重开世界端口会变）。
 *
 * @returns {number|null}
 */
function discoverLanPort(mcDir) {
  const dir = mcDir || MINECRAFT_DIR;
  const logFile = path.join(dir, 'logs', 'latest.log');
  let text;
  try {
    const st = fs.statSync(logFile);
    // 只读尾部 256KB：latest.log 可能很大，没必要全读
    const start = Math.max(0, st.size - 256 * 1024);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (e) {}
    }
  } catch (e) {
    return null;
  }

  let port = null;
  const patterns = [
    /Started serving on (\d{2,5})/g,
    /本地游戏已在端口 ?(\d{2,5})/g,
    /Local game hosted on port (\d{2,5})/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (n > 1024 && n < 65536) port = n; // 循环到最后一次命中为准
    }
  }
  return port;
}

// ---------------------------------------------------------------- 优雅退出

/**
 * 注册跨平台退出处理：
 *   POSIX  → SIGTERM / SIGINT（kill、Ctrl+C 都能触发）
 *   Windows→ 没有真正的 SIGTERM，taskkill 默认强杀不给机会，所以要靠 SIGINT(SIGBREAK)
 *            和 process.on('exit') 兜底；调用方应尽量把状态在平时就落盘。
 * @param {Function} onExit 清理回调（落盘、释放锁）
 * @param {{signals?: boolean}} [opts] signals=false 表示调用方自己接管信号
 *        （play.js 底部已有 SIGTERM → bot.quit 的优雅退出，这里再抢就会抢在它前面 exit）
 */
function installExitHandlers(onExit, opts) {
  const handleSignals = !(opts && opts.signals === false);
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    try { onExit && onExit(); } catch (e) {}
  };
  process.on('exit', once);
  if (!handleSignals) return;
  for (const sig of IS_WIN ? ['SIGINT', 'SIGBREAK', 'SIGTERM'] : ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        once();
        process.exit(0);
      });
    } catch (e) { /* 该平台没有这个信号，忽略 */ }
  }
}

module.exports = {
  IS_WIN,
  MINECRAFT_DIR,
  sleep,
  sleepSync,
  pidLooksAlive,
  acquireLock,
  releaseLock,
  writeJsonAtomic,
  discoverLanPort,
  installExitHandlers,
};
