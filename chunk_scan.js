// 全 section 扫描 v2：修正 section 结构（blockCount + blockStates + biomes）
const mineflayer = require('mineflayer');
const md = require('minecraft-data')('1.21.11');

let VANILLA_MAX = 0;
for (const b of md.blocksArray) if (b.maxStateId > VANILLA_MAX) VANILLA_MAX = b.maxStateId;
const byState = md.blocksByStateId || {};
console.log(`原版 1.21.11: ${md.blocksArray.length} 种方块, ${VANILLA_MAX + 1} 个 state (0..${VANILLA_MAX})`);

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_NAME || 'xiaoice_bot',
  version: '1.21.11', auth: 'offline', hideErrors: true, checkTimeoutInterval: 15000,
});

function readVarInt(buf, off) {
  let value = 0, size = 0, byte;
  do {
    if (off + size >= buf.length) throw new Error('eof');
    byte = buf[off + size]; value |= (byte & 0x7f) << (7 * size); size++;
    if (size > 5) throw new Error('varint too long');
  } while (byte & 0x80);
  return { value: value >>> 0, size };
}

function readPaletted(buf, off, count) {
  const bits = buf.readUInt8(off); off += 1;
  let ids = [];
  if (bits === 0) {
    const v = readVarInt(buf, off); off += v.size;
    ids = new Array(count).fill(v.value);
  } else if (bits <= 8) {
    const len = readVarInt(buf, off); off += len.size;
    if (len.value > 4096) throw new Error('bad palette len ' + len.value);
    for (let i = 0; i < len.value; i++) { const v = readVarInt(buf, off); off += v.size; ids.push(v.value); }
    const perLong = Math.floor(64 / bits), longs = Math.ceil(count / perLong);
    off += longs * 8;
  } else {
    const perLong = Math.floor(64 / bits), longs = Math.ceil(count / perLong);
    const mask = (1n << BigInt(bits)) - 1n;
    if (off + longs * 8 > buf.length) throw new Error('overrun');
    for (let i = 0; i < longs; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(buf[off + i * 8 + b] || 0);
      for (let j = 0; j < perLong; j++) ids.push(Number((v >> BigInt(j * bits)) & mask));
    }
    off += longs * 8;
  }
  return { ids, off };
}

const freq = new Map();
let chunks = 0, sections = 0, errors = 0, errMsg = '';

bot._client.on('packet', (data, meta) => {
  if (meta.name !== 'level_chunk_with_light' && meta.name !== 'map_chunk') return;
  const buf = data.chunkData;
  if (!buf || !buf.length) return;
  chunks++;
  try {
    let off = 0;
    for (let s = 0; s < 24; s++) {
      off += 2; // blockCount
      const r1 = readPaletted(buf, off, 4096); off = r1.off;
      const r2 = readPaletted(buf, off, 64);   off = r2.off;  // biomes
      sections++;
      for (const id of r1.ids) freq.set(id, (freq.get(id) || 0) + 1);
    }
  } catch (e) { errors++; if (!errMsg) errMsg = e.message; }
});

bot.on('error', () => {});
bot.on('login', () => console.log('已登录，扫描中…'));

setTimeout(() => {
  const all = [...freq.keys()];
  const over = [...freq.entries()].filter(([id]) => id > VANILLA_MAX).sort((a, b) => b[1] - a[1]);
  console.log(`\n区块 ${chunks} | section ${sections} | 异常 ${errors}${errMsg ? ' (' + errMsg + ')' : ''}`);
  if (all.length) console.log(`不同 stateId ${all.length} | 范围 ${Math.min(...all)} .. ${Math.max(...all)}`);
  console.log(`\n👉 越界 stateId (>${VANILLA_MAX}): ${over.length} 个`);
  over.slice(0, 40).forEach(([id, c]) => console.log(`   id=${id} (+${id - VANILLA_MAX}) ${c} 次`));
  console.log('\n最常见方块 Top 10:');
  [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([id, c]) => {
    const b = byState[id];
    console.log(`   ${(b ? b.name : '<超出原版>').padEnd(32)} id=${String(id).padEnd(6)} ${c}`);
  });
  process.exit(0);
}, 22000);
