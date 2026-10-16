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

<p align="center">English | <a href="docs/i18n/README.zh-CN.md">简体中文</a></p>

A locally-run AI character companion desktop app. Supports custom character personas, voice conversation, a desktop overlay window, and long-term memory. All data stays on your machine — privacy first.

---

## Features

**Chat**
- Real-time conversation with a custom AI character — "typing" animation followed by the full message shown at once, an instant-messaging-style experience
- Keep sending while the character is still replying; messages are answered in order
- Full message history retention, with infinite-scroll-up pagination for older conversations
- Per-character wallpaper and theme (light / dark / follow system, with an accent color)

**Desktop pet**
- An independent, transparent-background pet window that lives alongside the chat window (each has its own visibility and avoidance; clicking the pet opens the chat); the portrait switches in real time based on emotion tags (supports both animated GIF and static images)
- Pixel and illustration forms, switchable per character, with an adjustable size; bored / asleep states and scripted transitions (waking up, being poked)
- Right-click menu: click-through mode, window size, smart avoidance, form switch, and collapsing the pet into a single handle
- Avoids fullscreen programs (games, fullscreen video, presentations) and apps you set rules for (allow / make way / avoid completely): moves to a free display, docks to the screen edge, or hides
- Chat window pin-on-top modes: always / smart (follows the same avoidance) / off
- Remembers its position on each display
- Persists in the system tray in the background; double-click the tray icon to bring up the chat window

**Voice** (Phase 4, not yet available)
- Voice input (faster-whisper ASR)
- Voice replies (GPT-SoVITS v2, streaming synthesis — playback starts on the first sentence)
- Multi-part replies: model output is split at sentence boundaries and pushed incrementally to mimic natural conversation pacing, paired with the streaming TTS pipeline
- Emotion tags guide vocal tone

**Memory system**
- Dual-track memory: recent conversation is injected directly into context, older conversation is retrieved via RAG
- bge-m3 vector embeddings, local sqlite-vec indexing, plus Chinese keyword search (SQLite FTS5)
- Automatic summary compression, entity aggregation; organizing runs in the background without blocking chat
- Delete a time range of conversation, together with the facts extracted from it; deleted content is erased from the database file
- Emotion state engine (Phase 2 baseline): currently only the character's own (self) emotion is parsed and persisted; perceived user emotion (perceived_user) is a placeholder design — a full bidirectional emotion model (self and perceived_user influencing each other) is planned for later

**Settings window**
- Characters: create, switch, or import from a SillyTavern character card; edit name, persona, wallpaper and theme; delete a character together with all its chats and memories
- Model providers: Anthropic, OpenAI, DeepSeek and Ollama, with model names picked from each provider's live model list
- API keys are entered in MintBot (only the last 4 characters are shown once saved), or taken from the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` environment variables if you tick that option
- Separate models for chat and for background organizing; each character can use the global settings or its own model, API key and summary model
- Sign in to your own Claude Code and Codex subscriptions. The official command-line tool opens your default browser to sign in. MintBot keeps this login separate from your usual Claude Code / Codex setup.
- Memory management: browse a character's messages, extracted facts and summaries, see organizing progress, delete by time range
- Window behavior: chat pin-on-top mode, pet smart avoidance and per-app rules

**Human-computer interaction** (Phase 5 / 6, planned — not yet implemented)
- Local system actions: launching apps, adjusting volume, taking screenshots, etc.
- MCP extension interface (reserved)
- Proactive conversation scheduler: triggered by schedule, events, or emotion thresholds

**Mobile** (Phase 7, planned — not yet implemented)
- Access the local service via Cloudflare Tunnel
- Shares sessions with the desktop client, synced in real time

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop framework | Electron + React |
| Core service | Node.js + Fastify (PM2-managed) |
| Model calls | Anthropic SDK / OpenAI SDK (OpenAI, DeepSeek) / Ollama |
| Local model | Ollama (optional, Qwen3 / ChatGLM etc.) |
| ASR | faster-whisper (Python HTTP service, planned) |
| TTS | GPT-SoVITS v2 (Python HTTP service, planned) |
| Embedding / NER | bge-m3 / bert4ner (Python HTTP service) |
| Database | SQLite + sqlite-vec |
| Chinese FTS tokenizer | libsimple ([wangfenjin/simple](https://github.com/wangfenjin/simple), prebuilt binary + jieba dictionary) |
| Win32 FFI | koffi |
| Config hot-reload | chokidar |

Model calls support both external APIs (Anthropic / OpenAI / DeepSeek) and local Ollama, chosen in the settings window. All data stays on your machine — no dependency on any cloud storage.

---

## Development stages

- [x] Phase 1: Core chat pipeline
- [x] Phase 2: Memory system
- [x] Phase 3: Overlay window + window management
- [ ] Phase 4: Voice
- [ ] Phase 5: Human-computer interaction tools + MCP
- [ ] Phase 6: Proactive conversation scheduler
- [ ] Phase 7: Mobile client + wrap-up

---

## Getting started

> Environment requirements and deployment docs are still being written.
> ⚠️ Windows only for now; macOS is not yet supported.

**Prerequisites**
- Node.js 20+
- pnpm (version per `package.json`)
- Python 3.10+
- (Optional) either Ollama or an Anthropic / OpenAI / DeepSeek API key
- (Optional) the `claude` and/or `codex` command-line tool on PATH, to sign in to those subscriptions

```bash
# Clone the repo
git clone https://github.com/Momordicin/MintBot.git
cd MintBot

