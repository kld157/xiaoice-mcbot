#!/usr/bin/env node
/**
 * launcher.js — 跨平台启动/守护（v0.8.0）
 *
 * 以前 start.sh / watchdog.sh 靠 /proc 扫 cmdline、setsid nohup、kill -TERM 这些
 * 只有 POSIX 才有的东西，Windows 上一个都跑不了。这里把它们换成 Node 实现，
 * 平台差异全部压在 platform.js 和一个几十行的 shim 里：
 *
 *   node launcher.js start     重启 play.js，守护没在跑就顺手带起来（旧 start.sh 只重启 bot）
 *   node launcher.js stop      停掉 play.js（连守护一起停，否则它 20 秒后就给你拉回来）
 *   node launcher.js status    谁在跑、锁干不干净
 *   node launcher.js watchdog  常驻守护 play.js + mc_bridge.py（等价旧 watchdog.sh）
 *
 * 约定保持不变：mc.env 自动加载、环境变量名不变、目录结构不变、日志文件不变。
 * 老用户照样敲 sh start.sh，那是这里的薄壳。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const P = require('./platform.js');

const HERE = __dirname;
const IS_WIN = P.IS_WIN;

const BOT_KEYWORD = 'play.js';
const BRIDGE_KEYWORD = 'mc_bridge.py';
const BRIDGE_SCRIPT = path.join(HERE, BRIDGE_KEYWORD);
const PIDFILE = path.join(HERE, 'watchdog.pid');
const LOCKFILE = path.join(HERE, '.play.lock');
const WATCHLOG = path.join(HERE, 'watchdog.log');

/** Windows 上 python 通常叫 python，POSIX 叫 python3；都可以用 PY 环境变量覆盖 */
const PY = process.env.PY || (IS_WIN ? 'python' : 'python3');

// ---------------------------------------------------------------- mc.env

/**
 * 加载 mc.env 到 process.env。
 *
 * 旧脚本是 `set -a; . ./mc.env; set +a`，也就是**覆盖**已有环境变量。这里保持一致，
 * 否则「临时 export 一个值压过文件」会在两种启动方式下表现不同，排查起来很折磨。
 * 只支持 `KEY=VALUE` / `export KEY=VALUE` / 单双引号 / # 注释——mc.env 就这几种写法，
 * 不做变量展开（真需要 $(...) 的人该去用 POSIX 那套）。
 */
function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {}; // 没有 mc.env 是合法的：全走环境变量/默认值
  }
  const loaded = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === '#') continue;
    line = line.replace(/^export\s+/, '');
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val[0] === '"' && val[val.length - 1] === '"') ||
        (val[0] === "'" && val[val.length - 1] === "'")) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, ''); // 行尾注释（引号外）
    }
    loaded[m[1]] = val;
    process.env[m[1]] = val;
  }
  return loaded;
}

/** start.sh / watchdog.sh 里写死的那些默认值，两个子命令必须完全一致，否则守护重启出来的 bot 行为和手动启动的不一样 */
function applyDefaults() {
  process.env.MC_AUTO_MS = process.env.MC_AUTO_MS || String(300000);
  process.env.MC_HEAP_SOFT = process.env.MC_HEAP_SOFT || String(419430400);
  process.env.MC_HEAP_HARD = process.env.MC_HEAP_HARD || String(734003200);
  process.env.NODE_OPTIONS = '--max-old-space-size=1024';
}

// ---------------------------------------------------------------- 找进程

/**
 * 找出命令行里含 keyword 的同类进程。
 *
 * POSIX：扫 /proc，cmdline 用 \0 分隔、末尾有个空串，替换成空格再匹配。
 * Windows：没有 /proc，用 PowerShell 的 Win32_Process 拿 ProcessId + CommandLine。
 *          不用 wmic——新系统上已被移除，靠它等于给未来埋雷；PowerShell 5.1 起都有。
 *
 * @param {string} keyword
 * @param {string[]} [bins] 首 token 的 basename 必须属于这些（防止 grep/vim 里带着关键字被误杀）
 * @returns {Array<{pid:number, cmd:string}>}
 */
