# 小冰 Minecraft Bot

一个常驻的 Minecraft 陪玩机器人：由 [mineflayer](https://github.com/PrismarineJS/mineflayer) 驱动，
接一个大模型当“脑子”，能聊天、跟随、采集、合成、盖房子、打怪，也会自己找事做（自动巡游式自主行动）。

不是“脚本刷资源”工具，目标是把一个有人味的角色放进服务器里，让它陪人玩。

## 特性

- **会聊**：玩家说话就走 LLM，语气、上下文（最近 6 轮）、人格设定都在 `mc_bridge.py` 里。
- **会干活**：走位、跟人、挖、放、搭柱子、盖房、采集、拾取、合成、打怪、吃东西、换护甲。
- **会自己玩**：默认每 10 分钟让模型决定接下来做什么（继续 / 换事 / 发呆），有人下指令时自动让路 20 分钟。
- **扛得住**：自动重连、死亡重生、防 AFK、内存看门狗（超软线清理 GC，超硬线自杀让 watchdog 重拉）。
- **可观测**：`play.log` 有结构化日志（位置/血量/伤害来源/挖放失败原因），还提供 `flags`、`drops`、`inventory` 等只读诊断动作。

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18（实测 v24.18.0） |
| Python | ≥ 3.8（仅桥接层需要） |
| Minecraft | 1.21.11（`MC_VER` 可改） |
| 依赖 | `mineflayer`、`mineflayer-pathfinder`、`minecraft-data` |

服务器使用离线身份 + EasyAuth（`/register`、`/login`），默认走 `auth: 'offline'`。

## 快速开始

```bash
# 1. 装依赖（幂等，缺什么装什么，失败自动切 npmmirror）
sh install_mineflayer.sh

# 2. 配置模型与连接信息（都不进版本库）
cat > llm.json <<'EOF'
{ "base": "https://api.example.com/v1", "model": "your-model", "key": "sk-..." }
EOF

cat > mc.env <<'EOF'
MC_HOST=你的服务器地址
MC_PORT=25565
MC_NAME=bot名字
MC_PW=登录密码
EOF

# 3. 启动
sh start.sh        # 前台安全启动/重启 play.js
sh watchdog.sh     # 或者用守护模式：挂了自动拉起（单实例）
python3 mc_bridge.py   # 另开一个进程，负责“说话”和“思考”
```

连接参数全走环境变量，改代码不用动：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MC_HOST` / `MC_PORT` | —（必填） / `25565` | 服务器地址，写在 `mc.env`，`start.sh` 自动加载 |
| `MC_VER` | `1.21.11` | 协议版本 |
| `MC_NAME` / `MC_PW` | `xiaoice_bot` / — | 离线身份与登录密码（同样放 `mc.env`） |
| `MC_AUTO` / `MC_AUTO_MS` | `1` / `600000` | 自主行动开关与决策间隔（最小 60s） |
| `MC_HEAP_SOFT` / `MC_HEAP_HARD` | 400MB / 700MB | 内存软线（清理 GC）、硬线（优雅重启） |
| `MC_GC_TRIM` | 220MB | 到这个量先收一遍 GC |
| `MC_AUTOHARVEST` | `1` | 盖房时是否顺路采集材料 |
| `MC_FORCE_SURVIVAL` | `1` | 上线若被切成冒险模式，自动 `/gamemode survival` |
| `MC_USAGE_KEEP_DAYS` | `90` | token 账本保留天数（`<=0` 永不清理） |

> 隐私：`mc.env`、`llm.json`、日志、token 账本等一律在 `.gitignore` 里，仓库里只留占位值；
> 缺 `MC_HOST` 时脚本会直接报错退出，不会悄悄连去别的地方。

## 游戏内怎么用

直接说话就行，提到“小冰”或者干脆下指令：

| 说法 | 行为 |
|---|---|
| 过来 / 跟着我 / follow | 跟随最近的那个人 |
| 停 / 别动 / stop | 停下（盖房时也会立刻停工） |
| 建个房子 / 搭个屋 | 自己找地方、采料、盖好 |
| 挖 / 吃 / 跳 / 位置 / 转圈 | 对应单步动作 |
| 背包 / 帮助 / 调试 | 查询与诊断 |
| 对着它挥手（左键空挥）/ 打它一下 | 认定为“想让它跟着”，眼神得对上才算 |

命令行 / 外部程序想下指令，写一行到 `cmd.txt` 即可（执行后自动删除）：

```
ACT {"id":"1","name":"goto","args":{"x":100,"y":64,"z":200}}
```

结果覆盖写入 `act_out.json`，带 `id` 供配对。

## 架构

```
玩家聊天 ──▶ play.js ──写──▶ chat_in.jsonl ──▶ mc_bridge.py ──调模型──▶ cmd.txt
              ▲                                                        │
              └───────────────── 执行动作 / say ◀───────────────────────┘
```

- **`play.js`** — 常驻 bot 本体：连接、重连、物理、寻路、动作注册表、自主行动循环、内存看门狗、文件指令通道。
- **`mc_bridge.py`** — LLM 桥接：读新聊天 → 拼上下文与人格 → 调模型 → 写回指令。成功回复会 touch `.bridge_heartbeat`；
  `play.js` 见心跳新鲜就关掉自己的本地闲聊规则（防止双回复），心跳过期自动回退。
- **`craft_engine.js`** — 纯逻辑合成规划器：给定“要什么 + 有什么”，算出按什么顺序搓。配方直接取 `minecraft-data`，
  烧炼表由调用方 `addRecipes()` 注入，所以加高炉 / 切石机 / 锻造台不用改规划器。

## 目录

```
play.js              bot 主体（动作、自主行动、巡检、看门狗）
mc_bridge.py         LLM 桥接（说话 / 决策 / token 记账 / 每日清理）
craft_engine.js      通用合成规划器 + 测试 test_craft_engine.js
gh_push.py           走 GitHub API 推送（网络差时替代 git push）
_push_retry.sh       带重试推送：先 API，失败回退 git push
start.sh             安全启动/重启（只认 node 跑的那个 play.js）
watchdog.sh          单实例守护，异常退出自动拉起
install_mineflayer.sh 一键环境安装（幂等）
where.js             注册/登录并报位置
drift.js             registry 漂移检测（baseline / check）
chunk_scan.js        区块 stateId 全量扫描，找越界的 mod 方块
skins/               皮肤生成与渲染脚本
mc_usage/            token 账本（按天，运行时生成）
```

## token 记账

每次 LLM 调用的 usage 追加到 `mc_usage/YYYY-MM-DD.jsonl`（一行一次，本地时区）。
账本按天自清理，默认保留 90 天（`MC_USAGE_KEEP_DAYS` 可调）。
`mc_usage.jsonl.migrated-*` 是旧单文件账本的留档，同样按保留期清理。

## 一些坑（写在前面）

- **冒险模式**：服务器每次上线会把 bot 设成冒险模式，此时所有放置/挖掘都会被拒。`play.js` 上线自检并自动切回生存。
- **registry 里没有 block/item**：1.20.5+ 起方块和物品是静态注册，`registry_data` 包抓不到，
  要判断服务器有没有 mod 方块，只能从区块里反推（见 `chunk_scan.js`）。
- **别用旧版本的 state 基线**：1.21.11 原版是 1166 种方块 / 29671 个 state（0..29670），
  拿别的版本数字（比如 1.20.6 的 26683）当基线会得出完全相反的结论。
- **内存**：连续跑两天会把 heap 吃到 OOM。`start.sh` 里锁了 `--max-old-space-size=1024`，配合 `play.js` 的看门狗才稳。

## 推送到 GitHub

这台机器连 `github.com` 的 git 智能协议很容易超时/被掐断（`git fetch` 都能卡十几分钟），
但 `api.github.com` 是通的。所以推送**优先走 API**：

```bash
python3 gh_push.py            # 直接推当前分支（Git Data API）
python3 gh_push.py --dry-run  # 只看要推哪些 commit，不发请求
./_push_retry.sh 3 30         # 带重试：先 API，失败才回退 git push
```

- `gh_push.py` 用 Git Data API 把 blob / tree / commit 逐层灌到远端。git 对象哈希由内容决定，
  **重建出来的 commit SHA 和本地完全一致**，所以不会产生“远端历史被改写”的假象。
  （坑：commit message 末尾的换行必须原样传，`rstrip` 一下哈希就变了。）
- 回退的 `git push` 是**普通推送**，不再用 `--force`：真连上了就老老实实推；
  万一本地和远端分叉，宁可失败也别悄悄覆盖。
- token 放**本目录 `.gh_token`**（`chmod 600`，已在 `.gitignore` 里），或环境变量 `GH_TOKEN` / `GITHUB_TOKEN`。
  细粒度 PAT 只需要 `Contents: Read and write` 权限。

> 历史曾经做过脱敏重写。如果哪天确实需要强制覆盖远端（比如远端还留着旧提交），
> 手动执行 `git push --force origin HEAD:main`，别把它写回脚本里。

## License

MIT
