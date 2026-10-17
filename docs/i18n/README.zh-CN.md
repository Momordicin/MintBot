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
- 角色回复期间可以继续发送，消息按顺序依次回复
- 消息历史完整留存，支持向上滑动分页加载更早的对话
- 每个角色可设置壁纸和主题（日间 / 夜间 / 跟随系统，可选强调色）

**桌宠**
- 独立的透明背景桌宠窗口，与聊天窗口并存（二者的显示和避让各自独立，点击桌宠打开聊天窗口）；角色立绘根据情绪标签实时切换（支持 GIF 动图和静态图片）
- 像素与立绘两种形态，可按角色切换，大小可调；有无聊、睡着状态和脚本化转场（被唤醒、被戳）
- 右键菜单：窗口穿透、窗口大小、智能避让、形态切换，以及把桌宠收起为一个手柄
- 避开全屏程序（游戏、全屏视频、演示）和你设了规则的程序（允许 / 让位 / 完全避开）：移到空闲的显示器、贴到屏幕边缘，或隐藏
- 聊天窗口置顶模式：始终 / 智能（按同样的规则避让）/ 关闭
- 在每块显示器上分别记住位置
- 系统托盘后台常驻，双击图标呼出聊天窗口

**语音**（Phase 4，尚未提供）
- 语音输入（faster-whisper ASR）
- 语音回复（GPT-SoVITS v2，流式合成，首句即播）
- 多段回复：模型输出按句子边界切分推送，模拟真实对话节奏，与流式 TTS 管线配合实现
- 情绪标签指导语音语调

**记忆系统**
- 双轨记忆：近期对话直接注入 context，历史对话 RAG 召回
- bge-m3 向量 embedding，sqlite-vec 本地索引，另有中文关键词检索（SQLite FTS5）
- 自动摘要压缩，实体聚合；整理在后台进行，不阻塞对话
- 可按时间范围删除对话，连同从中提取的事实一起删除；删除的内容会从数据库文件中擦除
- 情绪状态引擎（Phase 2 基础版）：当前仅实现角色自身（self）情绪的解析与持久化；感知用户情绪（perceived_user）为占位设计，完整的双向情绪模型（self 与 perceived_user 互相影响）为后续规划

**设置窗口**
- 角色：新建、切换，或从 SillyTavern 角色卡导入；编辑名字、人设、壁纸和主题；删除角色时连同它的全部聊天记录和记忆一起删除
- 模型提供方：Anthropic、OpenAI、DeepSeek 和 Ollama，模型名从各家实时的模型列表里选
- API Key 在 MintBot 里填写（保存后只显示末尾 4 位），也可以勾选使用环境变量 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`
- 对话模型和后台整理模型可分开设置；每个角色可以用全局设置，也可以单独指定模型、API Key 和摘要模型
- 登录你自己的 Claude Code 和 Codex 订阅（全局模型服务 → 订阅登录），由官方命令行打开你的默认浏览器完成登录；MintBot 的登录状态和你平时用的 Claude Code / Codex 分开。
- 记忆管理：浏览角色的消息、提取出的事实和摘要，查看整理进度，按时间范围删除
- 窗口行为：聊天窗口置顶模式、桌宠智能避让和按程序设置的规则

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
| 核心服务 | Node.js + Fastify（独立进程） |
| 模型调用 | Anthropic SDK / OpenAI SDK（OpenAI、DeepSeek）/ Ollama |
| 本地模型 | Ollama（可选，Qwen3 / ChatGLM 等） |
| ASR | faster-whisper（Python HTTP 服务，规划中） |
| TTS | GPT-SoVITS v2（Python HTTP 服务，规划中） |
| Embedding / NER | bge-m3 / bert4ner（Python HTTP 服务） |
| 数据库 | SQLite + sqlite-vec |
| 中文全文检索分词 | libsimple（[wangfenjin/simple](https://github.com/wangfenjin/simple)，预编译动态库 + jieba 词典） |
| Win32 FFI | koffi |
| 配置热生效 | chokidar |

模型调用支持外部 API（Anthropic / OpenAI / DeepSeek）和本地 Ollama，在设置窗口中选择。数据完全留在本机，不依赖任何云端存储。

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
- （可选）Ollama 或 Anthropic / OpenAI / DeepSeek API Key 二选一
- （可选）PATH 上有 `claude` 和/或 `codex` 命令行，用于登录对应的订阅

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
# 示例配置默认使用本地 Ollama。模型提供方、API Key 和模型之后都可以在设置窗口
# （全局模型服务）里修改，不需要手动编辑 config.json。端口默认是 18300（核心服务）、
# 18765（AI 服务）、18173（开发时的渲染进程），可在 .env 中修改

# 初始化数据库（幂等写入两个示例角色，首次运行必须执行）
pnpm seed

# 初始化 Python AI 服务的虚拟环境（services/ai，ASR/TTS/Embedding 等本地模型服务）
# 假设本机 PATH 上已有 python 命令（Python 3.10+）；首次 clone 后需要跑一次，
# 之后 requirements.txt 有更新时重新跑一次即可同步依赖。这一步除了装 Python 依赖，
# 还会预先下载 bge-m3 + bert4ner 模型权重（bge-m3 完整仓库约 4.59GB），首次运行视网络
# 情况可能要等一段时间，权重会缓存在本地（~/.cache/huggingface/），之后重跑这一步会很快
pnpm setup:ai

# 开发阶段：启动核心服务（tsx），待其就绪后再启动桌面应用（Electron + Vite 开发服务器）
pnpm dev:all

# 日常使用：先一次性构建桌面应用和核心服务（修改代码或拉取新代码后需要重新运行），
# 再运行构建后的版本。pnpm start 会启动构建后的核心服务和构建后的 Electron 应用
# （窗口从 app://mintbot/ 加载）；退出应用（托盘“退出”）时核心服务也会一并停止。
# 因为没有开发服务器和开发工具，占用的内存比开发模式更少
pnpm build:all
pnpm start
```

