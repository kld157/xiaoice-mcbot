/* MC 陪玩面板 前端逻辑
 * 通过 window.AstrBotPluginPage（bridge）调用后端注册的 /astrbot_plugin_mc_panel/* 接口。
 */

const outsidePanel = () => {
  throw new Error("请在 AstrBot 管理面板的「插件页面」中打开本面板");
};

function getBridge() {
  const bridge = window.AstrBotPluginPage;
  if (!bridge) outsidePanel();
  return bridge;
}

async function waitBridge(ms = 6000) {
  const start = Date.now();
  while (!window.AstrBotPluginPage && Date.now() - start < ms) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return window.AstrBotPluginPage || null;
}

const $ = (id) => document.getElementById(id);

const state = {
  auto: true,
  timer: null,
  lastChatKey: "",
  busy: false,
};

/* ------------------------------------------------------------ 格式化 */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtClock(ts) {
  if (!ts && ts !== 0) return "--:--";
  let n = Number(ts);
  if (Number.isNaN(n)) return "--:--";
  // 后端历史上有「秒」和「毫秒」两种单位混着用，这里统一兜一下
  if (Math.abs(n) < 1e11) n *= 1000;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtAgo(seconds) {
  if (seconds === null || seconds === undefined) return "未知";
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function esc(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------ 渲染 */

function renderHeader(data) {
  const badge = $("stateBadge");
  const text = $("stateText");
  badge.className = "badge";
  if (!data.success) {
    badge.classList.add("off");
    text.textContent = "读取失败";
  } else if (data.online) {
    badge.classList.add("online");
    text.textContent = data.status_text || "在线";
  } else {
    const playProc = (data.processes || []).find((p) => p.key === "play");
    badge.classList.add(playProc && playProc.running ? "warn" : "off");
    text.textContent = data.status_text || "离线";
  }

  const bot = data.bot || {};
  $("botName").textContent = bot.name ? `@ ${bot.name}` : "";
  $("serverLine").textContent = data.success
    ? `${bot.server || "-"} · 版本 ${bot.version || "-"} · 心跳 ${fmtAgo((data.heartbeat || {}).ago)}`
    : data.error || "没找到 mcbot 目录";
  $("dirLine").textContent = data.mcbot_dir || "—";
}

function renderCards(data) {
  const hb = data.heartbeat || {};
  const maxHp = Number(data.max_hp) || 20;
  const maxFood = Number(data.max_food) || 20;

  const hp = hb.hp;
  const food = hb.food;
  $("hpValue").textContent = hp === null || hp === undefined ? "-" : `${hp} / ${maxHp}`;
  $("foodValue").textContent =
    food === null || food === undefined ? "-" : `${food} / ${maxFood}`;
  $("hpBar").style.width = hp === null || hp === undefined ? "0%" : `${Math.min(100, (hp / maxHp) * 100)}%`;
  $("foodBar").style.width =
    food === null || food === undefined ? "0%" : `${Math.min(100, (food / maxFood) * 100)}%`;
  $("hpSub").textContent = hb.not_ready ? "还没进服" : `心跳 ${fmtAgo(hb.ago)}`;
  $("foodSub").textContent =
    food === null || food === undefined
      ? "等待心跳"
      : food <= 6
        ? "饿啦，该吃点东西"
        : "状态不错";

  $("posValue").textContent = hb.pos && hb.pos !== "-" ? hb.pos : "-";
  $("posSub").textContent = hb.pos && hb.pos !== "-" ? "X / Y / Z" : "暂无坐标";

  $("pingValue").textContent =
    hb.ping === null || hb.ping === undefined ? "-" : `${Math.round(hb.ping)}`;
  $("pingSub").textContent =
    hb.ping === null || hb.ping === undefined
      ? "未知"
      : hb.ping < 80
        ? "很流畅"
        : hb.ping < 200
          ? "还行"
          : "有点卡";

  const playProc = (data.processes || []).find((p) => p.key === "play");
  $("uptimeValue").textContent = playProc && playProc.running ? playProc.uptime || "运行中" : "未运行";
  const others = (data.processes || [])
    .filter((p) => p.key !== "play")
    .map((p) => `${p.label}${p.running ? "✓" : "✗"}`)
    .join(" · ");
  $("uptimeSub").textContent = others || "play.js 进程";

  $("chatTotal").textContent = data.chat_total === undefined ? "-" : data.chat_total;
  $("chatSub").textContent = `日志 ${(Number(data.log_size || 0) / 1024 / 1024).toFixed(1)} MB`;
}

/* 把「玩家说」和「小冰的回应」并成一条时间线：
   同一条聊天若在桥接记录里找到对应回复，就挂在它下面显示。
   桥接记录里没对上（聊天流被截断）的，补到末尾，不丢。 */
function mergeThread(chat, replies) {
  const pool = (replies || []).map((r) => ({ ...r, used: false }));
  const out = [];
  (chat || []).forEach((it) => {
    const row = { ts: it.ts, user: it.user, msg: it.msg };
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      const p = pool[i];
      if (
        !p.used &&
        p.user === it.user &&
        (p.msg === it.msg || (p.msg && it.msg.startsWith(p.msg)))
      ) {
        p.used = true;
        row.reply = p.reply;
        break;
      }
    }
    out.push(row);
  });
  pool
    .filter((p) => !p.used && p.reply)
    .forEach((p) => out.push({ ts: null, user: p.user, msg: p.msg, reply: p.reply, orphan: true }));
  return out;
}

function renderChat(items, botName) {
  const box = $("chatList");
  if (!items || !items.length) {
    box.innerHTML = '<div class="empty">还没有聊天记录，进去跟人说句话吧～</div>';
    return;
  }
  const key = items.length + "|" + (items[items.length - 1] || {}).ts;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;

  box.innerHTML = items
    .map((it) => {
      const who = String(it.user || "?");
      const isSystem = /^server$/i.test(who) || /made .* a |\[Server\]/.test(it.msg);
      // bot 自己说的话要高亮：优先用真实游戏名，退回默认的两个名字
      const isSelf = botName ? who === botName : /xiaoice|小冰/i.test(who);
      const cls = ["chat-row"];
      if (isSystem) cls.push("system");
      if (it.orphan) cls.push("orphan");
      const whoCls = ["who"];
      if (isSystem) whoCls.push("server");
      if (isSelf) whoCls.push("self");
      const head = `<div class="${cls.join(" ")}">
        <span class="time">${fmtClock(it.ts)}</span>
        <span class="${whoCls.join(" ")}">${esc(who)}</span>
        <span class="what">${esc(it.msg)}</span>
      </div>`;
      if (!it.reply) return head;
      return `${head}
      <div class="chat-row reply">
        <span class="time">↳</span>
        <span class="who self">小冰</span>
        <span class="what">${esc(it.reply)}</span>
      </div>`;
    })
    .join("");

  // 只在首次渲染或用户本来就贴着底部时自动滚到底，
  // 以前是「有新消息就滚」，翻历史翻到一半会被硬拽回最新一条
  if (!state.lastChatKey || atBottom) {
    box.scrollTop = box.scrollHeight;
  }
  state.lastChatKey = key;
  $("chatTag").textContent = `最近 ${items.length} 条`;
}

function renderConfig(data) {
  const box = $("cfgList");
  const cfg = data.runtime_config || {};
  const tag = $("cfgTag");
  const ready = !!cfg.llm_ready;

  const row = (key, value, cls) => `<div class="item cfg ${cls || ""}">
      <div class="meta"><span>${esc(key)}</span></div>
      <div class="say">${esc(value || "-")}</div>
    </div>`;

  const llmLine = ready
    ? `${cfg.llm_model} · ${cfg.llm_key_masked}`
    : "没配好（base / model / key 至少缺一项）";
  const autoLine = cfg.llm_auto_model
    ? `${cfg.llm_auto_model}${cfg.llm_auto_think === false ? "（不思考）" : ""}`
    : "跟随主模型";
  const serverLine = cfg.mc_host && cfg.mc_port ? `${cfg.mc_host}:${cfg.mc_port}` : "-";

  box.innerHTML = [
    row("LLM", llmLine, ready ? "" : "action-fail"),
    row("Base", cfg.llm_base),
    row("自主行动模型", autoLine),
    row("服务器", serverLine),
    row("游戏名", cfg.mc_name ? `${cfg.mc_name}${cfg.mc_pw_set ? " · 有密码" : " · 无密码"}` : "-"),
  ].join("");

  tag.textContent = ready ? "就绪" : "待配置";
}

function renderAction(data) {
  const box = $("actionList");
  const act = data.last_action;
  if (!act) {
    box.innerHTML = '<div class="empty">还没有动作记录</div>';
    $("actionTag").textContent = "—";
    return;
  }
  const ok = act.ok !== false;
  $("actionTag").textContent = act.ago === null || act.ago === undefined ? "—" : fmtAgo(act.ago);
  box.innerHTML = `<div class="item ${ok ? "action-ok" : "action-fail"}">
      <div class="meta"><b>${esc(act.name || "unknown")}</b><span>${ok ? "成功" : "失败"}</span><span>${fmtClock(act.ts)}</span></div>
      <div class="say">${esc(act.msg || "（无描述）")}</div>
    </div>`;
}

function renderCommands(items) {
  const box = $("cmdList");
  if (!items || !items.length) {
    box.innerHTML = '<div class="empty">还没有下发过指令</div>';
    return;
  }
  box.innerHTML = items
    .map(
      (it) => `<div class="item">
        <div class="meta"><span>${fmtClock(it.ts)}</span></div>
        <div class="say">${esc(it.text)}</div>
      </div>`
    )
    .join("");
}

/* ------------------------------------------------------------ 数据 */

async function load() {
  try {
    const data = await getBridge().apiGet("status");
    const payload = data && data.success !== undefined ? data : { success: false, error: "接口返回为空" };
    renderHeader(payload);
    if (payload.success) {
      renderCards(payload);
      renderChat(mergeThread(payload.chat_recent, payload.recent_replies), (payload.bot || {}).name);
      renderAction(payload);
      renderCommands(payload.recent_commands);
      renderConfig(payload);
    } else {
      $("chatList").innerHTML = `<div class="empty">${esc(payload.error || "读取失败")}</div>`;
    }
  } catch (err) {
    console.error("加载状态失败", err);
    $("stateBadge").className = "badge off";
    $("stateText").textContent = "接口异常";
    $("serverLine").textContent = String(err && err.message ? err.message : err);
  }
}

function toast(message, ok) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show ${ok ? "ok" : "bad"}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.className = "toast";
  }, 4200);
}

