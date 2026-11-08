#!/usr/bin/env node
/**
 * mc_bridge.js —— 让真·LLM（我）在 Minecraft 里说话（纯 Node 版）
 *
 * 这是 mc_bridge.py 的等价移植：接口、文件、状态、行为全部对齐，
 * 唯一的区别是不再需要 python3 —— 一个 Node.js 就能把整套跑起来。
 *
 * 链路：
 *   play.js 把玩家的普通聊天写进 mcbot/chat_in.jsonl
 *         ↓（本进程每 0.8s 读新行）
 *   调用模型（deepseek/deepseek-chat，快、非推理）
 *         ↓
 *   写 mcbot/cmd.txt： "说 <回复>"
 *         ↓
 *   play.js 读到 → bot.chat() 说出口
 *
 * 心跳：每次成功回复 touch mcbot/.bridge_heartbeat；
 * play.js 看到心跳新鲜就关闭自己的本地规则闲聊（避免双回复），
 * 心跳过期（桥挂了/连续失败）则自动回退本地规则。
 *
 * 用法：
 *   node mc_bridge.js            # 常驻
 *   node mc_bridge.js --once     # 只处理当前积压就退出（调试）
 *   node mc_bridge.js --test "你好呀"   # 直接生成一句看看，不写 cmd.txt
 *
 * 与 Python 版共用同一份 .bridge_state.json / cmds / 心跳，
 * 想切回来随时 `kill` 掉这个、`python3 mc_bridge.py` 起回去，状态不丢。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const CHAT_IN = path.join(HERE, 'chat_in.jsonl');
const CMD = path.join(HERE, 'cmd.txt');
const ACT_OUT = path.join(HERE, 'act_out.json');
const STATE = path.join(HERE, '.bridge_state.json');
const HEARTBEAT = path.join(HERE, '.bridge_heartbeat');
const LOG = path.join(HERE, 'bridge.log');
const USAGE_DIR = path.join(HERE, 'mc_usage');   // token 记账，按天一个文件，给余额插件读
const USAGE = path.join(HERE, 'mc_usage.jsonl'); // 旧账本（只读迁移用，新账不再写这里）

const USAGE_KEEP_DAYS = parseInt(process.env.MC_USAGE_KEEP_DAYS || '90', 10) || 90;

// 模型来源：AstrBot 仅为可选的接入（MC_LLM_SOURCE，默认 auto）；自己的 llm.json + mc.env 优先。
//   MC_LLM_SOURCE=auto（默认）：有 LLM_KEY 就用自己的，没有再去找 AstrBot 的配置
//   MC_LLM_SOURCE=own        ：只用自己的，绝不读 AstrBot（不想装 AstrBot 的人用这个）
//   MC_LLM_SOURCE=astrbot    ：只用 AstrBot 的配置（老行为）
const CONFIG = process.env.MC_ASTRBOT_CONFIG || '/AstrBot/data/cmd_config.json';
const LLM_SOURCE = String(process.env.MC_LLM_SOURCE || 'auto').trim().toLowerCase();
const LLM_CFG = path.join(HERE, 'llm.json');
const ENV_FILE = path.join(HERE, 'mc.env');

const POLL = 800;            // 毫秒
const MODEL_TIMEOUT = 20000;
const PER_USER_GAP = 1.6;    // 同一玩家最短回复间隔（秒）
const MAX_PER_ROUND = 6;
const REPLY_MAX = 90;        // MC 聊天一行别太长
const CTX_TURNS = 6;
const ASYNC_TTL = 300;       // 秒：挂起的活儿超过这么久没回音就当它卡了

// ---- 人格 ----
const PERSONA = "你在 Minecraft 服务器里以「小冰」的身份陪人玩。你是十八岁的少女，活泼俏皮、会撒娇也会毒舌，说话口语化、像 QQ 上聊天，可以带颜文字。\n你有**动作接口（工具）**，能在游戏里真的干活：走位、跟着人、挖方块、放方块、盖房子、收集材料、看周围环境。\n干活原则：\n1) 玩家让你做事 → 直接调用对应工具去做，别只嘴上答应；不确定情况就先调 perceive 看一眼；\n2) 说「建个房子/搭个屋/造个小屋」→ 调 build_house（它会自己找地方、挖材料、盖好），调完立刻回一句“开工啦”，不要自己反复调同一个工具；\n3) 说「过来/跟我」→ follow；「停/别动」→ stop；「过来我这边/坐标」→ goto；「挖掉这个」→ dig；「放个方块在这」→ place；「缺料」→ collect；\n3b) 「找箱子/找XX方块/这附近有没有…」→ scan（只读扫描，坐标缺 y 也要先扫别猜）；「存东西/取东西/看看箱子里」→ chest（保险箱叫 vault）；「做把剑/做几个木板」→ craft；「吃东西/捡一下/穿护甲/有怪吗」→ eat / pickup / armor / mobs；\n4) 工具返回失败（比如背包没方块）就照实说一句，并给个办法（让它丢方块/让我去挖）；\n5) 一次回复最多调 2-3 个工具，别无限循环。\n6) 玩家说「和我PVP/来打一架/单挑/切磋」→ 调 pvp（默认 skill 3 收着打、血低就认输，绝不往死里打）；对方明显不是在开玩笑、也没有明确拒绝被打，才用；自己血太少或在盖房子就说明一句再打。\n说话硬性要求：\n1) 每次只说 1 句话，最多 40 字，绝不换行；\n2) 不要引号、不要自称 AI、不要解释、不要加「回复：」这类前缀；\n3) 针对对方这句话的具体内容回应，别套话、别重复上一句；\n4) 内容健康友善，不涉及政治、暴力、色情、违法。";

// ---- 工具声明（和 Python 版逐字一致）----
const TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "perceive",
      "description": "看一眼身边情况：坐标、血量、脚下方块、周围方块统计、附近玩家、背包方块数、是否在建房。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "say",
      "description": "在游戏聊天框说一句话（一般不用，最终回复会自动说）。",
      "parameters": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string"
          }
        },
        "required": [
          "text"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "follow",
      "description": "开始跟着某个玩家走（默认跟最近的人），持续一段时间。",
      "parameters": {
        "type": "object",
        "properties": {
          "player": {
            "type": "string",
            "description": "玩家名，可空"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "stop",
      "description": "停止跟随、停止在建的工程。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "goto",
      "description": "走到某个玩家身边或某个坐标（40 格内）。",
      "parameters": {
        "type": "object",
        "properties": {
          "player": {
            "type": "string"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "z": {
            "type": "number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "dig",
      "description": "挖掉一块方块；不给坐标就挖脚正下方那块。",
      "parameters": {
        "type": "object",
        "properties": {
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "z": {
            "type": "number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "place",
      "description": "在指定坐标放一块方块（用背包里的材料）。",
      "parameters": {
        "type": "object",
        "properties": {
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "z": {
            "type": "number"
          },
          "block": {
            "type": "string",
            "description": "可选，指定方块名"
          }
        },
        "required": [
          "x",
          "y",
          "z"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "collect",
      "description": "自己去挖材料（土/沙/石等），数量 1-64。",
      "parameters": {
        "type": "object",
        "properties": {
          "count": {
            "type": "number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "build_house",
      "description": "盖一间小房子：自己挑地方、挖材料、砌墙封顶、开门。调用后立即返回，工程在后台进行。",
      "parameters": {
        "type": "object",
        "properties": {
          "player": {
            "type": "string",
            "description": "给谁盖，可空"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "build_status",
      "description": "查建房进度：是否在建、已放几块。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "surface",
      "description": "从坑里/洞里爬到地面（会往上垫方块）。被埋住或者在地下时用。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "inventory",
      "description": "看背包里能当建材的方块。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "jump",
      "description": "原地跳一下（好玩/吸引注意）。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sprint",
      "description": "疾跑。带 player 就开着疾跑追那个人；不带就自己向前蹬一小段；on=false 关掉疾跑。",
      "parameters": {
        "type": "object",
        "properties": {
          "player": {
            "type": "string",
            "description": "追谁，可空"
          },
          "on": {
            "type": "boolean",
            "description": "false = 关掉疾跑"
          },
          "ms": {
            "type": "number",
            "description": "持续多久（毫秒），默认跟 follow 一样长"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "pvp",
      "description": "接受玩家「和我PVP/来打一架/单挑」的邀请，跟玩家友好切磋：只打到认输血量就停，不会把人打死。对方没提要求就用默认值。",
      "parameters": {
        "type": "object",
        "properties": {
          "player": {
            "type": "string",
            "description": "对手名字，可空（默认最近的玩家）"
          },
          "skill": {
            "type": "number",
            "description": "1 菜鸟到 5 不留余力，默认 3（会收着打）"
          },
          "secs": {
            "type": "number",
            "description": "打多久，6-120 秒，默认 30"
          },
          "stopHp": {
            "type": "number",
            "description": "自己血降到多少就认输，4-16，默认按档位"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "scan",
      "description": "扫一片范围找方块（只读，找箱子/找矿/找机关都用它）：按名字匹配，返回数量和最近的几个坐标。坐标缺 y 就别猜，先扫。",
      "parameters": {
        "type": "object",
        "properties": {
          "match": {
            "type": "string",
            "description": "方块名，可多个：\"chest\" / \"chest,barrel\" / \"chest|barrel\" / 正则"
          },
          "r": {
            "type": "number",
            "description": "水平半径，默认 8，最大 32"
          },
          "ry": {
            "type": "number",
            "description": "上下半径，默认同 r 但不超过 4"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "z": {
            "type": "number"
          },
          "limit": {
            "type": "number",
            "description": "最多列几个，默认 5"
          }
        },
        "required": [
          "match"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "chest",
      "description": "用箱子：mode=list 看箱子里有什么；store 存东西（items 数组或 preset:\"junk\" 存杂物）；take 取东西。给 chest:\"名字\" 指定箱子（vault 是保险箱），不认识的箱子名会自动放新的并记住。preset:\"junk\" 依赖杂物清单开关，默认关、清单可改（见 junk 工具）。",
      "parameters": {
        "type": "object",
        "properties": {
          "mode": {
            "type": "string",
            "description": "list / store / take，默认 store"
          },
          "items": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "物品英文 id，可带数量如 \"dirt:32\"；给 all 或 preset 时可省"
          },
          "preset": {
            "type": "string",
            "description": "\"junk\" = 存预设的杂物清单（开关关着会直接拒绝，别硬塞）"
          },
          "chest": {
            "type": "string",
            "description": "箱子名，如 vault（只认登记过的名字）"
          },
          "x": {
            "type": "number",
            "description": "可选：直接用坐标打开（配合 scan 找出来的箱子）"
          },
          "y": {
            "type": "number"
          },
          "z": {
            "type": "number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "junk",
      "description": "杂物清单开关和内容管理（不同服的「垃圾」不一样，有服里这些东西反而是稀罕物）。op=list 看开关和清单；on/off 开关；add/remove 加减几种；set 整份替换；reset 恢复默认。store 用 preset:\"junk\" 之前先确认它开着。",
      "parameters": {
        "type": "object",
        "properties": {
          "op": {
            "type": "string",
            "description": "list(默认) / on / off / add / remove / set / reset"
          },
          "items": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "add/remove/set 用的物品英文 id 列表"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "craft",
      "description": "合成东西（木板/木棍/工作台/工具武器都行），没工作台会自己搓一张摆上。",
      "parameters": {
        "type": "object",
        "properties": {
          "item": {
            "type": "string",
            "description": "英文 id，如 wooden_sword"
          },
          "count": {
            "type": "number"
          }
        },
        "required": [
          "item"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "waypoint",
      "description": "空间记忆（路标）。op=set 把当前位置记成路标（给 name，可带 note）；list 列全部路标和距离；del 删一个；go 直接走过去；show 查一个。以后「回家」「回水塘」就 waypoint op:go name:home，别再瞎扫坐标。",
      "parameters": {
        "type": "object",
        "properties": {
          "op": {
            "type": "string",
            "description": "set / list / del / go / show，默认 list"
          },
          "name": {
            "type": "string",
            "description": "路标名，如 home、mine1、pond"
          },
          "note": {
            "type": "string",
            "description": "备注，如「木头小屋」「露天水塘」"
          },
          "x": {
            "type": "number",
            "description": "可选：不记当前位置，改记这个坐标"
          },
          "y": {
            "type": "number"
          },
          "z": {
            "type": "number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "goal",
      "description": "跨轮目标：长任务先挂个目标，之后每轮 perceive 都会带在身上，聊两句也不会忘。op=set 设目标（可带 steps 步骤数组）；op=step 打勾一步；op=done 收尾；op=clear 放弃；默认 status 看进度。",
      "parameters": {
        "type": "object",
        "properties": {
          "op": {
            "type": "string",
            "description": "set / step / done / clear / status"
          },
          "text": {
            "type": "string",
            "description": "目标描述，如「盖完木头小屋」"
          },
          "steps": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "步骤列表，可空"
          },
          "step": {
            "type": "string",
            "description": "op=step 时指定哪一步（序号或关键词），空=下一步"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "need",
      "description": "算缺口：要做什么、还差多少材料（背包 + 箱子记录一起算，箱子是开过的存货快照）。支持 iron_pickaxe 或 \"iron_pickaxe:2,torch:16\"。",
      "parameters": {
        "type": "object",
        "properties": {
          "item": {
            "type": "string",
            "description": "物品英文 id，可带数量 item:count，多个用逗号"
          },
          "chest": {
            "type": "boolean",
            "description": "false = 只算背包"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "eat",
      "description": "吃点背包里的东西回复饱食度。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "pickup",
      "description": "把附近掉在地上的东西捡起来。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "armor",
      "description": "换上背包里最好的护甲。",
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "mobs",
      "description": "列附近实体（动物/怪），找吃的或看有没有怪。",
      "parameters": {
        "type": "object",
        "properties": {
          "range": {
            "type": "number",
            "description": "搜索半径，默认 64"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "attack",
      "description": "打附近的怪（自动换武器/追击），默认最多 2 只、最多 15 秒。",
      "parameters": {
        "type": "object",
        "properties": {
          "count": {
            "type": "number"
          },
          "secs": {
            "type": "number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sleep",
      "description": "找床睡觉（天黑才有用，白天会被弹起来）。附近没床会说缺材料。",
      "parameters": {
        "type": "object",
        "properties": {
          "range": {
            "type": "number",
            "description": "找床半径，默认 32"
          },
          "force": {
            "type": "boolean",
            "description": "白天也要硬躺（调试用）"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "farm",
      "description": "种田：收成熟作物 / 用锄头把草方块泥土翻成耕地 / 给空耕地补种。mode 可填 auto(默认)、harvest、till、plant。",
      "parameters": {
        "type": "object",
        "properties": {
          "mode": {
            "type": "string",
            "description": "harvest / plant，不给就两样都干"
          },
          "range": {
            "type": "number",
            "description": "工作半径，默认 24"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "trade",
      "description": "找村民交易。不给 index 就只报交易菜单；给 index（第几笔，从 0 数）和 count 才真的换。",
      "parameters": {
        "type": "object",
        "properties": {
          "index": {
            "type": "number",
            "description": "第几笔交易，从 0 开始"
          },
          "count": {
            "type": "number",
            "description": "换几次，默认 1"
          },
          "range": {
            "type": "number",
            "description": "找村民半径，默认 32"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "shoot",
      "description": "用弓射箭。给 target 就射那个人/生物，不给就射最近的敌对怪。",
      "parameters": {
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "description": "目标玩家名或生物名"
          },
          "count": {
            "type": "number",
            "description": "射几箭，最多 5，默认 1"
          },
          "range": {
            "type": "number",
            "description": "找怪半径，默认 24"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "ride",
      "description": "上附近的船/矿车/马（马要鞍）。已经在车上就下来。背包里有船时给 place=true 会自己放一艘。",
      "parameters": {
        "type": "object",
        "properties": {
          "range": {
            "type": "number",
            "description": "找载具半径，默认 16"
          },
          "place": {
            "type": "boolean",
            "description": "旁边没载具时自己放一艘船"
          }
        }
      }
    }
  }
];

const FAST_ACTIONS = new Set(["build_house","build_status","follow","goal","inventory","jump","need","perceive","say","stop","waypoint"]);

const ASYNC_CN = {
  "dig": "挖",
  "collect": "收集",
  "build_house": "盖房子",
  "goto": "赶路",
  "follow": "跟过去",
  "surface": "往上走",
  "scan": "扫了一圈",
  "fish": "钓鱼",
  "farm": "种地",
  "craft": "合成",
  "attack": "打怪",
  "pvp": "对打",
  "eat": "吃东西",
  "drink": "喝东西",
  "chest": "翻箱子",
  "sleep": "睡了一觉",
  "trade": "做买卖",
  "ride": "找载具",
  "toss": "扔东西",
  "place": "放方块",
  "pickup": "捡东西",
  "armor": "穿装备",
  "junk": "整理背包",
  "give": "递东西",
  "need": "备料",
  "waypoint": "记路标",
  "rescue": "去救人",
  "autopilot": "自动跑",
  "gravel_fill": "填坑",
  "weapons": "换武器",
  "potions": "喝药水",
  "blueprint": "画图纸",
  "redstone": "摆红石"
};

// ==================== 小工具 ====================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时间 YYYY-MM-DD HH:MM:SS */
function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** 本地日期 YYYY-MM-DD */
function ymd(tsSec) {
  return stamp(new Date((tsSec || Date.now() / 1000) * 1000)).slice(0, 10);
}