# Install dependencies
pnpm install

# Download and restore the SQLite FTS Chinese tokenizer extension (libsimple — a prebuilt
# binary + jieba dictionary from wangfenjin/simple, ~16MB, not committed to the repo). Run
# this once after cloning; it must complete before `pnpm seed` / the core service's first run,
# or Chinese full-text-search index initialization will fail.
pnpm setup:vendor

# Copy config files
cp .env.example .env
cp config.example.json config.json
# The example config uses local Ollama. Model providers, API keys and models can be changed
# later in the settings window (Global model service), so you don't need to edit config.json
# by hand. Ports default to 18300 (core service), 18765 (AI service) and 18173 (dev renderer);
# change them in .env.

# Initialize the database (idempotent — writes two example characters; required on first run)
pnpm seed

# Set up the Python AI service's virtual environment (services/ai — local ASR/TTS/Embedding
# model services). Assumes a `python` command (Python 3.10+) is already on PATH. Run this once
# after first cloning, and again whenever requirements.txt changes to sync dependencies. Besides
# installing Python dependencies, this step also pre-downloads the bge-m3 + bert4ner model
# weights (the full bge-m3 repo is about 4.59GB) — the first run may take a while depending on
# your network, but the weights are cached locally (~/.cache/huggingface/) so subsequent runs
# are fast.
pnpm setup:ai

# Start the core service (Fastify, its own process)
# Development: pnpm dev:core
# Production: build first, then run persistently via pm2 (pnpm start:core just runs
# `pm2 start ecosystem.config.cjs`, which depends on out/core/services/core/index.js — skipping build:core
# will fail immediately with a missing-file error)
# Production: on Windows, the first run needs administrator privileges; after that,
# `pm2 stop mintbot-core; pm2 kill` and you can run it from a regular terminal going forward
pnpm build:core
pnpm start:core

# Start the desktop app (Electron + React)
pnpm dev
```

The Python AI service (services/ai — local ASR / TTS / Embedding model services) is started and stopped automatically by the core service: when `pnpm start:core` / `pnpm dev:core` starts the core service, if it detects the AI service isn't already running, it automatically spins up the corresponding process from `.venv`, and stops that instance when the core service exits — you don't need to run `pnpm dev:ai` manually. `pnpm dev:ai` still exists for cases where you want to manually start it for hot-reload debugging of the Python code — the core service will detect it's already running and won't start a duplicate, but it also won't stop that manually-started instance for you on exit (you'll need to Ctrl+C it yourself). This "already running" detection relies on both sides using the same port; `pnpm dev:ai` reads `AI_PORT` from `.env` the same way the core service does, so they stay aligned.

---

## Character configuration

A character pack is a folder under `assets/characters/<character-name>/`, described by its `manifest.json`:

```
assets/characters/my-character/
  ├── manifest.json     # character info, emotion → portrait mapping, sticker pool, transitions
  ├── avatar.png        # chat window and tray avatar
  ├── gifs/             # pixel-form portraits (idle.gif, happy.gif, ...)
  ├── full-body.png     # illustration-form portraits
  └── emotes/           # stickers the character can send
