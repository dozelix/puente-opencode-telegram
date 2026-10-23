# OpenCode Telegram Bridge

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh/)
[![OpenCode](https://img.shields.io/badge/OpenCode-Client-blue?style=for-the-badge)](https://github.com/dozelix)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

*A robust, zero-secret Telegram bridge for OpenCode written in TypeScript (Bun).*

</div>

---

## 🚀 Overview

**OpenCode Telegram Bridge** is a production-grade integration layer connecting Telegram directly to your local or remote **OpenCode** server instance (`opencode serve`). It enables you to interact with AI coding assistants, manage project workspaces, handle image and voice attachments, approve or reject tool permissions (`/yes`, `/no`), and receive file outputs directly on your mobile device.

Designed with a strict Single Responsibility Principle (SRP) architecture, it ensures fail-closed security, robust error recovery, and zero hardcoded secrets.

---

## 🛠️ Architecture & How It Works

The codebase is organized into decoupled domain and adapter layers:

1. **Telegram Adapter (`src/adaptadores/telegram.ts`)**: Handles `getUpdates` polling, MarkdownV2 formatting and linting, inline keyboards, file transfers, and chat typing indicators.
2. **OpenCode Adapter (`src/adaptadores/opencode.ts`)**: Interfaces with the OpenCode API (`@opencode/client`) for session lifecycle management, prompt execution, permission handling, and workspace directory resolution.
3. **Live Catalog Router (`src/aplicacion/router.ts`)**: Dynamically queries the active OpenCode model catalog (`c.model.list()`) rather than relying on static matrices. It selects the best available zero-cost or fallback model based on message modality (text, image, or audio).
4. **Attachments & Audio (`src/dominio/adjuntos.ts`)**: Prepares incoming photos and voice messages. If model-based audio transcription is unavailable, it gracefully falls back to local `whisper.cpp`.
5. **Chat Queue & Watchdog (`src/entrada/puente.ts`)**: Enqueues turns per chat ID to prevent race conditions (such as workspace switching mid-turn) and integrates with systemd via `WATCHDOG=1` for reliable auto-restarts.

---

## 📸 Screenshots / Visual Preview

> *Note: Place your screenshot files inside `docs/img/` and update the references below.*

### 1. Interactive Project Selector
```text
┌──────────────────────────────────────────┐
│  OpenCode Agent (Telegram Bot)           │
├──────────────────────────────────────────┤
│ 👤 User: /projects                       │
│ 🤖 Bot:                                  │
│ 🗂 Projects (3)                           │
│ • core-service                           │
│ • web-dashboard                          │
│ • ml-pipeline                            │
│                                          │
│ Now: /home/user — tap one to work in it. │
└──────────────────────────────────────────┘
```

### 2. Multi-Modal Routing & Voice Support
```text
┌──────────────────────────────────────────┐
│ 🎤 [Voice Note received]                 │
│ ⚙️ Router: transcribing audio via        │
│    console-google/gemini-3.8-flash       │
│ 🤖 Agent: "Analyzed your voice request..."│
└──────────────────────────────────────────┘
```

---

## ⚙️ Configuration & Installation

### 1. Environment Variables
Copy the template configuration to your environment directory:
```bash
cp plantillas/telegram.env.example ~/.config/opencode/telegram.env
```
Provide your Telegram credentials:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
```

### 2. Systemd User Service (Optional)
To run the bridge continuously as a background service:
```bash
cp plantillas/puente.service ~/.config/systemd/user/puente.service
systemctl --user daemon-reload
systemctl --user enable --now puente.service
```

---

## 🧪 Testing & Validation

Verify types and run self-tests against your active OpenCode server:
```bash
# Run TypeScript type check
bun run typecheck

# Run integration self-tests
bun run selftest
```

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.
