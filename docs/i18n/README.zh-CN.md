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

## 为什么选择MintBot

- **桌面上的角色**：聊天窗口和角色悬浮窗独立展示，立绘随角色情绪和用户互动而变化，会无聊、睡着、醒来。
- **无聊时找你互动但不影响你的工作游戏**：遇到全屏游戏、视频、演示或你指定的程序，设置智能避让模式的角色和聊天会自动避让到副屏。
- **记得你**：每个角色有长期记忆，关系和发生过的事会延续到之后的对话里。
- **开口就能说**：本地语音输入，只回应你的声音，解决了跨设备识别困难的问题。
- **模型随你选**：Anthropic、OpenAI、DeepSeek、本地 Ollama，或 Claude Code / Codex 订阅。
- **数据在本地**：对话、记忆和设置都只留在你的电脑上。

## 核心能力一览

| 模块 | 说明 |
|---|---|
| 聊天 | 即时通讯式聊天；角色回复时可以继续发送；完整历史，可向上翻看；每个角色独立的壁纸和主题；常驻系统托盘 |
| 桌宠 | 像素和立绘两种形态，大小可调；情绪立绘（GIF 或静态图）、无聊 / 睡着状态和脚本化转场；可穿透；可收起为一个手柄；在每块屏幕上记住位置 |
| 避让 | 遇到全屏程序或按程序设置的规则，桌宠移到空闲屏幕、贴边或隐藏；聊天窗口置顶可选始终、智能或关闭 |
| 角色 | 新建、切换，或角色卡导入；编辑名字、人设、壁纸和主题；删除角色时连同聊天和记忆一起删除 |
| 记忆 | 近期对话直接进入上下文，更早的对话按需召回；后台生成摘要、提取事实；可浏览记忆，按时间范围删除 |
| 模型 | Anthropic / OpenAI / DeepSeek / Ollama，从实时模型列表中选；对话和后台整理可用不同模型；每个角色可单独设置模型和 Key；可登录 Claude Code / Codex 订阅 |
| 语音输入 | 语音组件一键安装和更新；主人声纹，换麦克风也能识别；识别出的文字进入输入框，不会自动发送；自由测试逐句显示得分和所需的分数 |
| 语音回复 | 规划中（Phase 4）：流式语音合成，按情绪调整语气 |
| 工具与主动对话 | 规划中（Phase 5 / 6）：本地系统操作、MCP、按日程、事件或情绪发起对话 |
| 手机端 | 规划中（Phase 7）：在手机上使用本机服务，与桌面端共享会话 |

---

## 技术栈

| 层级 | 技术选型 |
|---|---|
| 桌面框架 | Electron + React |
| 核心服务 | Node.js + Fastify（独立进程） |
| 模型调用 | Anthropic SDK / OpenAI SDK（OpenAI、DeepSeek）/ Ollama |
| 本地模型 | Ollama（可选，Qwen3 / ChatGLM 等） |
| 语音输入 | [mintbot-voice-agent](https://github.com/Momordicin/mintbot-voice-agent)（本地原生进程：SenseVoiceSmall 语音识别、FSMN-VAD、CAM++ 主人声纹） |
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
- [ ] Phase 4：语音（ASR已完成，TTS调研中）
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

# setup
pnpm setup:vendor

# 复制配置文件
cp .env.example .env
cp config.example.json config.json

# 初始化数据库（幂等写入两个示例角色，首次运行必须执行）
pnpm seed

# 初始化 Python AI 服务的虚拟环境（services/ai，ASR/TTS/Embedding 等本地模型服务）
pnpm setup:ai

# 开发阶段
pnpm dev:all

# 日常使用
pnpm build:all
pnpm start
```

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
- 语音输入在本机处理，不保存音频；识别出的文字和你的声纹保存在本地文件中。语音组件本身在安装或更新时从 GitHub 发布页下载
- 使用外部 API（Anthropic / OpenAI / DeepSeek）时，对话内容会发送至对应服务商；隐私优先用户建议配置本地 Ollama

---

## 特别鸣谢

**开源项目**

本项目作者参与开发, 或参考设计与实现的开源项目：
- [ameath](https://gitee.com/lzy-buaa-jdi/ameath)
- [新世界（Shinsekai）](https://github.com/RachelForster/Shinsekai)
- [Graphiti](https://github.com/getzep/graphiti)
- [Mem0](https://github.com/mem0ai/mem0)
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)
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