async function sendCommand() {
  const input = $("cmdInput");
  const text = input.value.trim();
  if (!text || state.busy) return;
  state.busy = true;
  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "投递中…";
  try {
    const res = await getBridge().apiPost("cmd", { text });
    if (res && res.success) {
      toast(res.message || "已投递", true);
      input.value = "";
      setTimeout(load, 1200);
    } else {
      toast((res && res.error) || "投递失败", false);
    }
  } catch (err) {
    toast(`投递失败：${err && err.message ? err.message : err}`, false);
  } finally {
    state.busy = false;
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "发送";
  }
}

/* ------------------------------------------------------------ 自动刷新 */

function startAuto() {
  stopAuto();
  state.timer = setInterval(() => {
    if (!document.hidden) load();
  }, 5000);
  state.auto = true;
  $("autoBtn").textContent = "自动刷新：开";
  $("autoBtn").classList.add("primary");
}

function stopAuto() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.auto = false;
  $("autoBtn").textContent = "自动刷新：关";
  $("autoBtn").classList.remove("primary");
}

/* ------------------------------------------------------------ 启动 */

async function boot() {
  try {
    const b = await waitBridge();
    if (b && b.ready) await b.ready();
  } catch (err) {
    console.warn("bridge 准备失败", err);
  }
  $("refreshBtn").addEventListener("click", () => load());
  $("autoBtn").addEventListener("click", () => (state.auto ? stopAuto() : startAuto()));
  $("sendBtn").addEventListener("click", sendCommand);
  $("cmdInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendCommand();
    }
  });
  await load();
  startAuto();
}

document.addEventListener("DOMContentLoaded", boot);
