# MintBot

一个运行在本地的 AI 角色伴侣桌面应用。支持自定义角色设定，语音对话，桌面悬浮窗，以及长期记忆。数据完全留在本机，隐私优先。

> 项目正在开发中，当前处于 Phase 1。

---

## 功能特性

**对话**
- 与自定义 AI 角色实时对话，SSE 流式输出
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

- [ ] Phase 1：核心对话链路
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
- Python 3.10+
- （可选）Ollama 或 OpenAI / Anthropic API Key 二选一

```bash
# 克隆仓库
git clone https://github.com/Momordicin/MintBot.git
cd MintBot

# 安装依赖
npm install

# 复制配置文件
cp .env.example .env
cp config.example.json config.json
# 编辑 config.json，填入 API Key 或配置本地 Ollama

# 启动
npm run dev
```

---

## 角色配置

角色通过配置文件定义，立绘资源放在 `assets/characters/角色名/` 目录下：

```
assets/characters/my-character/
  ├── manifest.json     # 情绪标签 → 立绘文件映射
  ├── idle.gif
  ├── happy.gif
  └── ...
```

`manifest.json` 示例：

```json
{
  "name": "my-character",
  "format": "gif",
  "emotions": {
    "idle":    { "gif": "idle.gif",    "png": "idle.png" },
    "happy":   { "gif": "happy.gif",   "png": "happy.png" },
    "curious": { "gif": "curious.gif", "png": "curious.png" },
    "sleep":   { "gif": "sleep.gif",   "png": "sleep.png" }
  },
  "fallback": "idle"
}
```

---

## 隐私说明

- 所有对话数据存储在本地 SQLite，不上传任何服务器
- 使用外部 API（Anthropic / OpenAI）时，对话内容会发送至对应服务商；隐私优先用户建议配置本地 Ollama
- 敏感字段（消息内容、API Key）支持 AES-256-GCM 字段级加密
- 本地部署密钥由系统密钥链（Windows Credential Manager）托管，不落磁盘明文

---

## 致谢

设计过程中参考了 [Witsy](https://github.com/nbonamy/witsy)、[Jan.ai](https://github.com/janhq/jan)、[Shinsekai](https://github.com/RachelForster/Shinsekai)、[Open WebUI](https://github.com/open-webui/open-webui) 等开源项目的架构思路。

---

## 免责声明

本软件开源、免费，仅供学习、交流与个人使用。

**生成内容**：本软件的 AI 回复内容由第三方语言模型生成，不代表开发者立场或观点。开发者不对 AI 生成内容的准确性、适当性或任何后果负责。

**角色包版权**：用户自行准备和使用的角色包（包括立绘、语音素材等）的版权责任由用户自行承担。请勿使用未经授权的版权素材。开发者不对用户使用的第三方素材产生的任何版权纠纷负责。

**使用风险**：本软件按现状提供，不附带任何明示或暗示的保证。用户自行承担使用本软件的全部风险。

**数据隐私**：本软件所有数据存储在用户本地设备，开发者不收集、不存储、不传输任何用户数据。

若您遇到任何商家基于本软件提供付费服务，产生的问题与后果与本软件及开发者无关。

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
