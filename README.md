<div align="center">

# 小冰 Minecraft Bot

**一个常驻服务器的 Minecraft 陪玩机器人 —— 能聊天、能干活、也会自己找事做。**

[![Release](https://img.shields.io/github/v/release/kld157/astrbot-xiaoice-mcbot?color=76bad9)](https://github.com/kld157/astrbot-xiaoice-mcbot/releases)
[![Node](https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Minecraft](https://img.shields.io/badge/minecraft-1.21.11-62b47a)](https://www.minecraft.net/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<a href="#主要功能">主要功能</a> ｜
<a href="#快速开始">快速开始</a> ｜
<a href="#使用方式">使用方式</a> ｜
<a href="#架构">架构</a> ｜
<a href="#faq">常见问题</a>

</div>

本项目基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 实现一个长期在线的 Minecraft 机器人，
并以大语言模型作为决策层：它可以参与聊天、跟随玩家、采集与建造、战斗，也能在无人指挥时自主安排行动。

它的定位不是「脚本刷资源工具」，而是尽可能让一个角色自然地在服务器里长期存在，与玩家一起游玩。

## 主要功能

1. 💬 **自然语言交互**：玩家在游戏内直接说话即可，模型自行选择合适的工具执行，无需记忆指令格式。
2. 🧱 **完整行动能力**：走位、跟随、挖掘、放置、搭塔、建造房屋、采集、拾取、合成、战斗、进食、更换护甲。
3. 🤖 **自主行动**：默认每 10 分钟由模型决定下一步做什么（继续 / 切换 / 闲暇），收到玩家指令后自动让行。
4. 🛡️ **长期稳定**：自动重连、死亡重生、防 AFK、内存看门狗（软线回收、硬线优雅重启）。
5. 🔍 **可观测性**：结构化日志（位置、血量、伤害来源、挖放失败原因），并提供 `flags` / `drops` / `inventory` 等只读诊断动作。
6. 🗺️ **方块扫描**：`scan` 动作与 `mcscan.py` 封装统一处理「找箱子、找矿、找结构」，只读、不改动世界。
7. 💰 **成本可控**：每次模型调用的用量按天记账，可配置保留天数自动清理。

## 快速开始

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 18（实测 v24.18.0） |
| Python | ≥ 3.8（仅桥接层与辅助脚本需要） |
| Minecraft | 1.21.11（可通过 `MC_VER` 调整） |
| 依赖 | `mineflayer`、`mineflayer-pathfinder`、`minecraft-data` |

服务器默认使用离线身份 + EasyAuth（`/register`、`/login`）。

### 1. 安装依赖

```bash
sh install_mineflayer.sh   # 幂等：缺什么装什么，失败自动切换 npmmirror
```

### 2. 配置

模型与连接信息均不进入版本库。

`llm.json`：

```json
{ "base": "https://api.example.com/v1", "model": "your-model", "key": "sk-..." }
```

`mc.env`：

```bash
MC_HOST=你的服务器地址
MC_PORT=25565
MC_NAME=bot名字
MC_PW=登录密码
```

### 3. 启动

```bash
sh start.sh            # 前台安全启动 / 重启 play.js
sh watchdog.sh         # 或：单实例守护，异常退出自动拉起
python3 mc_bridge.py   # 另一个进程，负责对话与决策
```

### 4. 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MC_HOST` / `MC_PORT` | 必填 / `25565` | 服务器地址，写在 `mc.env`，`start.sh` 自动加载 |
| `MC_VER` | `1.21.11` | 协议版本 |
| `MC_NAME` / `MC_PW` | `xiaoice_bot` / — | 离线身份与登录密码 |
| `MC_AUTO` / `MC_AUTO_MS` | `1` / `600000` | 自主行动开关与决策间隔（最小 60s） |
| `MC_HEAP_SOFT` / `MC_HEAP_HARD` | 400MB / 700MB | 内存软线（回收）与硬线（优雅重启） |
| `MC_GC_TRIM` | 220MB | 达到该用量先执行一次 GC |
| `MC_AUTOHARVEST` | `1` | 建造时是否顺路采集材料 |
| `MC_FORCE_SURVIVAL` | `1` | 上线若被切换为冒险模式，自动执行 `/gamemode survival` |
| `MC_USAGE_KEEP_DAYS` | `90` | 用量账本保留天数（`<=0` 表示不清理） |

> `mc.env`、`llm.json`、日志、用量账本均已列入 `.gitignore`，仓库中只保留占位值；
> 缺失 `MC_HOST` 时脚本会直接报错退出。

## 使用方式

### 游戏内对话

直接说话即可，也可以带上名字：

| 说法 | 行为 |
| --- | --- |
| 过来 / 跟着我 / follow | 跟随最近的目标 |
| 停 / 别动 / stop | 停止当前行为（建造任务会立即中止） |
| 建个房子 / 搭个屋 | 自行选址、采集材料并建造 |
| 挖 / 吃 / 跳 / 位置 / 转圈 | 对应的单步动作 |
| 背包 / 帮助 / 调试 | 查询与诊断 |
| 对其挥空 / 攻击一次 | 判定为「希望被跟随」，需视线对齐才生效 |

### 指令通道

外部程序可向 `cmd.txt` 写入单行指令（执行后自动删除）：

```
ACT {"id":"1","name":"goto","args":{"x":100,"y":64,"z":200}}
```

执行结果写入 `act_out.json`，通过 `id` 配对。

### 模型可用工具

`mc_bridge.py` 将机器人动作封装为 function-calling 工具，工具回执会被压缩成一句话回喂模型，
因此 `scan` 返回数百个坐标也不会占满上下文。

| 工具 | 典型说法 |
| --- | --- |
| `perceive` / `inventory` / `mobs` | 你在哪 / 身上有啥 / 附近有怪吗 |
| `follow` / `stop` / `goto` / `sprint` | 跟我走 / 别动 / 过来这边 |
| `dig` / `place` / `collect` / `surface` | 挖掉这块 / 放个方块 / 缺点土 / 爬出来 |
| `scan` | 附近有箱子吗 / 有没有橡木（只读，坐标缺 y 也先扫） |
| `chest` | 存点东西 / 把钻石拿出来 / 箱子里还有啥 |
| `craft` / `eat` / `pickup` / `armor` | 做把木剑 / 吃点东西 / 捡一下 / 换上护甲 |
| `build_house` / `build_status` | 给我搭个屋 / 盖到哪了 |
| `pvp` / `attack` | 来打一架（收着打，血量低时认输） / 打怪 |

`chest` 支持三种定位：已登记的名称（`chest:"west"`，坐标存于 `chests.json`）、
未命名时取最近容器、或直接给出 `x/y/z`。未登记的名称不会被当作容器打开。

### 方块扫描

坐标通常只有 x、z 而没有 y，此时应扫描而非猜测。`scan` 是只读动作，只返回「范围内有什么、在哪里」。

```bash
python3 mcscan.py 'chest|barrel' --r 12
python3 mcscan.py 'diamond_ore|deepslate_diamond_ore' --r 16 --limit 20
python3 mcscan.py 'chest' --r 12 --register box   # 扫描结果登记为 box1、box2…
```

```python
import mcscan
mcscan.chests(r=12, ry=6)                        # 附近容器，按距离排序
mcscan.scan('oak_door', r=8, x=.., y=.., z=..)   # 指定中心扫描
mcscan.first('water')                            # 最近的第一个
mcscan.count('grass_block', r=6)                 # 只取数量
mcscan.group('chest|barrel|glass', r=10)         # 按名称统计
mcscan.register_chests(r=12, prefix='box')       # 登记容器，之后用 chest:"box1" 打开
```

参数：`{match, x, y, z, r 或 rx/ry/rz, y0, y1, limit, sort}`。
`match` 支持 `"chest"`、`"chest,barrel"`、`"chest|barrel"` 与正则表达式；
未指定坐标时以机器人为中心，水平半径上限 32、垂直半径上限 24，单次最多返回 512 个结果。

扫描仅覆盖服务器已加载的区块。远处会返回偏高的 `unloaded` 计数，并附「一半以上区块没加载，走近点再扫」的提示。

## 架构

```
玩家聊天 ──▶ play.js ──写──▶ chat_in.jsonl ──▶ mc_bridge.py ──调用模型──▶ cmd.txt
              ▲                                                          │
              └────────────────── 执行动作 / say ◀───────────────────────┘
```

| 模块 | 职责 |
| --- | --- |
| `play.js` | 机器人本体：连接与重连、物理、寻路、动作注册表、自主行动循环、内存看门狗、文件指令通道 |
| `mc_bridge.py` | 模型桥接：读取新聊天 → 拼接上下文与人格 → 调用模型 → 写回指令。成功回复会更新 `.bridge_heartbeat`，`play.js` 据此关闭本地闲聊规则以避免双回复，心跳过期则自动回退 |
| `craft_engine.js` | 纯逻辑合成规划器：输入「要什么 + 有什么」，输出合成顺序。配方取自 `minecraft-data`，熔炼表由调用方通过 `addRecipes()` 注入 |

### 目录结构

```
play.js               机器人主体（动作、自主行动、巡检、看门狗）
mc_bridge.py          模型桥接（对话 / 决策 / 用量记账 / 每日清理）
craft_engine.js       通用合成规划器（测试：test_craft_engine.js）
mcscan.py             方块扫描封装（scan 动作的 Python 壳 + CLI + 容器登记）
where.js              注册 / 登录并上报位置
drift.js              registry 漂移检测（baseline / check）
chunk_scan.js         区块 stateId 全量扫描，用于定位越界的 mod 方块
start.sh              安全启动 / 重启（仅针对 node 运行的 play.js）
watchdog.sh           单实例守护，异常退出自动拉起
install_mineflayer.sh 一键环境安装（幂等）
release.py            按提交前缀生成 GitHub Release
gh_push.py            通过 GitHub API 推送（网络受限时替代 git push）
_push_retry.sh        带重试推送：先 API，失败回退 git push
skins/                皮肤生成与渲染脚本
mc_usage/             用量账本（按天生成，运行时产物）
```

## FAQ

**Q：能放置、也能挖掘，但服务器一律拒绝？**
服务器每次上线会将机器人设为冒险模式，该模式下所有放置与挖掘都会被拒绝。`play.js` 会在上线后自检并自动切回生存模式（`MC_FORCE_SURVIVAL=1`）。

**Q：`registry_data` 里找不到某个方块的 block / item？**
1.20.5 起方块与物品改为静态注册，该数据包无法获取。判断服务器是否包含 mod 方块，只能从区块数据反推（见 `chunk_scan.js`）。

**Q：如何判断区块内的方块 state 是否越界？**
以对应版本的原版基线为准。1.21.11 原版包含 1166 种方块 / 29671 个 state（0..29670），使用其他版本的数字会得出相反结论。

**Q：连续运行两天后进程被 OOM 终止？**
`start.sh` 已锁定 `--max-old-space-size=1024`，并配合 `play.js` 的内存看门狗（软线回收、硬线重启）处理该问题。

## 贡献

欢迎 Issue 与 Pull Request。提交信息建议使用 `feat:` / `fix:` / `docs:` / `chore:` 前缀，以便自动生成发布说明。

## License

[MIT](LICENSE)

<div align="center">

_我们希望做的是一个既能陪人聊天、也能真的帮上忙的同伴，而不是只会刷资源的脚本。_

</div>
