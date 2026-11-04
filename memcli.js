#!/usr/bin/env node
// memcli.js —— 重要记忆的手动管理（在 mcbot 目录下跑）
//
//   node memcli.js ls                看全部（事实 + 关系）
//   node memcli.js ls 小明           只看某个人
//   node memcli.js fact 小明 家 杭州  手动记一条事实
//   node memcli.js rel 小明 好友 服主  手动记一条关系（朋友/好友这类自动对称）
//   node memcli.js forget 小明        删掉某个人的全部（或传 id 删单条）
//   node memcli.js block            看看实际喂给模型的 prompt 长什么样
//   node memcli.js test 我家在杭州     离线试一下提炼（不进库）
//
// 只读/只写 mc_important.json，不碰 memory.js 的流水账。

'use strict';
const IMP = require('./important.js');

const [, , cmd, ...args] = process.argv;

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dump(who) {
  const facts = IMP.listFacts(who);
  const rels = IMP.listRelations(who);
  if (!facts.length && !rels.length) { console.log(who ? `没记过「${who}」` : '（空）'); return; }
  if (rels.length) {
    console.log('关系：');
    for (const r of rels) {
      const line = r.sym ? `${r.a} —${r.rel}— ${r.b}` : `${r.a} 是 ${r.b} 的 ${r.rel}`;
      console.log(`  · ${line}${r.note ? '（' + r.note + '）' : ''}  [${fmtTs(r.ts)}]`);
    }
  }
  if (facts.length) {
    console.log('事实：');
    for (const f of facts) {
      const old = (f.prev || []).map(p => p.value).join(' ← ');
      console.log(`  · ${f.subject} 的 ${f.attr}：${f.value}` +
        (old ? `（原：${old}）` : '') +
        `  [${fmtTs(f.ts)}${f.hits > 1 ? ' 确认' + f.hits + '次' : ''}]`);
    }
  }
}

switch (cmd) {
  case 'ls': case 'list':
    dump(args[0]);
    console.log(JSON.stringify(IMP.stats()));
    break;

  case 'fact': {
    const [subject, attr, ...rest] = args;
    if (!subject || !attr || !rest.length) { console.log('用法：node memcli.js fact 小明 家 杭州'); process.exit(1); }
    const r = IMP.addFact({ subject, attr, value: rest.join(' '), source: '手动' });
    console.log(r ? '已记下' : '没记（参数不全或已满）');
    break;
  }

  case 'rel': {
    const [a, rel, b] = args;
    if (!a || !rel || !b) { console.log('用法：node memcli.js rel 小明 好友 服主'); process.exit(1); }
    const r = IMP.addRelation({ a, rel, b, source: '手动' });
    console.log(r ? `已记下（${r.sym ? '对称' : '单向'}）` : '没记（参数不全或已满）');
    break;
  }

  case 'forget': {
    if (!args[0]) { console.log('用法：node memcli.js forget 小明 | 条目id'); process.exit(1); }
    console.log('删了 ' + IMP.forget(args[0]) + ' 条');
    break;
  }

  case 'block':
    console.log(IMP.block(args[0]) || '（空，没什么可喂的）');
    break;

  case 'test': {
    // 离线试算：用跟线上一样的解析器，但不经过 LLM
    const raw = args.join(' ');
    const obj = IMP.pickJson(raw);
    console.log('看起来值得记？', IMP.looksImportant(raw));
    console.log('解析结果：', obj ? JSON.stringify(obj) : '（这不是 JSON，正常的——这条命令主要用来验解析）');
    break;
  }

  default:
    console.log(`重要记忆管理
  node memcli.js ls [谁]              看记忆
  node memcli.js fact 小明 家 杭州    记一条事实
  node memcli.js rel 小明 好友 服主   记一条关系
  node memcli.js forget 小明          删掉某人的全部（或传 id）
  node memcli.js block 小明           看喂给模型的 prompt（按人分开的）
  node memcli.js test 文本            离线验提炼/解析`);
}
