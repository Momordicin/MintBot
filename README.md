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

## Why MintBot

- **A character on your desktop**: the chat window and the character's floating window are shown separately; the portrait changes with the character's mood and your interactions — it gets bored, falls asleep and wakes up.
- **Comes to you when bored, never gets in the way of your work or games**: for fullscreen games, videos, presentations or apps you choose, a character and chat set to smart avoidance move out of the way to a secondary display.
- **Remembers you**: each character keeps long-term memory, so relationships and past events carry over into later conversations.
- **Just speak**: local voice input that responds only to your voice, and solves the difficulty of recognizing it across devices.
- **Your choice of model**: Anthropic, OpenAI, DeepSeek, local Ollama, or a Claude Code / Codex subscription.
- **Data stays local**: conversations, memories and settings stay only on your computer.

## Core capabilities

| Module | What it does |
|---|---|
| Chat | Per-character configuration; compatible with SillyTavern character cards, with further extensions |
| Desktop pet | Pixel and illustration forms; emotion portraits that can be clicked through, dragged and hidden; smart avoidance of work and entertainment screens, remembering its position |
| Characters | Create, switch, or import from a character card; edit name, persona, wallpaper and theme; deleting a character removes its chats and memories |
| Memory | Recent conversation in context, older conversation recalled on demand; background summaries and fact extraction; browse memories and delete a time range |
| Models | Anthropic / OpenAI / DeepSeek / Ollama; power users can use different models for chat and for background organizing, as each character card needs; each character can have its own model and key |
| Voice input | One-click install and update; owner recognition across devices |
| Voice replies | Streaming speech synthesis with emotion-guided tone |
| Tools and proactive chat | Local actions, MCP, conversations started by schedule, events or mood |
| Mobile | Use the local service from your phone, sharing sessions with the desktop |

---

## Development stages

- [x] Phase 1: Core chat pipeline + proactive conversation
- [x] Phase 2: Memory system (being researched and optimized)
- [x] Phase 3: Overlay window + window management
- [ ] Phase 4: Voice (ASR done, TTS under research)
- [ ] Phase 5: Human-computer interaction tools + MCP
- [ ] Phase 6: Mobile client

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

# Download the Chinese full-text-search tokenizer extension
pnpm setup:vendor

# Copy config files
cp .env.example .env
cp config.example.json config.json

# Initialize the database (idempotent — writes two example characters; required on first run)
pnpm seed

# Set up the Python AI service's virtual environment (services/ai — local ASR/TTS/Embedding model services)
pnpm setup:ai

# Development
pnpm dev:all

# Everyday use
pnpm build:all
pnpm start
```

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
- Voice input is processed on your machine and no audio is saved; recognized text and your voiceprint are kept in local files. The voice component itself is downloaded from GitHub releases when you install or update it
- When using an external API (Anthropic / OpenAI / DeepSeek), conversation content is sent to that provider; for privacy-first use, we recommend configuring local Ollama instead

---

## Acknowledgements

**Open-source projects**

Projects the author of this project contributed to, or appreciated:
- [ameath](https://gitee.com/lzy-buaa-jdi/ameath)
- [Shinsekai](https://github.com/RachelForster/Shinsekai)
- [Graphiti](https://github.com/getzep/graphiti)
- [Mem0](https://github.com/mem0ai/mem0)
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)
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
