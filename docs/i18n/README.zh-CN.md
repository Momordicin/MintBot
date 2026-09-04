<!-- <p align="center">
  <img src="../../assets/brand/logo.png" width="120" alt="MintBot Logo" />
</p> -->

<h1 align="center">MintBot</h1>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" />
  <img src="https://img.shields.io/badge/status-In%20Development-orange" />
  <img src="https://img.shields.io/github/commit-activity/m/Momordicin/MintBot" />
  <img src="https://img.shields.io/github/last-commit/Momordicin/MintBot" />
</p>

<p align="center"><a href="../../README.md">English</a> | 简体中文</p>

一个运行在本地的 AI 角色伴侣桌面应用。支持自定义角色设定，语音对话，桌面悬浮窗，以及长期记忆。数据完全留在本机，隐私优先。

---

## 功能特性

**对话**
- 与自定义 AI 角色实时对话，"对方输入中"动效 + 完整消息一次性显示，类即时通讯体验
- 消息历史完整留存，支持向上滑动分页加载更早的对话

**桌面悬浮窗**（Phase 3，已实现）
- 聊天窗口最小化 / 关闭后自动切换至独立的透明背景悬浮窗，角色立绘根据情绪标签实时切换（支持 GIF 动图和静态图片）
- 根据当前活跃窗口自动置顶 / 隐藏 / 跳转到其它显示器，全屏白名单与黑名单可配置
- 锁屏 / 息屏时进入静息模式：切换为睡眠立绘、暂停输入监听、保留对话上下文
- 系统托盘后台常驻，双击图标呼出聊天窗口

**语音**（Phase 4，开发中）
- 语音输入（faster-whisper ASR）
- 语音回复（GPT-SoVITS v2，流式合成，首句即播）
- 多段回复：模型输出按句子边界切分推送，模拟真实对话节奏，与流式 TTS 管线配合实现
- 情绪标签指导语音语调

**记忆系统**
- 双轨记忆：近期对话直接注入 context，历史对话 RAG 召回
- bge-m3 向量 embedding，sqlite-vec 本地索引
- 自动摘要压缩，实体聚合
- 情绪状态引擎（Phase 2 基础版）：当前仅实现角色自身（self）情绪的解析与持久化；感知用户情绪（perceived_user）为占位设计，完整的双向情绪模型（self 与 perceived_user 互相影响）为后续规划

**人机交互**（Phase 5 / 6，规划中，尚未实现）
- 本地系统操作：启动应用、调整音量、截图等
- MCP 扩展接口（预留）
- 主动对话调度器：定时、事件、情绪阈值触发

**手机端**（Phase 7，规划中，尚未实现）
- 通过 Cloudflare Tunnel 访问本地服务
- 与桌面端共享会话，实时同步

---

## 技术栈