function findProcs(keyword, bins) {
  const out = [];
  const allow = bins || ['node', 'node.exe', 'python', 'python3', 'python.exe', 'python3.exe'];

  if (IS_WIN) {
    const psCmd =
      "$ErrorActionPreference='SilentlyContinue';" +
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='python.exe' OR Name='python3.exe'\" |" +
      ' Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    let raw;
    try {
      raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        encoding: 'utf8', windowsHide: true, timeout: 10000,
      });
    } catch (e) {
      return out;
    }
    let parsed;
    try { parsed = JSON.parse(raw || '[]'); } catch (e) { return out; }
    if (!Array.isArray(parsed)) parsed = [parsed]; // 单条结果时 ConvertTo-Json 给的是对象
    for (const p of parsed) {
      const cmd = String(p.CommandLine || '');
      if (!cmd.includes(keyword)) continue;
      const first = cmd.trim().split(/\s+/)[0] || '';
      if (!allow.includes(path.basename(first).toLowerCase())) continue;
      out.push({ pid: Number(p.ProcessId), cmd });
    }
    return out;
  }

  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch (e) {
    return out;
  }
  for (const pid of pids) {
    let cmd;
    try {
      cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim();
    } catch (e) {
      continue; // 进程刚好死了，或者没权限
    }
    if (!cmd || !cmd.includes(keyword)) continue;
    const first = cmd.split(/\s+/)[0] || '';
    if (!allow.includes(path.basename(first))) continue;
    out.push({ pid: Number(pid), cmd });
  }
  return out;
}

/**
 * 谁在守护。
 * 新守护是 node launcher.js watchdog；但 v0.8.0 之前起的 bash 守护改了文件也没用——
 * 旧脚本早就读进内存了，会一直在那儿循环。两边必须互相看得见，否则会各起一个 bot、
 * 互相把对方"救"回来，日志刷成一片（锁挡得住第二个 bot，挡不住两套守护空转）。
 */
function watchdogProcs() {
  return [
    ...findProcs('launcher.js', ['node', 'node.exe'])
      .filter((p) => /\bwatchdog\b/.test(p.cmd) && !/\bstatus\b/.test(p.cmd)),
    // 只认「sh watchdog.sh」这种本体调用；否则随便一条 cat/grep watchdog.sh 的命令行都会被误算成守护
    ...findProcs('watchdog.sh', ['sh', 'bash', 'dash', 'zsh'])
      .filter((p) => /^\S*(sh|bash|dash|zsh)\s+(\S*\/)?watchdog\.sh(\s|$)/.test(p.cmd)),
  ];
}

/**
 * 杀进程。
 * POSIX  → 先 SIGTERM 让它自己收尾（play.js 有优雅退出），不行再 SIGKILL。
 * Windows→ 没有跨进程信号；Ctrl+C 事件送不到别人进程里，只能 taskkill /T /F 硬来。
 *          代价是 play.js 的 exit handler 跑不到——它的状态本来就是平时落盘的，可以接受。
 */
function killProc(pid, force) {
  try {
    if (IS_WIN) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore', windowsHide: true, timeout: 8000,
      });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  } catch (e) {
    return false; // 已经没了，或者没权限——两种情况都不用管
  }
}

/** 起一个脱离父进程的子进程：父进程退出（终端关了、SSH 断了）它得继续活 */
function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, {
    cwd: HERE,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true, // Windows 上 detached 会开新窗口，这里压掉
  });
  child.unref();
  return child.pid;
}

function spawnBot() {
  return spawnDetached(process.execPath, ['--expose-gc', BOT_KEYWORD]);
}