```

`manifest.json` (schema version 3) contains:

- `name`, `displayName`, `description`, `tags`, `avatar`: basic character info
- `emotionVocabulary`: the emotion tags the character can use
- `portraits.pixel` / `portraits.illustration`: portraits for each form, each with `emotions` (emotion → one or more files, picked at random), a `fallback` emotion, and `reservedStates` (thinking, bored, sleeping, ...)
- `emotePool`: stickers with tags
- `transitions`: scripted animations for falling asleep, waking up and being poked

See [`assets/characters/example/manifest.json`](assets/characters/example/manifest.json) for a complete example of every field.

---

## Contributing

The project is currently in the foundational-architecture phase and isn't accepting external PRs yet. You're welcome to get involved in other ways:

- ⭐ Star the repo to follow progress
- 🐛 [File an issue](https://github.com/Momordicin/MintBot/issues) to report a bug or suggestion
- 🍴 Fork it and modify it for your own use (under AGPL-3.0)

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

---

## Privacy

- All conversation data is stored in local SQLite — nothing is uploaded to any server
- API keys stay on your machine: global keys in `config.json`, per-character keys in the local database. Keys taken from environment variables are read at startup and never saved
- Claude Code / Codex subscription logins are handled entirely by the official command-line tools and your browser. MintBot never sees the account or its credentials; the tools store them in MintBot's own local data folder
- Deleted conversations are erased from the database file and can't be recovered from it
- When using an external API (Anthropic / OpenAI / DeepSeek), conversation content is sent to that provider; for privacy-first use, we recommend configuring local Ollama instead

---

## Acknowledgements

**Open-source projects**

The design and implementation of this project drew on the following open-source projects:
- [Shinsekai](https://github.com/RachelForster/Shinsekai)
- [Graphiti](https://github.com/getzep/graphiti)
- [Mem0](https://github.com/mem0ai/mem0)
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)
- [ameath](https://gitee.com/lzy-buaa-jdi/ameath)
- [wangfenjin/simple](https://github.com/wangfenjin/simple) (libsimple) — the SQLite FTS5 Chinese tokenizer this project vendors

**Sticker packs and assets**

Thanks to the following creators for authorizing/openly sharing the sticker assets used here:
- Aemeath sticker pack by [Stephen樽](https://space.bilibili.com/5609794)
- Xiao Ai sticker pack by [雾雪](https://space.bilibili.com/103739)
- Xiao Ai idle sticker pack by [\_BLZ\_](https://space.bilibili.com/2255628)
- Distributor of 雾雪's sticker pack, [凉梦喵啦啦啦](https://space.bilibili.com/51460746)
- User example sticker by [Ah_San](https://www.pixiv.net/users/101403291)

The send-button icon in the message bar is from *Wuthering Waves*, a game by the Chinese studio Kuro Games.

**Special thanks**

Thanks to [*Wuthering Waves*](https://mc.kurogames.com/), [*Reverse: 1999*](https://re.bluepoch.com/home/), and [*Goddess of Victory: NIKKE*](https://nikke-en.com/) — they're what inspired me to set out on the journey of building this project, and what keeps me motivated to keep building MintBot.

---

## Disclaimer

This software is open-source and free. Any derivative version based on this software must also be open-sourced.

If you encounter any vendor offering a paid service based on this software, note that their modified source code should be made public as required by AGPL-3.0. This software's developer is not responsible for any issues arising from such use.

**Generated content**: this software's AI reply content is generated by third-party language models and does not represent the developer's positions or views. The developer is not responsible for the accuracy, appropriateness, or any consequences of AI-generated content.

**Character pack copyright**: copyright responsibility for character packs (including portraits, voice assets, etc.) that users prepare and use themselves rests with the user. Do not use unauthorized copyrighted material. The developer is not responsible for any copyright disputes arising from third-party assets used by users.

**Use at your own risk**: this software is provided as-is, without warranty of any kind, express or implied. Users assume all risk of using this software.

---

## License

This project's source code is open-sourced under **AGPL-3.0**.

Brand assets under `assets/brand/` (logo, banner, etc.) are **not covered by the AGPL-3.0 license** — copyright belongs to the project author, and unauthorized use, copying, or distribution is prohibited.

The `assets/characters/` directory contains sample descriptions only; actual character packs are prepared by the user. When uploading or sharing character packs, please ensure portrait asset copyright is clear, and do not use unauthorized copyrighted material.

```
assets/
  ├── brand/          # Brand assets, copyright reserved, not open-sourced with the code
  │   ├── logo.png
  │   ├── logo.svg
  │   └── COPYRIGHT
  └── characters/     # Character pack directory, prepared by the user, not included in the repo
```
