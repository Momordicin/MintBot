# 贡献指南 · Contributing Guide

感谢你对 MintBot 的兴趣！在开始之前，请先阅读本文档。

---

## 目录

- [环境要求](#环境要求)
- [本地启动](#本地启动)
- [项目结构](#项目结构)
- [开发规范](#开发规范)
- [提交 PR](#提交-pr)
- [贡献角色包](#贡献角色包)
- [反馈问题](#反馈问题)

---

## 环境要求

| 工具 | 版本要求 | 说明 |
|---|---|---|
| Node.js | 20+ | 核心服务和 Electron |
| pnpm | 8+ | 包管理器，不接受 npm / yarn |
| Python | 3.10+ | AI 模型服务（Phase 4 语音功能需要） |
| Ollama | 最新版 | 可选，本地模型推理 |

> **注意**：项目使用 pnpm 作为唯一包管理器。请勿提交 `package-lock.json` 或 `yarn.lock`。

---

## 本地启动

### 1. 克隆仓库

```bash
git clone https://github.com/Momordicin/MintBot.git
cd MintBot
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境

```bash
# 复制配置模板
cp .env.example .env
cp config.example.json config.json
```

编辑 `.env`，填入必要的密钥：

```dotenv
DB_ENCRYPTION_KEY=your-32-char-encryption-key-here
ANTHROPIC_API_KEY=sk-ant-...   # 使用 Anthropic 时填写
OPENAI_API_KEY=sk-...          # 使用 OpenAI 时填写
```

编辑 `config.json`，配置模型提供商：

```json
{
  "modelProvider": {
    "type": "ollama",
    "ollamaBaseUrl": "http://localhost:11434/v1/",
    "ollamaModel": "qwen3"
  },
  "defaultPresetId": "preset-001"
}
```

> 如果使用 Anthropic 或 OpenAI，将 `type` 改为 `"anthropic"` 或 `"openai"`，并填入对应 API Key。

### 4. 初始化数据库

```bash
# 创建数据库并插入测试用的角色 preset
pnpm seed
```

### 5. 启动开发环境

```bash
pnpm dev
```

这会同时启动：
- Electron 窗口（渲染进程）
- Node.js 核心服务（Fastify，端口 3000）

### 6. 运行测试

```bash
pnpm test
```

测试使用内存数据库，不会影响本地数据。

---

## 项目结构

```
MintBot/
├── electron/               # Electron 主进程（窗口管理、系统托盘）
│   ├── main/
│   └── preload/
├── src/                    # 渲染进程（React UI）
│   ├── chat/               # 聊天窗口
│   ├── overlay/            # 桌面悬浮窗
│   └── settings/           # 设置页
├── services/
│   ├── core/               # Node.js Fastify 核心服务
│   │   ├── context/        # buildContext()，对话上下文组装
│   │   ├── db/             # SQLite 初始化、加密、seed 脚本
│   │   ├── providers/      # ModelProvider（Anthropic/OpenAI/Ollama）
│   │   ├── routes/         # REST + SSE 路由
│   │   └── session/        # Session 管理、消息读写
│   └── ai/                 # Python FastAPI AI 模型服务
│       ├── asr/            # faster-whisper 语音识别
│       ├── tts/            # GPT-SoVITS v2 语音合成
│       └── embedding/      # BGE-large 向量 embedding
├── shared/
│   └── types/              # 跨进程共用 TypeScript 类型定义
├── assets/
│   ├── brand/              # 品牌资产（版权保留，不开源）
│   └── characters/         # 角色包（用户自行准备，不纳入仓库）
├── .env.example            # 环境变量模板
├── config.example.json     # 配置文件模板
└── vitest.config.ts        # 测试配置
```

**边界原则**
- `electron/` 只管窗口，不包含任何业务逻辑
- `services/core/` 是业务逻辑唯一载体
- `services/ai/` 负责模型推理，通过 HTTP 与核心服务通信
- 三者互不耦合

---

## 开发规范

### TypeScript

- 严格模式（`strict: true`），不允许 `any`（必要时加注释说明原因）
- 各目录有独立的 `tsconfig.json`，**不要**修改 `moduleResolution` 设置：
  - `electron/`、`src/`：`bundler`（electron-vite 编译）
  - `services/core/`、`shared/`：`NodeNext`（tsx 直接运行）
- import 路径必须带 `.js` 后缀（ESM 规范）

### 测试

- 核心模块必须有单元测试，使用 vitest
- 测试用内存数据库（`.env.test` 里 `DB_PATH=:memory:`），不依赖本地数据库文件
- 每个测试文件独立调用 `initDb()`，不共享数据库状态
- 提交 PR 前确保 `pnpm test` 全部通过

### Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>: <description>

[optional body]
```

常用 type：

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `refactor` | 重构（不影响功能） |
| `test` | 测试相关 |
| `chore` | 构建、依赖、配置等杂项 |

示例：
```
feat: add streaming SSE support to POST /chat
fix: prevent Ollama from shutting down when not managed by MintBot
docs: update README with pnpm setup instructions
```

### 配置外置原则

- 所有路径、地址、密钥必须走 `.env` 或 `config.json`，**禁止硬编码**
- 不允许在代码里出现绝对路径

---

## 提交 PR

> ⚠️ 项目目前**暂不接受外部 PR**。

MintBot 的底层架构仍在积极建设中（记忆系统、悬浮窗、语音管线等核心模块尚未完成），在基础稳定之前引入外部贡献会增加维护成本。

**你现在可以做的：**
- ⭐ Star 关注项目进展
- 🐛 提交 Issue 反馈 Bug 或建议
- 🍴 Fork 自行修改使用（遵循 AGPL-3.0）

**计划开放贡献的方向（未来）：**
- i18n 多语言支持
- 角色包制作与分享
- 插件 / MCP server 扩展
- ...

届时会更新本文档并发布贡献规范。

---

## 贡献角色包

> 角色包不纳入主仓库，请通过单独渠道分享。

如果你想贡献示例角色包，需要确保：

- 立绘资产为**原创**或 **CC0 授权**，版权清晰
- 包含完整的 `manifest.json`，情绪标签覆盖至少：`idle`、`happy`、`curious`、`sleep`
- 不包含任何违反 AGPL-3.0 的内容

---

## 反馈问题

- **Bug 报告**：在 [Issues](https://github.com/Momordicin/MintBot/issues) 提交，附上复现步骤和环境信息
- **功能建议**：同样通过 Issues 提交，标注 `enhancement` 标签
- **安全漏洞**：请**不要**公开提交 Issue，通过 GitHub Security Advisory 私下报告

---

感谢你的贡献 🎉