function spawnBridge() {
  return spawnDetached(PY, [BRIDGE_SCRIPT]);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function log(msg) {
  const line = `[${nowIso()}] ${msg}`;
  try { fs.appendFileSync(WATCHLOG, line + '\n'); } catch (e) {}
  if (process.stdout.isTTY) console.log(line);
}

// ---------------------------------------------------------------- start

async function cmdStart() {
  loadEnv(path.join(HERE, 'mc.env'));
  applyDefaults();

  // 只认"node 跑的那个 play.js"。裸 kill 所有带 play.js 字样的进程会把
  // node --check、编辑器、grep 一起带走，重启时容易连自己的 shell 都剁了。
  const old = findProcs(BOT_KEYWORD, ['node', 'node.exe']);
  for (const p of old) killProc(p.pid, false);
  if (old.length) {
    await P.sleep(2000);
    for (const p of findProcs(BOT_KEYWORD, ['node', 'node.exe'])) killProc(p.pid, true);
    await P.sleep(1000);
  }

  spawnBot();
  await P.sleep(1000);
  for (const p of findProcs(BOT_KEYWORD, ['node', 'node.exe'])) console.log(`started pid ${p.pid}`);

  // 顺手把守护带起来：没有才起，有就跳过（重复起虽然被锁挡着，但会多一个白跑的进程）。
  // 顺序讲究——先起 bot 再起守护，守护上来就看到 bot 活着，不会误判成「bot 挂了」又拉一个。
  if (watchdogProcs().length) {
    console.log('watchdog 已在运行，跳过');
  } else {
    const wpid = spawnDetached(process.execPath, [path.join(HERE, 'launcher.js'), 'watchdog']);
    await P.sleep(1000);
    if (watchdogProcs().some((p) => p.pid === wpid)) console.log(`watchdog started pid ${wpid}`);
    else console.log('watchdog 没起来，看看 watchdog.log');
  }
  return 0;
}

// ---------------------------------------------------------------- stop

function cmdStop(a) {
  loadEnv(path.join(HERE, 'mc.env'));

  // 先停守护，否则它 20 秒后就把 bot 拉回来了，你会以为 stop 没生效
  for (const p of watchdogProcs()) {
    if (killProc(p.pid, false)) console.log(`watchdog stopped pid ${p.pid}`);
  }
  try { fs.unlinkSync(PIDFILE); } catch (e) {}

  const bot = findProcs(BOT_KEYWORD, ['node', 'node.exe']);
  if (!bot.length) console.log('play.js 没在跑');
  for (const p of bot) {
    if (killProc(p.pid, false)) console.log(`play.js stopped pid ${p.pid}`);
  }
  if (a && a.bridge) {
    for (const p of findProcs(BRIDGE_KEYWORD, ['python', 'python3', 'python.exe', 'python3.exe'])) {
      if (killProc(p.pid, false)) console.log(`bridge stopped pid ${p.pid}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------- status

function cmdStatus() {
  const env = loadEnv(path.join(HERE, 'mc.env'));
  const bot = findProcs(BOT_KEYWORD, ['node', 'node.exe']);
  const br = findProcs(BRIDGE_KEYWORD, ['python', 'python3', 'python.exe', 'python3.exe']);
  const wd = watchdogProcs();
  const legacyWd = wd.filter((p) => !/launcher\.js/.test(p.cmd));

  console.log(`平台      : ${IS_WIN ? 'Windows' : process.platform}`);
  console.log(`play.js   : ${bot.length ? '运行中 pid ' + bot.map((p) => p.pid).join(',') : '未运行'}`);
  console.log(`mc_bridge : ${br.length ? '运行中 pid ' + br.map((p) => p.pid).join(',') : '未运行'}`);
  console.log(
    `watchdog  : ${wd.length ? '运行中 pid ' + wd.map((p) => p.pid).join(',') : '未运行'}` +
      (legacyWd.length ? `（含遗留 bash 守护，建议 stop 后重开）` : '')
  );

  // 锁文件残留会让新实例"以为还有人在跑"然后秒退，这里直接告诉你干不干净
  let lockInfo = '无';
  try {
    const lp = parseInt(fs.readFileSync(LOCKFILE, 'utf8').trim(), 10);
    lockInfo = `${lp} ${P.pidLooksAlive(lp, BOT_KEYWORD) ? '(活)' : '(僵尸，下次 start 会清掉)'}`;
  } catch (e) {}
  console.log(`.play.lock: ${lockInfo}`);
  console.log(`mc.env    : ${Object.keys(env).length} 项（${(env.MC_HOST || '-') + ':' + (env.MC_PORT || '25565')}）`);
  return 0;
}

// ---------------------------------------------------------------- watchdog

async function cmdWatchdog() {
  loadEnv(path.join(HERE, 'mc.env'));
  applyDefaults();

  // 单实例：锁文件里的 pid 真活着就退出。用 platform 的原子创建，避免两个守护同时进来都以为自己抢到了
  // 关键词用 'watchdog'：旧 bash 守护（sh watchdog.sh）和新守护（node launcher.js watchdog）互相都认得出来
  const got = P.acquireLock(PIDFILE, 'watchdog', (m) => log('watchdog: ' + m));
  if (!got.ok) {
    const msg = `watchdog already running pid ${got.pid || '?'}`;
    console.log(msg);
    log(msg);
    return 0;
  }
  // 收到终止信号时循环要能干净退出，而不是跑到一半被硬砍
  let running = true;
  P.installExitHandlers(() => {
    running = false;
    P.releaseLock(PIDFILE);
    log(`watchdog down pid ${process.pid}`);
  });

  log(`watchdog up pid ${process.pid} (${IS_WIN ? 'windows' : process.platform})`);

  while (running) {
    // 锁体检：.play.lock 里若是僵尸/已死进程就清掉，
    // 否则 play.js 一看"有实例在跑"就秒退，守护拉一次失败一次，无限循环。
    try {
      const lp = parseInt(fs.readFileSync(LOCKFILE, 'utf8').trim(), 10);
      if (lp && !P.pidLooksAlive(lp, BOT_KEYWORD)) {
        log(`watchdog: stale .play.lock (pid ${lp}) removed`);
        try { fs.unlinkSync(LOCKFILE); } catch (e) {}
      }
    } catch (e) {}

    if (!findProcs(BOT_KEYWORD, ['node', 'node.exe']).length) {
      log('watchdog: bot not running -> start');
      spawnBot();
      await P.sleep(15000); // 刚起来的进程要时间加载 mineflayer，别立刻判死
    }

    // LLM 桥：挂了就没有"真聊天"，一起守
    if (!findProcs(BRIDGE_KEYWORD, ['python', 'python3', 'python.exe', 'python3.exe']).length) {
      log('watchdog: bridge not running -> start');
      spawnBridge();
      await P.sleep(5000);
    }

    await P.sleep(20000);
  }

  P.releaseLock(PIDFILE);
  log(`watchdog down pid ${process.pid}`);
  return 0;
}

// ---------------------------------------------------------------- main

function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  const a = { bridge: process.argv.includes('--bridge') };
  switch (cmd) {
    case 'start': return cmdStart();
    case 'stop': return cmdStop(a);
    case 'status': return cmdStatus();
    case 'watchdog': return cmdWatchdog();
    default:
      console.log(`用法: node launcher.js <start|stop|status|watchdog>

  start          重启 play.js（等价旧 start.sh）
  stop           停掉 play.js，顺带停守护；--bridge 连 LLM 桥一起停
  status         谁在跑、锁干不干净
  watchdog       常驻守护 play.js + mc_bridge.py（等价旧 watchdog.sh）`);
      return cmd ? 2 : 0;
  }
}

Promise.resolve()
  .then(main)
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error('launcher 挂了:', e && e.message ? e.message : e);
    process.exit(1);
  });
