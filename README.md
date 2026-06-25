<!-- <p align="center">
  <img src="assets/brand/logo.png" width="120" alt="MintBot Logo" />
</p> -->

<h1 align="center">MintBot</h1>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" />
  <img src="https://img.shields.io/badge/status-In%20Development-orange" />
  <img src="https://img.shields.io/github/commit-activity/m/Momordicin/MintBot" />
  <img src="https://img.shields.io/github/last-commit/Momordicin/MintBot" />
</p>

一个运行在本地的 AI 角色伴侣桌面应用。支持自定义角色设定，语音对话，桌面悬浮窗，以及长期记忆。数据完全留在本机，隐私优先。

> ⚠️ 目前仅支持 Windows，macOS 暂不兼容

---

## 功能特性

**对话**
- 与自定义 AI 角色实时对话，"对方输入中"动效 + 完整消息一次性显示，类即时通讯体验
- 支持多段回复，模拟真实对话节奏
- 消息历史完整留存

**桌面悬浮窗**
- 聊天窗口最小化后自动切换至桌面悬浮窗，后台常驻
- 根据活跃窗口自动置顶 / 隐藏 / 跳屏
- 角色立绘根据情绪标签实时切换（支持 GIF 动图和静态图片）

**语音**
- 语音输入（faster-whisper ASR）
- 语音回复（GPT-SoVITS v2，流式合成，首句即播）
- 情绪标签指导语音语调

**记忆系统**
- 双轨记忆：近期对话直接注入 context，历史对话 RAG 召回
- BGE-large 向量 embedding，sqlite-vec 本地索引
- 自动摘要压缩，实体聚合
- 双向情绪引擎：角色情绪 + 用户情绪感知

**人机交互**
- 本地系统操作：启动应用、调整音量、截图等
- MCP 扩展接口（预留）
- 主动对话调度器：定时、事件、情绪阈值触发

**手机端**
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
| Embedding | BGE-large（Python HTTP 服务） |
| 数据库 | SQLite + sqlite-vec |
| Win32 FFI | koffi |
| 配置热生效 | chokidar |

模型调用支持外部 API（Anthropic / OpenAI）和本地 Ollama，由配置文件决定。数据完全留在本机，不依赖任何云端存储。

---

## 开发阶段

- [x] Phase 1：核心对话链路（后端完成，React UI 开发中）
- [ ] Phase 2：记忆系统
- [ ] Phase 3：悬浮窗 + 窗口管理
- [ ] Phase 4：语音
- [ ] Phase 5：人机交互工具 + MCP
- [ ] Phase 6：主动对话调度器
- [ ] Phase 7：手机端 + 收尾

---

## 快速开始

> 环境要求和部署文档正在完善中，将在 Phase 1 完成后发布。

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

# 复制配置文件
cp .env.example .env
cp config.example.json config.json
# 编辑 config.json，填入 API Key 或配置本地 Ollama

# 初始化数据库（幂等写入测试 preset，首次运行必须执行）
pnpm seed

# 启动核心服务（Fastify，独立进程）
# 开发阶段：pnpm --filter services/core dev
# 生产环境：pm2 start ecosystem.config.cjs
# 生产环境：Windows 用户首次运行需要管理员权限，之后普通终端即可
pnpm start:core

# 启动桌面应用（Electron + React）
pnpm dev
```

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

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 隐私说明

- 所有对话数据存储在本地 SQLite，不上传任何服务器
- 使用外部 API（Anthropic / OpenAI）时，对话内容会发送至对应服务商；隐私优先用户建议配置本地 Ollama
- 敏感字段（消息内容、API Key）支持 AES-256-GCM 字段级加密
- 本地部署密钥由系统密钥链（Windows Credential Manager）托管，不落磁盘明文

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
