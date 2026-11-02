# MC 陪玩面板

给 Minecraft 陪玩 bot（xiaoice-mcbot）装在 AstrBot 管理面板里的一个可视化页面。

bot 在服务器里跑着，你只能翻几十 MB 的 `play.log` 猜它在干嘛；装上这个插件，直接在 AstrBot 网页上就能看到它活得怎么样、刚才说了什么、干了什么，还能隔空丢一句话进去。

## 面板长什么样

| 区域 | 看什么 |
| --- | --- |
| 状态卡 | 在线 / 离线 / 心跳超时，HP、饥饿度、坐标、延迟、当前版本 |
| 进程守护 | `play.js`、`mc_bridge.py` 是否在跑（读 `/proc`，不是猜的） |
| 聊天流 | 游戏内最近 60 条聊天，bot 自己的话会标出来，小冰的回应挂在下面 |
| 动作记录 | 最近一次动作的结果（成功 / 失败 + 描述） |
| 配置速览 | LLM 是否配好（key 只露头尾）、连的哪个服、游戏名有没有密码 |
| 输入框 | 写一行，1 秒内进到游戏里；`ACT ...` 开头则走动作通道 |

## 安装

这个插件没有独立仓库，它住在 [xiaoice-mcbot](https://github.com/kld157/xiaoice-mcbot) 的 `astrbot_plugin_mc_panel/` 子目录里——面板本来就是给那个 bot 做看板的，放一起省心。

**方式一：mcbot 就在本机**（最常见）

```bash
cp -r <你的mcbot目录>/astrbot_plugin_mc_panel /AstrBot/data/plugins/
```

**方式二：只从 GitHub 拉这个子目录**

```bash
cd /tmp
git clone --depth 1 --filter=blob:none --sparse https://github.com/kld157/xiaoice-mcbot.git
cd xiaoice-mcbot
git sparse-checkout set astrbot_plugin_mc_panel
cp -r astrbot_plugin_mc_panel /AstrBot/data/plugins/
```

然后在 AstrBot 管理面板 → 插件管理 → 重载插件。

## 前置条件

面板只是个"看板 + 输入框"，真正干活的是 mcbot。你需要：

1. 一个已经在跑的 mcbot 目录，里面有 `play.js`、`play.log`、`chat_in.jsonl`、`act_out.json`、`cmd.txt`；
2. AstrBot 版本 `>= 4.16`（需要 `register_web_api`，旧版本插件会打警告并跳过页面接口）。

跑 Python 3.9+，除 AstrBot 本身外没有额外依赖。

## 配置

管理面板 → 插件配置 → MC 陪玩面板。

| 配置项 | 说明 |
| --- | --- |
| `mcbot_dir` | mcbot 目录，如 `/AstrBot/data/workspaces/xxx/mcbot`。**留空会自动扫** `data/workspaces/*/mcbot` |
| `sync_secrets` | 是否把下面的 LLM / 服务器配置写进 mcbot 的 `llm.json`、`mc.env`。关掉就纯当看板 |
| `llm_base` / `llm_model` / `llm_key` | LLM 接口地址、模型名、API Key。**留空 = 不改**，沿用 mcbot 里原来的 |
| `llm_auto_model` / `llm_auto_think` | bot 自主行动时单独用的模型，以及是否开思考 |
| `mc_host` / `mc_port` / `mc_ver` / `mc_name` / `mc_pw` | 服务器地址、端口、版本、游戏名、登录密码。**留空 = 不改** |

几个约定：

- 配置项**只有非空才覆盖**，所以可以只填想改的那一两项，别的保持原样；
- `llm.json` 和 `mc.env` 写盘权限是 `600`，`mc.env` 就地更新，注释和变量顺序都不会被打乱；
- 改完要**重启 `play.js`** 才生效，插件日志里会提示改了哪些文件；
- 不想让插件碰 mcbot 的文件，把 `sync_secrets` 关掉即可。

## 面板里能发什么

| 输入 | 效果 |
| --- | --- |
| `你好呀` | 当成游戏内聊天，bot 会读到并用 LLM 回你 |
| `AGENT 去砍点树` | 交给 bot 自主行动，让它自己拆解任务（详见 mcbot README） |
| `ACT jump` | 直接调动作：`dig` / `jump` / `pillar` / `wander` / `tp` / `sleep` / `farm` / `trade` / `shoot` / `ride` |
| `MEMDIAG` | 让 bot 打印一次内存体检报告到 `play.log` |

投递走的是 `cmd.txt`：先写临时文件再原子 rename，避免 `play.js` 每 800ms 轮询读到半截指令。上一条还没被取走时会提示"稍等一下"。

## 常见问题

**面板打开一片空白 / 提示"请在管理面板的插件页面中打开"**
装了桥接脚本之外的方式访问不到接口，必须从 AstrBot 管理面板 → 插件页面进入。

**提示"没找到 mcbot 目录"**
检查 `mcbot_dir` 路径，或点面板上的候选目录列表（接口 `/dirs`）看看实际扫到了哪些。

**显示"心跳超时"但进程在跑**
`play.js` 每 60 秒写一条 `alive hp=...` 心跳，超过 180 秒没有新心跳就算假死。看到这个一般说明连接挂了，去翻 `play.log` 尾部的重连日志。

**下发指令提示"bot 还没进服"**
`play.js` 取到 `cmd.txt` 后是**先删文件再判断 ready**，没进服时指令会被静默吞掉。所以面板会提前拦住，等心跳正常再发。

**接口 404**
AstrBot 版本太低，不支持 `register_web_api`。插件日志里会有 `当前 AstrBot 版本不支持 register_web_api` 的警告。

## 安全说明

- 面板接口挂在 AstrBot 自身的鉴权后面，不要在公网暴露管理面板；
- `llm_key` 在面板上只显示头尾各 4 位，落盘权限 `600`；
- 插件只读 mcbot 目录下的文件，写入仅限 `llm.json`、`mc.env`、`cmd.txt`。

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。

## License

AGPL-3.0