核心服务只接受与自身模式一致的窗口发来的请求：生产模式的核心服务（`pnpm start`）只接受构建后的应用，开发模式的核心服务（`pnpm dev:all`）只接受开发服务器的窗口，所以不要混用两种模式。

Python AI 服务（services/ai，ASR / TTS / Embedding 等本地模型服务）由核心服务自动启停：`pnpm start` / `pnpm dev:all` 启动核心服务时，如果检测到 AI 服务还没在运行会自动拉起对应的 `.venv` 中的进程，退出核心服务时一并停掉本次由它自己启动的实例，不需要再手动跑 `pnpm dev:ai`。`pnpm dev:ai` 仍然保留，供需要热重载调试 Python 代码时手动启动使用——核心服务检测到它已经在跑就不会重复启动，但也不会在退出时帮你停掉这个手动启动的实例（需要自己 Ctrl+C）。这个"检测到已在运行"的判断依赖两边用同一个端口；`pnpm dev:ai` 和核心服务一样从 `.env` 读取 `AI_PORT`，所以两边会保持一致。

---

## 角色配置

角色素材包是 `assets/characters/角色名/` 下的一个文件夹，由其中的 `manifest.json` 描述：

```
assets/characters/my-character/
  ├── manifest.json     # 角色信息、情绪 → 立绘映射、表情包池、转场
  ├── avatar.png        # 聊天窗口和托盘头像
  ├── gifs/             # 像素形态立绘（idle.gif、happy.gif……）
  ├── full-body.png     # 立绘形态素材
  └── emotes/           # 角色可以发送的表情包
```

`manifest.json`（schema 版本 3）包含：

- `name`、`displayName`、`description`、`tags`、`avatar`：角色基本信息
- `emotionVocabulary`：角色可用的情绪标签
- `portraits.pixel` / `portraits.illustration`：两种形态各自的立绘，分别包含 `emotions`（情绪 → 一个或多个文件，随机选取）、`fallback` 默认情绪，以及 `reservedStates`（思考、无聊、睡着等）
- `emotePool`：带标签的表情包
- `transitions`：入睡、唤醒、被戳时的脚本化动画

完整字段示例见 [`assets/characters/example/manifest.json`](../../assets/characters/example/manifest.json)。

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
- API Key 留在本机：全局 Key 存在 `config.json`，角色单独的 Key 存在本地数据库；从环境变量读取的 Key 只在启动时读入，不会保存
- Claude Code / Codex 订阅的登录完全由官方命令行和你的浏览器完成，MintBot 不接触账号和凭据；凭据由命令行保存在 MintBot 自己的本地数据目录里
- 删除的对话会从数据库文件中擦除，无法再从中恢复
- 使用外部 API（Anthropic / OpenAI / DeepSeek）时，对话内容会发送至对应服务商；隐私优先用户建议配置本地 Ollama

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
- 女漂泊者圣诞大头 by [Ah_San](https://www.pixiv.net/users/101403291)

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