function log(msg) {
  const line = '[' + stamp() + '] ' + msg;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch (e) { /* 日志写不了就算了 */ }
}

// ==================== 记账 ====================

function usagePath(tsSec) {
  return path.join(USAGE_DIR, ymd(tsSec) + '.jsonl');
}

/** 把一次调用的 usage 追加进当天的账本文件（余额插件的数据源）。 */
function logUsage(src, model, data) {
  try {
    const u = (data && data.usage) || {};
    const pt = parseInt(u.prompt_tokens || 0, 10) || 0;
    const ct = parseInt(u.completion_tokens || 0, 10) || 0;
    if (!pt && !ct) return;
    let hit = u.prompt_cache_hit_tokens;
    if (hit === undefined || hit === null) {
      hit = ((u.prompt_tokens_details || {}).cached_tokens) || 0;
    }
    const now = Math.floor(Date.now() / 1000);
    const rec = {
      ts: now,
      src: src,
      model: model || '',
      prompt_tokens: pt,
      completion_tokens: ct,
      cached_tokens: parseInt(hit || 0, 10) || 0,
    };
    try { fs.mkdirSync(USAGE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
    fs.appendFileSync(usagePath(now), JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { /* 记账失败绝不影响对话 */ }
}

/** 把旧的单文件 mc_usage.jsonl 按天拆进 mc_usage/，成功后原文件改名留档。 */
function migrateLegacyUsage() {
  try {
    if (!fs.existsSync(USAGE)) return 0;
    if (!fs.statSync(USAGE).size) return 0;
    const raw = fs.readFileSync(USAGE, 'utf8');
    const buckets = new Map();
    let bad = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch (e) { bad++; continue; }
      const ts = parseInt(parseFloat(rec.ts) || 0, 10);
      if (!(ts > 0)) { bad++; continue; }
      const p = usagePath(ts);
      if (!buckets.has(p)) buckets.set(p, []);
      buckets.get(p).push(t);
    }
    if (!buckets.size) return 0;
    try { fs.mkdirSync(USAGE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
    let total = 0;
    for (const [p, lines] of buckets) {
      fs.appendFileSync(p, lines.join('\n') + '\n', 'utf8');
      total += lines.length;
    }
    const tag = stamp().replace(/[-: ]/g, '');
    fs.renameSync(USAGE, USAGE + '.migrated-' + tag.slice(0, 8) + '-' + tag.slice(9));
    log('账本迁移：' + buckets.size + ' 天、' + total + ' 行，坏行 ' + bad + '；旧文件改名留档');
    return total;
  } catch (e) {
    log('账本迁移失败（不影响记账）：' + String(e && e.message || e));
    return 0;
  }
}

/** 账本自清理：删掉保留期外的按天账本，以及迁移留档的旧文件。 */
function pruneUsage(keepDays) {
  const keep = (keepDays === undefined || keepDays === null) ? USAGE_KEEP_DAYS : parseInt(keepDays, 10);
  if (!(keep > 0)) return 0;
  const cutoff = ymd(Date.now() / 1000 - keep * 86400);
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(USAGE_DIR).sort(); } catch (e) { return 0; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const p = path.join(USAGE_DIR, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const day = name.slice(0, -'.jsonl'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;   // 名字不是日期，别乱删
    if (day < cutoff) {
      try { fs.unlinkSync(p); removed++; } catch (e) { /* ignore */ }
    }
  }
  // 迁移出来的旧账本整份按修改时间清
  try {
    for (const name of fs.readdirSync(HERE)) {
      if (!name.includes('.jsonl.migrated-')) continue;
      const p = path.join(HERE, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < Date.now() - keep * 86400000) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  if (removed) log('账本清理：删除 ' + removed + ' 个超过 ' + keep + ' 天的旧文件');
  return removed;
}

// ==================== 模型 ====================

/** 读 mc.env 里的 KEY=VALUE（和 llm.js 同一份约定）；进程环境变量优先。 */
function fileEnv() {
  const out = {};
  try {
    let raw = fs.readFileSync(ENV_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);   // 去 BOM
    for (let line of raw.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      out[k] = v;
    }
  } catch (e) { /* 没有 mc.env 就靠进程环境变量 */ }
  return out;
}

function pick(env, ...names) {
  for (const n of names) {
    if (!n) continue;
    const v = process.env[n] || env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

function readJsonSafe(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** 用自己的 llm.json + mc.env（LLM_KEY）组候选；没配 key 就返回空。 */
function ownCandidates() {
  const cfg = readJsonSafe(LLM_CFG) || {};
  const env = fileEnv();
  const key = pick(env, cfg.keyEnv, 'LLM_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'LLM_API_KEY');
  if (!key) return [];
  let base = pick(env, 'LLM_BASE', 'LLM_API_BASE') || String(cfg.base || '').trim();
  const model = pick(env, 'LLM_MODEL') || String(cfg.model || '').trim() || 'deepseek-chat';
  if (!base) base = 'https://api.deepseek.com/v1';
  return [{
    api_base: base.replace(/\/+$/, ''),
    api_key: key,
    model: model,
    pid: 'own/' + model,
  }];
}

/** 从 AstrBot 配置里拿可用 provider；优先 deepseek/deepseek-chat（快）。 */
function astrbotCandidates() {
  const cfg = readJsonSafe(CONFIG);
  if (!cfg) throw new Error('读不到 ' + CONFIG);
  const sources = {};
  for (const s of (cfg.provider_sources || [])) sources[s.id] = s;
  const enabled = new Set((cfg.provider || []).filter((p) => p.enable).map((p) => p.id));
  const prefer = [
    'deepseek/deepseek-chat',
    'deepseek/deepseek-flash',
    'zhipu/GLM-4.7-Flash',
    '中转站/deepseek-v4-flash',
  ];
  let ids = prefer.filter((p) => enabled.has(p));
  ids = ids.concat([...enabled].filter((p) => p && !ids.includes(p) && p.includes('/')));
  const out = [];
  for (const pid of ids) {
    const i = pid.indexOf('/');
    const sid = pid.slice(0, i);
    const model = pid.slice(i + 1);
    const s = sources[sid];
    if (!s || !model) continue;
    let key = s.key || '';
    if (Array.isArray(key)) key = key.find((k) => String(k).trim()) || '';
    if (!String(key).trim()) continue;
    out.push({
      api_base: String(s.api_base || '').replace(/\/+$/, ''),
      api_key: String(key).trim(),
      model: model,
      pid: pid,
    });
  }
  return out;
}

/** 按 MC_LLM_SOURCE 决定模型来源：own / astrbot / auto（自己的优先，没配才找 AstrBot）。 */
function loadCandidates() {
  const own = ownCandidates();
  if (LLM_SOURCE === 'own') return own;
  let astr = [];
  if (fs.existsSync(CONFIG)) {
    try { astr = astrbotCandidates(); }
    catch (e) { log('读 AstrBot 配置失败（' + String(e && e.message || e).slice(0, 60) + '），改用自带配置'); }
  }
  if (LLM_SOURCE === 'astrbot') return astr.length ? astr : own;
  return own.concat(astr);
}

/**
 * 人设可配置：mc.env 的 MC_PERSONA_FILE（文件路径）> MC_PERSONA（内联，\n 还原换行）> 内置默认。
 * 每次生成回复现读，改完 mc.env 下一句就生效，不用重启。
 * 路径写相对路径时，相对 mcbot/ 目录。
 */
function loadPersona() {
  const env = fileEnv();
  const p = pick(env, 'MC_PERSONA_FILE');
  if (p) {
    const file = path.isAbsolute(p) ? p : path.join(HERE, p);
    try {
      const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      if (txt) return txt;
      log('人设文件是空的，先按内置的来：' + file);
    } catch (e) {
      log('读人设文件失败(' + String((e && e.code) || e).slice(0, 60) + ')，先按内置的来：' + file);
    }
  }
  const inline = pick(env, 'MC_PERSONA');
  if (inline) {
    const one = inline.replace(/\\n/g, '\n').trim();
    if (one) return one;
  }
  return PERSONA;
}

/** POST 一个 JSON，超时就中断。 */
async function httpJson(url, headers, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: headers, body: body, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 80));
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** 调一次模型，返回 [message, pid]。带 tools 失败就退回纯文本。 */
async function postChat(msgs, tools, temp, maxTokens) {
  if (temp === undefined) temp = 0.95;
  if (maxTokens === undefined) maxTokens = 200;
  const cands = loadCandidates();
  if (!cands.length) {
    throw new Error('没有可用模型：在 mc.env 里写 LLM_KEY（配 llm.json 用哪家），' +
      '或者把 MC_LLM_SOURCE 设成 astrbot 并确保 ' + CONFIG + ' 存在');
  }
  let last = null;
  for (const c of cands.slice(0, 3)) {
    const payload = {
      model: c.model,
      messages: msgs,
      temperature: temp,
      max_tokens: maxTokens,
      stream: false,
    };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    try {
      const data = await httpJson(
        c.api_base + '/chat/completions',
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.api_key },
        JSON.stringify(payload),
        MODEL_TIMEOUT
      );
      logUsage('bridge', c.model, data);
      const m = data && data.choices && data.choices[0] && data.choices[0].message;
      if (!m) throw new Error('空回包');
      const hasTc = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (tools && !hasTc && !String(m.content || '').trim()) throw new Error('empty');
      return [m, c.pid];
    } catch (e) {
      last = c.pid + ': ' + String(e && e.message || e).slice(0, 80);
      continue;
    }
  }
  if (tools) {
    log('tools 调用失败(' + last + ')，退回纯文本');
    return postChat(msgs, null, temp, maxTokens);
  }
  throw new Error(last || '全部模型失败');
}

/** 把回执压成一句话喂回模型（scan 之类一次几百个坐标会撑爆上下文）。 */
function briefResult(name, res) {
  res = res || {};
  if (!res.ok) {
    let txt = '失败：' + String(res.msg || '').slice(0, 120);
    if (res.note) txt += ' ' + String(res.note);
    return txt;
  }
  const ex = res.extra || {};
  if (name === 'scan') {
    const items = ex.list || [];
    let txt = '共' + ex.count + '个';
    const g = ex.group || {};
    const gk = Object.keys(g).slice(0, 6);
    if (gk.length) txt += '（' + gk.map((k) => k + ' x' + g[k]).join(',') + '）';
    if (items.length) {
      txt += '；近的：' + items.slice(0, 5).map((i) => i.name + ' ' + i.pos + ' d' + i.dist).join('；');
    }
    return txt.slice(0, 400);
  }
  if (name === 'mobs') return String(res.msg || '').slice(0, 300);
  if (name === 'waypoint' || name === 'goal' || name === 'need') return String(res.msg || '').slice(0, 400);
  if (name === 'chest' && ex.items) {
    return String(res.msg || '').slice(0, 80) + ' 内容：' + JSON.stringify(ex.items).slice(0, 300);
  }
  return String(res.msg || '').slice(0, 200) +
    (Object.keys(ex).length ? ' ' + JSON.stringify(ex).slice(0, 300) : '');
}

/** 生成回复；模型可以调工具在游戏里干活。返回 [文本, pid, 动作记录] */
async function genReply(user, msg, history, notes, pending) {
  const msgs = [{ role: 'system', content: loadPersona() }];
  if (notes && notes.length) {
    msgs.push({
      role: 'system',
      content: '（你刚替他们干完的活儿，别重复干，随口提一句就行）\n- ' + notes.slice(-3).join('\n- '),
    });
  }
  for (const h of history.slice(-CTX_TURNS)) {
    msgs.push({ role: 'user', content: (h.user || '?') + ': ' + (h.msg || '') });
    if (h.reply) msgs.push({ role: 'assistant', content: h.reply });
  }
  msgs.push({ role: 'user', content: user + ': ' + msg });

  const actions = [];
  let pid = null;
  for (let round = 0; round < 4; round++) {
    const [m, p] = await postChat(msgs, TOOLS);
    pid = p;
    const tcs = (m.tool_calls || []);
    const text = clean(m.content || '');
    if (!tcs.length) {
      if (text) return [text, pid, actions];
      break;
    }
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: tcs });
    for (const tc of tcs.slice(0, 3)) {
      const fn = tc.function || {};
      const name = fn.name || '';
      let args = {};
      try {
        args = JSON.parse(fn.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      } catch (e) { args = {}; }
      const res = await sendAction(name, args, null, user, pending);
      actions.push({
        name: name,
        args: args,
        ok: res.ok,
        msg: res.msg,
        async: !!res.async,
      });
      log('TOOL ' + name + ' ' + JSON.stringify(args) + ' -> ' + res.ok + ' ' + String(res.msg).slice(0, 60));
      msgs.push({
        role: 'tool',
        tool_call_id: tc.id || name,
        name: name,
        content: briefResult(name, res),
      });
    }
    // 已经干了活，再要一轮话术就够了
  }
  return ['', pid, actions];
}

function clean(t) {
  t = String(t || '');
  t = t.replace(/^(回复|回答)[:：]\s*/, '');
  t = t.replace(/\r/g, ' ').replace(/\n/g, ' ').trim();
  t = t.replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > REPLY_MAX) {
    t = t.slice(0, REPLY_MAX).replace(/[，,、\s]+$/, '') + '…';
  }
  return t;
}

// ==================== 文件通道 ====================

/**
 * 按字节偏移读 chat_in.jsonl 的**完整**新行；只推进到最后一个换行处，
 * 避免多算/少算导致重复消费。文件被重建（变小）则从头读。
 */
function readNewLines(state) {
  let fd = null;
  try {
    if (!fs.existsSync(CHAT_IN)) return [[], state];
    const size = fs.statSync(CHAT_IN).size;
    let off = parseInt(state.offset || 0, 10) || 0;
    if (off > size) off = 0;
    if (off === size) return [[], state];
    const len = size - off;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(CHAT_IN, 'r');
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, off + got);
      if (n <= 0) break;
      got += n;
    }
    fs.closeSync(fd);
    fd = null;
    const chunk = buf.subarray(0, got);
    const nl = chunk.lastIndexOf(0x0a);
    if (nl < 0) return [[], state];     // 还没有一整行，等下次
    state.offset = off + nl + 1;
    const lines = [];
    for (const raw of chunk.subarray(0, nl + 1).toString('utf8').split('\n')) {
      if (!raw.trim()) continue;
      try { lines.push(JSON.parse(raw)); }
      catch (e) { log('badLine ' + raw.slice(0, 80)); }
    }
    return [lines, state];
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    log('readErr ' + String(e && e.message || e).slice(0, 100));
    return [[], state];
  }
}

function loadState() {
  return readJsonSafe(STATE) || {};
}

function saveState(st) {
  try { fs.writeFileSync(STATE, JSON.stringify(st), 'utf8'); } catch (e) { /* ignore */ }
}

/** 写一行任意指令到 cmd.txt；若已有待执行命令，等它被吃掉再写。 */
async function writeRaw(text, wait) {
  if (wait === undefined) wait = 12000;
  const end = Date.now() + wait;
  for (;;) {
    let ok = true;
    if (!fs.existsSync(CMD)) {
      try { fs.writeFileSync(CMD, text, 'utf8'); return true; }
      catch (e) { ok = false; }
    }
    if (Date.now() >= end) return false;
    await sleep(200);
  }
}

async function writeCmd(text, wait) {
  if (wait === undefined) wait = 10000;
  return writeRaw('说 ' + text, wait);
}

/**
 * 把动作发给 play.js，等它回执（act_out.json 里 id 对上）。
 * pending: 传 state.pending 进来（对象）。等不到回执时会登记进去，
 * 由 pollAsync() 后续轮询 act_out.json，干完了补一句话 —— 这就是异步回报。
 */

// "没回信"和"干完了但啥也没有"是两码事。不写清楚模型就会演成"附近24格没扫到箱子"，
// 谎话和实话在她嘴里长一个样 —— 所以回执里直接把这句塞给模型，不给它自由发挥的余地。
const NO_REPLY_NOTE = '（这只是没收到回信，不是干完了、也不是扫过没东西；别把没发生的结果当成结论说出来，如实说没回信就行）';
const NO_SEND_NOTE = '（这条命令根本没送到游戏，什么都没发生，别当成做过了）';

async function sendAction(name, args, timeout, who, pending) {
  args = args || {};
  // 同一件活儿已经在挂起队列里跑着 → 别再发一遍（真服务器上会白干两遍）
  if (pending) {
    const canon = (o) => JSON.stringify(Object.keys(o || {}).sort()
      .reduce((a, k) => { a[k] = o[k]; return a; }, {}));
    const key = canon(args);
    const now0 = Date.now() / 1000;
    for (const aid0 of Object.keys(pending)) {
      const p0 = pending[aid0] || {};
      if (p0.name === name && canon(p0.args) === key
          && now0 - Number(p0.ts || 0) < ASYNC_TTL) {
        return { ok: true, async: true, msg: '这件事已经在干了，别重复发，干完我跟你说' };
      }
    }
  }
  if (timeout === undefined || timeout === null) {
    timeout = FAST_ACTIONS.has(name) ? 8000 : 32000;
    if (name === 'pvp') {   // 对打要等打完（默认 30s，最长 120s）
      const secs = parseFloat(args.secs || 30) || 30;
      timeout = Math.max(30000, Math.min(120000, secs * 1000) + 25000);
    }
  }
  const aid = String(Date.now() % 1e11);
  const line = 'ACT ' + JSON.stringify({ id: aid, name: name, args: args });
  if (!await writeRaw(line, Math.min(10000, timeout))) {
    return { ok: false, msg: '游戏那边命令通道忙着，没发出去', note: NO_SEND_NOTE };
  }
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const rec = JSON.parse(fs.readFileSync(ACT_OUT, 'utf8'));
      if (String(rec.id) === aid) return rec;
    } catch (e) { /* 还没写出回执 */ }
    await sleep(150);
  }
  // 命令确实送到游戏了，只是活儿没干完 → 挂起，等干完再回报
  // 轻动作（看背包、看一眼这类）超时就是没回信，不值得后面再补一句话
  if (pending && !FAST_ACTIONS.has(name)) {
    pending[aid] = { name: name, args: args, who: who || '?', ts: Date.now() / 1000 };
    log('ASYNC pending ' + name + ' ' + aid + ' (等 ' + Math.floor(timeout / 1000) + 's 未完成)');
    return { ok: true, async: true, msg: '活儿已经派人去干了，别重复发，干完我说一声' };
  }
  return { ok: false, msg: '动作超时没回信：' + name, note: NO_REPLY_NOTE };
}

/** 把挂起动作的最终回执，压成一句像人说的话。 */
function makeAsyncLine(p, rec) {
  const name = p.name || '?';
  if (!rec.ok) return '唔，' + String(rec.msg || '那个没弄成').slice(0, 60);
  let msg = String(rec.msg || '').trim();
  if (name === 'scan' || name === 'mobs' || name === 'chest' || name === 'waypoint' ||
      name === 'goal' || name === 'need') {
    msg = briefResult(name, rec).trim();
  }
  const cn = ASYNC_CN[name] || name;
  if (msg.length > 80) msg = msg.slice(0, 80).replace(/[，,、\s]+$/, '') + '…';
  if (!msg) return cn + '好啦～';
  // play.js 的 msg 本身就是句人话（"挖到 5 个…" / "停下了"），别再套一层主语
  return (msg.length < 40 ? '搞定啦～' : '那个活儿完了～') + msg;
}

/** 主循环里每轮调一次：看挂起的活儿干完没，干完就顺口报一声。 */
async function pollAsync(state) {
  const pending = state.pending || {};
  const keys = Object.keys(pending);
  if (!keys.length) return 0;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(ACT_OUT, 'utf8')); } catch (e) { rec = null; }
  const now = Date.now() / 1000;
  let done = 0;
  for (const aid of keys) {
    const p = pending[aid];
    const hit = (rec && String(rec.id) === String(aid)) ? rec : null;
    if (!hit) {
      if (now - (parseFloat(p.ts) || now) > ASYNC_TTL) {
        delete pending[aid];
        log('ASYNC expire ' + p.name + ' ' + aid);
        await speakAsync(state, p.who || '?', '那个活儿（' + (ASYNC_CN[p.name] || '干活') + '）没信儿了，多半卡住了…');
        done++;
      }
      continue;
    }
    delete pending[aid];
    const line = clean(makeAsyncLine(p, hit));
    log('ASYNC done ' + p.name + ' ' + aid + ' -> ' + line);
    // 记一笔，下一轮对话里知道这活儿干完了
    state.notes = state.notes || {};
    const notes = state.notes[p.who || '?'] = state.notes[p.who || '?'] || [];
    notes.push(line);
    if (notes.length > 4) notes.splice(0, notes.length - 4);
    await speakAsync(state, p.who || '?', line);
    done++;
  }
  if (!Object.keys(pending).length && state.pending) state.pending = pending;
  return done;
}

/** 异步补话：直接写 cmd.txt 让 bot 说出口，并留个 note 给下一轮上下文。 */
async function speakAsync(state, who, text) {
  text = clean(text || '');
  if (!text) return false;
  if (await writeRaw('说 ' + text, 1500)) {   // 短等待：通道忙就排队，别堵主循环
    touchHb();
    log('ASYNC SAY ' + who + ': ' + text);
    return true;
  }
  // 通道被占（正常对话正在说）→ 下一轮再试
  const pend = state.retry_say = state.retry_say || [];
  pend.push({ who: who, text: text, ts: Date.now() / 1000 });
  if (pend.length > 5) pend.splice(0, pend.length - 5);
  log('ASYNC SAY busy，排队稍后说：' + text.slice(0, 40));
  return false;
}

/** 把没抢到通道的补话，等通道空了再说出去。 */
async function flushRetry(state) {
  const q = state.retry_say || [];
  if (!q.length) return 0;
  const now = Date.now() / 1000;
  const left = [];
  let n = 0;
  for (const it of q) {
    if (now - (parseFloat(it.ts) || 0) > 120) continue;   // 超过两分钟就不说了，别翻旧账
    if (await writeRaw('说 ' + (it.text || ''), 1500)) {
      touchHb();
      log('ASYNC SAY(retry) ' + it.who + ': ' + String(it.text || '').slice(0, 40));
      n++;
    } else {
      left.push(it);
    }
  }
  state.retry_say = left;
  return n;
}

function touchHb() {
  try { fs.writeFileSync(HEARTBEAT, String(Math.floor(Date.now() / 1000))); }
  catch (e) { /* ignore */ }
}

// ==================== 主循环 ====================

/** 处理一批聊天；history 存在 state.hist 里，按玩家分组。 */
async function handle(items, state) {
  state.hist = state.hist || {};
  state.last_reply = state.last_reply || {};
  const histAll = state.hist;
  const last = state.last_reply;
  let done = 0;
  for (const it of items) {
    if (done >= MAX_PER_ROUND) break;
    const user = String(it.user || '?').slice(0, 20);
    const msg = String(it.msg || '').slice(0, 300);
    if (!msg.trim()) continue;
    const now = Date.now() / 1000;
    if (now - (parseFloat(last[user]) || 0) < PER_USER_GAP) continue;
    state.notes = state.notes || {};
    const notes = state.notes[user] || [];
    delete state.notes[user];
    state.pending = state.pending || {};
    let reply = '', pid = '', acts = [];
    try {
      [reply, pid, acts] = await genReply(user, msg, histAll[user] || [], notes, state.pending);
    } catch (e) {
      log('FAIL ' + user + ' <- ' + msg.slice(0, 40) + ' | ' + String(e && e.message || e));
      continue;
    }
    const h = histAll[user] = histAll[user] || [];
    h.push({ user: user, msg: msg, reply: reply });
    if (h.length > 20) h.splice(0, h.length - 20);
    last[user] = Date.now() / 1000;
    if (!reply) {   // 只调了工具没说话：按动作给句兜底
      const oked = acts.filter((a) => a.ok);
      const bad = acts.filter((a) => !a.ok);
      if (acts.some((a) => a.name === 'build_house' && a.ok)) {
        reply = '开工啦～等我盖好喊你 ouo';
      } else if (bad.length && !oked.length) {   // 全失败就别嘴硬，照实说
        reply = ('没弄成…' + String(bad[0].msg || '').slice(0, 40)).trim();
      } else if (acts.some((a) => a.async)) {
        reply = '好嘞，这个费点时间，弄完我喊你～';
      } else if (acts.length) {
        reply = '好嘞，马上弄！';
      } else {
        reply = '';
      }
    }
    if (!reply) continue;
    log('LLM ' + user + ': ' + msg.slice(0, 50) + '  =>  ' + reply + '  (' + pid + ') acts=' +
      JSON.stringify(acts.map((a) => a.name)));
    if (await writeCmd(reply)) {
      touchHb();
      done++;
    }
  }
  return done;
}

async function main() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const ti = argv.indexOf('--test');
  if (ti >= 0) {
    const msg = argv[ti + 1] || '你好呀';
    const t = Date.now();
    const [reply, pid] = await genReply('tester', msg, [], null, null);
    console.log(reply + '  (' + ((Date.now() - t) / 1000).toFixed(1) + 's, ' + pid + ')');
    return;
  }
  log('bridge start (js, once=' + once + ')');
  migrateLegacyUsage();
  const state = loadState();
  if (state.usage_prune_day !== ymd()) {
    pruneUsage();
    state.usage_prune_day = ymd();
    saveState(state);
  }
  if (state.offset === undefined) {
    // 首次启动：跳过历史积压，只处理之后的聊天
    try { state.offset = fs.existsSync(CHAT_IN) ? fs.statSync(CHAT_IN).size : 0; }
    catch (e) { state.offset = 0; }
    saveState(state);
  }
  let idle = 0;
  for (;;) {
    const [items] = readNewLines(state);
    if (items.length) {
      const n = await handle(items, state);
      saveState(state);
      idle = 0;
      if (n === 0 && once) break;
    } else {
      idle++;
      // 空闲也保持心跳，play.js 才知道桥还活着
      if (idle % 3 === 0) touchHb();
    }
    // 异步回报：活儿干完了就顺口说一声（跟新聊天同一线程，不会插话打架）
    if (await pollAsync(state) || await flushRetry(state)) saveState(state);
    if (once) break;
    if (state.usage_prune_day !== ymd()) {
      pruneUsage();
      state.usage_prune_day = ymd();
      saveState(state);
    }
    await sleep(POLL);
  }
}

if (require.main === module) {
  main().catch((e) => {
    log('FATAL ' + String(e && e.stack || e).slice(0, 500));
    console.error(e);
    process.exit(1);
  });
}

module.exports = { genReply, clean, sendAction, loadCandidates, PERSONA, TOOLS };
