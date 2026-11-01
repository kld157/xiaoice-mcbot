# 更新日志 / Changelog

本文件记录小冰 Minecraft Bot 的改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号暂用「0.x + 日期」，等接口稳定再切语义化版本。

---

## [0.3.0] - 2026-11-01

这一版的主角是**自然语言调用**：玩家在游戏里说人话，模型自己挑工具去执行，
不再需要背 `@动作 参数` 这种指令。

### 新增
- **LLM 工具调用（function calling）**：聊天一句话即可触发 `scan` / `chest` / `craft` / `eat` /
  `pickup` / `armor` / `mobs` / `attack` 等动作，一轮最多 2–3 个工具，回复控制在 40 字内。
- **`scan` 动作通用化**：`match` 支持名字、逗号列表、正则；支持中心 `x,y,z`、半径 `r` 或
  各轴 `rx,ry,rz`、高度区间 `y0,y1`、`limit`、`sort`；返回 `count/list/group/unloaded`，
  区块没加载够时会提示「走近点再扫」。
- **`mcscan.py` 封装与 CLI**：`scan / scan_full / first / count / group / chests / register_chests`，
  可直接 `python3 mcscan.py 'chest|barrel' --r 12 --register box`。
- **具名箱子**：`chest:"vault"` 用名字打开，坐标存 `chests.json`；新名字会自动放一个新箱子。
  `chest` 同时支持直接给坐标。

### 改进
- **工具回执压缩**：回给模型的结果只保留结论，省 token 也少啰嗦。
- **全失败不再嘴硬**：动作全部失败时如实说明，不假装成功。
- **README 补充**目录结构与用法。

### 修复
- `chest` 遇到未登记的名字时给出友好提示，而不是报错一串堆栈。

---

## [0.2.0] - 2026-10-31

### 新增
- **PVP 切磋**：`pvp` 动作 + `mc_bridge.py` 工具 + `pvp_watch.py` 待战模式（人一上线就开打）；
  支持 `target/who` 别名、`hits=n` 砍够刀数收手（客户端看不到对手血量，用刀数估）。
- **药水系统**：数字 `potionId` 映射（1.21 注册表），负面药水与未知药水不喝；PVP 公平药水并行分发
  （45s → 12s）；预留 `opcmd` 调试口。
- **容器存取 `chest`**：`mode=store|take|list`，支持 `preset:"junk"` 预设垃圾清单。
  用于替代被服务器回滚的 `toss`，实测背包 35 格 → 21 格。
- **统一 LLM 调用层 `llm.js`**：说话用快模型、干活用思考模型，自动行动也走 LLM。
- **推送改走 GitHub API**（`gh_push.py`）：绕开 `git push` 被墙/超时；对象哈希一致，不改写历史。

### 改进
- `place` 换面重试，失败原因细分（`occupied / no_mats / far / rejected`）。
- 连接参数全部改环境变量（`mc.env`，已忽略），真实地址与密码不入库。
- `.gitignore` 补齐，清掉一次性补丁残留与皮肤中间图。

### 修复
- 服务器上线把 bot 设成 `adventure` 导致放/挖全被拒：spawn 后检测 `gamemode`，自动切回 `survival`（含一次重试）。
- `collect` 挖 0 块：`BUILD.abort` 被 `stop` 永久置真，改为 `!(BUILD.active && BUILD.abort)`。
- `pickup` 假失败：手动调用被巡检的 `pickupBusy` / 600ms 冷却挡住，改为 `force` 跳过冷却并最多等 8s。
- 新增只读诊断动作 `flags` / `drops`，`pickUpNearby` 会记录跳过原因。

---

## [0.1.0] - 2026-10-31

### 新增
- 初始版本：mineflayer 驱动的常驻机器人 + LLM 桥接 + 看门狗。
- 会聊（最近 6 轮上下文 + 人格设定）、会干活（跟随/挖放/搭柱/盖房/采集/拾取/合成/打怪/吃东西/换护甲）、
  会自己玩（默认每 10 分钟让模型决定下一步，有人下指令时自动让路 20 分钟）。
- 稳定性：自动重连、死亡重生、防 AFK、内存看门狗（超软线 GC、超硬线自杀让 watchdog 重拉）。
- 可观测：`play.log` 结构化日志（位置/血量/伤害来源/挖放失败原因）。

---

## 约定

- **只读优先**：诊断类工具（`scan` / `flags` / `drops` / `inventory`）不改变世界状态。
- **OP 是急救包**：能自己动手就先自己动手，卡死才用 `/give`、`/gamemode`，且一次到位。
- **密钥不入库**：服务器地址、端口、密码、GitHub token 一律走环境变量或本地忽略文件。
