# MC Bot 探针工具

服务器探针 & Cortico 验证用脚本。环境：Node v24.18.0 + mineflayer + minecraft-data。

## 文档

- `cortico create.md` — Cortico × Create 直播 bot 调研交接文档（41KB，13 章）。
  方案选型、协议细节、Create 数据层分析都在里面，开工前先读这份。
  早期版本见 `archive/cortico create.md.bak-20261022`。

## 脚本

### `install_mineflayer.sh` — 一键装环境（幂等）

```bash
sh mcbot/install_mineflayer.sh                              # 缺什么装什么，已装则秒退
sh mcbot/install_mineflayer.sh --force                      # 强制重装（先删包再装）
MINEFLAYER_VERSION=4.39.0 sh mcbot/install_mineflayer.sh     # 锁版本
```

做的事：检查 node/npm（要求 >= 18）→ 检测 `mineflayer` / `mineflayer-pathfinder`
能否 require → 缺则 `npm install`，常规源失败自动切 npmmirror 重试 →
最后校验并补装 `minecraft-data`。退出码 0 表示环境可用。

> 换机器 / 重装容器后跑这一条就够了，不用再手动 npm install。

### `drift.js` — registry 漂移巡检

连进服务器，抓 `configuration` 阶段的 `registry_data`，跟 `baseline.json` 比对。

```bash
node drift.js check      # 比对当前服务器 vs 基线，有变化会列出来
node drift.js baseline   # 重建基线（会备份旧的）
```

覆盖的注册表：biome / chat_type / damage_type / dimension_type / enchantment /
instrument / jukebox_song / painting_variant / trim_material / trim_pattern / wolf_variant 等 23 个。

> 注意：`minecraft:block` / `minecraft:item` **不在** registry_data 里（1.20.5+ 起是静态注册，
> 靠客户端本地数据同步），所以方块这一层 protocol 层面根本抓不到 —— 要用 `chunk_scan.js` 从区块里反推。

### `chunk_scan.js` — 区块 stateId 扫描

全 section 解析 `level_chunk_with_light`，统计所有 stateId，找出超出原版范围的（= mod 方块）。

```bash
node chunk_scan.js
```

判定逻辑：`stateId > 原版上限` → 服务器上确实有 mod 方块在跑。

## 实测结论（2026-10-24）

服务器 `mc.example.com:25565`，MC 1.21.11，离线身份 `xiaoice`。

| 项目 | 结果 |
|---|---|
| 连通性 | ✅ 握手正常，能完整解析区块 |
| registry_data | 23 个注册表，无 block/item |
| 原版基线 | 1166 种方块 / **29671 个 state**（0..29670） |
| 区块扫描 | 135 区块 / 3240 section / **0 解析异常** |
| 实际 state | 130 种，范围 0 .. 29376 |
| **越界数量** | **0 个** |
| 判定 | **服务器未装 Create，纯原版 + 数据包** |

⚠️ 踩过的坑：`27722` 一度被我误判成「超界的 mod 方块」，实际是 **deepslate（深板岩）**。
旧笔记里「1.20.6 = 26683 个 state」是**另一个版本**的数字，不能拿来当 1.21.11 的基线。

## 待办

- [ ] Create 的 stateId 顺序验证 → 需要一台真装了 Create Fly 的服务端（本地开服最省事）
- [ ] `mod-blocks.ts` 的 drift 假设（Create 接在原版之后）尚未被任何真实数据验证

## archive/

早期一次性探测脚本和日志，留着备查，不用了。

## token 记账（余额插件的数据源）

- 每次 LLM 调用的 usage 追加到 `mc_usage/YYYY-MM-DD.jsonl`（一行一次，本地时区）。
- 账本自清理：超过保留期的按天文件每天自动删一次（启动时 + 每晚跨天时），
  默认保留 **90 天**，可用环境变量 `MC_USAGE_KEEP_DAYS` 调（`<=0` 表示永不删）。
- `mc_usage.jsonl.migrated-*` 是旧单文件账本的留档，同样按保留期清掉。
