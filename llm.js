'use strict';
// ===== 统一的大模型调用层 =====
// 思路：说话走便宜快的小模型；「自己动手干活」走开了思考（reasoning）的模型，
// 想清楚再动手，少做蠢事（挖空、原地转圈、把材料扔了之类）。
//
// llm.json 结构：
// {
//   "base": "https://api.deepseek.com/v1",
//   "model": "deepseek-chat",
//   "key": "sk-...",
//   "auto": {                     // 可整个删掉，删了就退回主模型
//     "model": "deepseek-flash",  // 思考模型
//     "think": true,              // 是否要思考（false 就只换模型不思考）
//     "temperature": 0.7,
//     "max_tokens": 1800,         // 思考会吃 token，所以要给足，不然只剩思考没正文
//     "timeout_ms": 45000,
//     "extra": {}                 // 想传别的参数（如 enable_thinking）塞这里
//   }
// }
const fs = require('fs');
const path = require('path');

function loadCfg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'llm.json'), 'utf8')); }
  catch (e) { return null; }
}

const KIND = {
  // 说话：短、快、便宜，不要思考
  say:    { block: 'main', temperature: 1.25, maxTokens: 90,  timeoutMs: 8000 },
  // 干活：要思考，token 给足，时间放宽
  auto:   { block: 'auto', temperature: 0.7,  maxTokens: 1800, timeoutMs: 45000 },
  // 自救：也要思考，但命要紧，超时就交给本地兜底顺序
  rescue: { block: 'auto', temperature: 0.2,  maxTokens: 600,  timeoutMs: 12000 },
};

function pickTarget(cfg, kind) {
  const k = KIND[kind] || KIND.say;
  const a = (cfg && cfg.auto) || {};
  const useAuto = k.block === 'auto' && !!(a.model || a.think);
  const tgt = {
    base: (useAuto && a.base) || cfg.base,
    key: (useAuto && a.key) || cfg.key,
    model: useAuto ? (a.model || cfg.model) : cfg.model,
    think: useAuto ? a.think !== false : false,
    temperature: (useAuto && a.temperature != null) ? a.temperature : k.temperature,
    max_tokens: (useAuto && a.max_tokens != null) ? a.max_tokens : k.maxTokens,
    timeoutMs: (useAuto && a.timeout_ms != null) ? a.timeout_ms : k.timeoutMs,
    extra: (useAuto && a.extra) || null,
    isAuto: useAuto,
  };
  if (!tgt.base || !tgt.key || !tgt.model) return null;
  return tgt;
}

// 思考模型的正文有时是空的（token 全花在思考上），这时从 reasoning_content 里捞 JSON
function rescueFromReasoning(rc) {
  if (!rc) return '';
  const m = String(rc).match(/\{[\s\S]*\}/g);
  if (m && m.length) return m[m.length - 1];
  const lines = String(rc).trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}

async function once(tgt, messages, opts) {
  const body = { model: tgt.model, messages };
  if (tgt.temperature != null) body.temperature = tgt.temperature;
  if (tgt.max_tokens) body.max_tokens = tgt.max_tokens;
  if (tgt.extra && typeof tgt.extra === 'object') Object.assign(body, tgt.extra);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs || tgt.timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(String(tgt.base).replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tgt.key, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    const raw = await resp.text();
    let d = null;
    try { d = JSON.parse(raw); } catch (e) {}
    if (!resp.ok || !d) {
      const err = new Error(`HTTP ${resp.status} ${String(raw).slice(0, 150)}`);
      err.status = resp.status;
      err.body = String(raw).slice(0, 400);
      throw err;
    }
    const ch = (d.choices && d.choices[0]) || {};
    const msg = ch.message || {};
    const text = String(msg.content || '').trim();
    const reasoning = String(msg.reasoning_content || msg.reasoning || '').trim();
    return {
      ok: true, d, usage: d.usage || {}, model: d.model || tgt.model,
      text: text || rescueFromReasoning(reasoning),
      textRaw: text, reasoning,
      finish: ch.finish_reason || '',
      ms: Date.now() - t0,
    };
  } finally { clearTimeout(to); }
}

// 统一入口：cfg=llm.json 内容；kind='say'|'auto'|'rescue'
// 返回 {ok, text, reasoning, d, usage, model, ms, err, kind, viaModel}
async function chat(cfg, kind, messages, over) {
  const o = over || {};
  const tgt = pickTarget(cfg, kind);
  if (!tgt) return { ok: false, err: 'llm.json 没配置好', kind };
  const run = { ...tgt, ...(o.model ? { model: o.model } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.max_tokens ? { max_tokens: o.max_tokens } : {}) };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let r = await once(run, messages, run);
      // 思考把 token 吃光、正文空 → 加倍再来一次（只重试一次）
      if (!r.textRaw && r.finish === 'length' && !attempt) {
        run.max_tokens = Math.round((run.max_tokens || 600) * 2);
        continue;
      }
      if (!r.textRaw && !r.reasoning && !attempt) continue;   // 全空，再试一次
      r.kind = kind; r.viaModel = run.model;
      return r;
    } catch (e) {
      lastErr = e;
      // 有些接口不吃 temperature / extra 参数，400 时去掉再试一次
      if (attempt === 0 && (e.status === 400 || e.status === 422)) {
        run.temperature = undefined; run.extra = null;
        continue;
      }
      break;
    }
  }
  // 思考模型挂了就退回主模型，别让机器人干等着
  if (tgt.isAuto) {
    const fallback = pickTarget({ ...cfg, auto: null }, 'say');
    if (fallback) {
      try {
        fallback.max_tokens = Math.max(tgt.max_tokens, 600);
        fallback.timeoutMs = 25000;
        fallback.temperature = tgt.temperature;
        const r = await once(fallback, messages, fallback);
        r.kind = kind; r.viaModel = fallback.model; r.degraded = true;
        return r;
      } catch (e2) { lastErr = e2; }
    }
  }
  return { ok: false, err: (lastErr && (lastErr.message || String(lastErr))) || 'unknown', kind, viaModel: run.model };
}

module.exports = { loadCfg, chat, pickTarget, KIND };