| 层级 | 技术选型 |
|---|---|
| 桌面框架 | Electron + React |
| 核心服务 | Node.js + Fastify（PM2 守护） |
| 模型调用 | @anthropic-ai/sdk / OpenAI API / Ollama |
| 本地模型 | Ollama（可选，Qwen3 / ChatGLM 等） |
| ASR | faster-whisper（Python HTTP 服务） |
| TTS | GPT-SoVITS v2（Python HTTP 服务） |
| Embedding | bge-m3（Python HTTP 服务） |
| 数据库 | SQLite + sqlite-vec |
| 中文全文检索分词 | libsimple（[wangfenjin/simple](https://github.com/wangfenjin/simple)，预编译动态库 + jieba 词典） |
| Win32 FFI | koffi |
| 配置热生效 | chokidar |

模型调用支持外部 API（Anthropic / OpenAI）和本地 Ollama，由配置文件决定。数据完全留在本机，不依赖任何云端存储。

---

## 开发阶段

- [x] Phase 1：核心对话链路
- [x] Phase 2：记忆系统
- [x] Phase 3：悬浮窗 + 窗口管理
- [ ] Phase 4：语音
- [ ] Phase 5：人机交互工具 + MCP
- [ ] Phase 6：主动对话调度器
- [ ] Phase 7：手机端 + 收尾

---

## 快速开始

> 环境要求和部署文档正在完善中。
> ⚠️ 目前仅支持 Windows，macOS 暂不兼容

**前置依赖**
- Node.js 20+
- pnpm（版本见 `package.json`）
- Python 3.10+
- （可选）Ollama 或 OpenAI / Anthropic API Key 二选一

```bash
# 克隆仓库
git clone https://github.com/Momordicin/MintBot.git
cd MintBot

# 安装依赖
pnpm install

# 下载并还原 SQLite 中文全文检索分词扩展（libsimple，wangfenjin/simple 的预编译动态库 +
# jieba 词典，约 16MB，不提交进仓库）。首次 clone 后运行一次即可，且必须在下面的 pnpm seed /
# 核心服务首次启动之前完成，否则中文全文检索索引初始化会失败
pnpm setup:vendor

# 复制配置文件
cp .env.example .env
cp config.example.json config.json
# 编辑 config.json，填入 API Key 或配置本地 Ollama
# 注意：config.json 里的 security 字段（encryptSensitiveFields / encryptionAlgorithm /
# keyStorage）目前还没有真正接入——是否加密敏感字段实际由 .env 里的 ENCRYPT_SENSITIVE_FIELDS
# 和 DB_ENCRYPTION_KEY 决定，config.json 的这几个字段只是 TDD 里记录的目标设计，尚未生效
# 另外可选加一个 backgroundModelProvider 字段（结构同 modelProvider）：不配置时整理模式
# （摘要生成、实体抽取）沿用 modelProvider 的模型；配置了则用独立模型，方便前台用便宜快的
# 模型、后台摘要/实体抽取用更强的模型
# 若使用 DeepSeek：type 填 "deepseek"，deepseekBaseUrl 留空默认使用 https://api.deepseek.com，
# 模型名用 deepseek-v4-flash / deepseek-v4-pro（DeepSeek 是独立的一等公民 provider 类型，
# 有自己的 deepseekApiKey/deepseekBaseUrl，与 openai 类型的凭据互不共享）

# 初始化数据库（幂等写入测试 preset，首次运行必须执行）
pnpm seed

# 初始化 Python AI 服务的虚拟环境（services/ai，ASR/TTS/Embedding 等本地模型服务）
# 假设本机 PATH 上已有 python 命令（Python 3.10+）；首次 clone 后需要跑一次，
# 之后 requirements.txt 有更新时重新跑一次即可同步依赖。这一步除了装 Python 依赖，
# 还会预先下载 bge-m3 + bert4ner 模型权重（bge-m3 完整仓库约 4.59GB），首次运行视网络
# 情况可能要等一段时间，权重会缓存在本地（~/.cache/huggingface/），之后重跑这一步会很快
pnpm setup:ai

# 启动核心服务（Fastify，独立进程）
# 开发阶段：pnpm dev:core
# 生产环境：先编译再用 pm2 常驻（pnpm start:core 就是 pm2 start ecosystem.config.cjs，
# 依赖 out/core/index.js，跳过 build:core 会直接报错找不到文件）
# 生产环境：Windows 用户首次运行需要管理员权限，之后 pm2 stop mintbot-core; pm2 kill; 最后就可以在普通终端运行了
pnpm build:core
pnpm start:core

# 启动桌面应用（Electron + React）
pnpm dev
```

Python AI 服务（services/ai，ASR / TTS / Embedding 等本地模型服务）由核心服务自动启停：`pnpm start:core` / `pnpm dev:core` 启动核心服务时，如果检测到 AI 服务还没在运行会自动拉起对应的 `.venv` 中的进程，退出核心服务时一并停掉本次由它自己启动的实例，不需要再手动跑 `pnpm dev:ai`。`pnpm dev:ai` 仍然保留，供需要热重载调试 Python 代码时手动启动使用——核心服务检测到它已经在跑就不会重复启动，但也不会在退出时帮你停掉这个手动启动的实例（需要自己 Ctrl+C）。这个"检测到已在运行"的判断依赖两边用同一个端口：`pnpm dev:ai` 目前硬编码 `--port 8765`，不读 `.env` 里的 `AI_PORT`，如果你改了 `AI_PORT` 又想用 `dev:ai` 热重载调试，需要手动把端口对齐，否则核心服务会以为没人在跑而额外启动第二个实例。

---

## 角色配置

角色通过配置文件定义，立绘资源放在 `assets/characters/角色名/` 目录下：

```
assets/characters/my-character/
  ├── manifest.json     # 情绪标签 → 立绘文件映射
  ├── avatar.png        # 聊天窗口头像
  ├── idle.gif
  ├── happy.gif
  └── ...
```

`manifest.json` 示例：

```json
{
  "name": "my-character",
  "version": "1.0",
  "displayName": "显示用名字",
  "description": "角色简介，设置页展示用",
  "tags": ["温柔", "治愈"],
  "avatar": "avatar.png",
  "format": "gif",
  "emotions": {
    "idle":    { "gif": "idle.gif",    "png": "idle.png" },
    "happy":   { "gif": "happy.gif",   "png": "happy.png" },
    "curious": { "gif": "curious.gif", "png": "curious.png" },
    "sleep":   { "gif": "sleep.gif",   "png": "sleep.png" }
  },
  "fallback": "idle",
  "voice": {
    "tts_model": "GPT-SoVITS-v2",
    "reference_audio": "voice_ref.wav",
    "language": "zh"
  }
}
```

---

## 参与贡献

项目目前处于底层架构建设阶段，暂不接受外部 PR。欢迎通过以下方式参与：

- ⭐ Star 关注项目进展
- 🐛 [提交 Issue](https://github.com/Momordicin/MintBot/issues) 反馈 Bug 或建议
- 🍴 Fork 自行修改使用（遵循 AGPL-3.0）

详见 [CONTRIBUTING.md](../../CONTRIBUTING.md)

---

## 隐私说明

- 所有对话数据存储在本地 SQLite，不上传任何服务器
- 使用外部 API（Anthropic / OpenAI）时，对话内容会发送至对应服务商；隐私优先用户建议配置本地 Ollama
- 敏感字段（消息内容、角色设定、实体信息、摘要）支持 AES-256-GCM 字段级加密，可通过配置开关，线上部署时启用
- 加密密钥当前通过环境变量（`.env` 的 `DB_ENCRYPTION_KEY`）读取；由系统密钥链（Windows Credential Manager）托管密钥、不落磁盘明文的方案仍在规划中，尚未实现

---

## 特别鸣谢

**开源项目**

本项目的设计与实现参考了以下开源项目：
- [新世界（Shinsekai）](https://github.com/RachelForster/Shinsekai)
- [Graphiti](https://github.com/getzep/graphiti)
- [Mem0](https://github.com/mem0ai/mem0)
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)
- [ameath](https://gitee.com/lzy-buaa-jdi/ameath)
- [wangfenjin/simple](https://github.com/wangfenjin/simple)（libsimple）—— 本项目 vendor 进来的 SQLite FTS5 中文分词扩展

**表情包与素材**

感谢以下创作者授权/开源传播的表情包素材：
- 爱弥斯表情包 by [Stephen樽](https://space.bilibili.com/5609794)
- 小爱表情包 by [雾雪](https://space.bilibili.com/103739)
- 小爱待机表情包 by [\_BLZ\_](https://space.bilibili.com/2255628)
- 雾雪表情包的分发者 [凉梦喵啦啦啦](https://space.bilibili.com/51460746)

消息栏的发送图标素材来自中国游戏厂商库洛网络旗下游戏《鸣潮》。

**特别感谢**

感谢[《鸣潮》](https://mc.kurogames.com/)、[《重返未来：1999》](https://re.bluepoch.com/home/)、[《NIKKE：胜利女神》](https://nikke-en.com/)，是它们启发我踏上了开发这个项目的旅程，也是支撑我不断把 MintBot 做下去的动力。

---

## 免责声明

本软件开源、免费，任何基于本软件的衍生版本须同样开源。

若您遇到任何商家基于本软件提供付费服务，请注意其修改后的源代码应依 AGPL-3.0 要求公开。由此产生的任何问题与本软件开发者无关。

**生成内容**：本软件的 AI 回复内容由第三方语言模型生成，不代表开发者立场或观点。开发者不对 AI 生成内容的准确性、适当性或任何后果负责。

**角色包版权**：用户自行准备和使用的角色包（包括立绘、语音素材等）的版权责任由用户自行承担。请勿使用未经授权的版权素材。开发者不对用户使用的第三方素材产生的任何版权纠纷负责。

**使用风险**：本软件按现状提供，不附带任何明示或暗示的保证。用户自行承担使用本软件的全部风险。

---

## License

本项目源代码基于 **AGPL-3.0** 协议开源。

`assets/brand/` 目录下的品牌资产（logo、banner 等）**不在 AGPL-3.0 授权范围内**，版权归项目作者所有，未经授权不得使用、复制或分发。

`assets/characters/` 目录仅包含示例说明，实际角色包由用户自行准备。上传或分享角色包时，请确保立绘资产版权清晰，不得使用未经授权的版权素材。

```
assets/
  ├── brand/          # 品牌资产，版权保留，不随代码开源
  │   ├── logo.png
  │   ├── logo.svg
  │   └── COPYRIGHT
  └── characters/     # 角色包目录，用户自行准备，不纳入仓库
```
