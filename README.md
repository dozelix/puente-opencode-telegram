# Puente Telegram ↔ OpenCode

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh/)
[![OpenCode](https://img.shields.io/badge/OpenCode-Client-blue?style=for-the-badge)](https://github.com/dozelix)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

*A robust, zero-secret Telegram bridge for OpenCode written in TypeScript (Bun).*

</div>

---

## 🚀 What is it?

**Puente Telegram ↔ OpenCode** is a production-grade bridge that connects Telegram directly to your local or remote **OpenCode** server instance (`opencode serve`). It allows you to chat with your AI coding agents, manage workspaces/projects, send images and voice notes, review permissions (`/si`, `/no`), and receive file attachments directly on your mobile device without exposing raw credentials or relying on bloated runtimes.

---

## 🛠️ How it Works

The architecture follows strict **Single Responsibility Principle (SRP)** layers, ensuring high reliability, fail-closed security, and thread-safe operations:

1. **Telegram Adapter (`src/adaptadores/telegram.ts`)**: Manages `getUpdates` polling, MarkdownV2 formatting & linting, inline buttons, file downloads, and chat typing indicators.
2. **OpenCode Adapter (`src/adaptadores/opencode.ts`)**: Interfaces with the OpenCode API (`@opencode/client`) to create sessions, stream prompts, handle permissions, and manage working directories.
3. **Live Catalog Router (`src/aplicacion/router.ts`)**: Queries the live OpenCode model catalog (`c.model.list()`) rather than relying on hardcoded lists. It dynamically selects the best zero-cost or fallback model depending on whether the incoming message contains text, an image, or a voice note.
4. **Attachments & Audio (`src/dominio/adjuntos.ts`)**: Prepares incoming photos and voice notes. If model-based audio transcription fails, it falls back gracefully to local `whisper.cpp`.
5. **Chat Queue & Watchdog (`src/entrada/puente.ts`)**: Enqueues turns per chat to prevent race conditions (such as project switching mid-turn), and pings systemd via `WATCHDOG=1` to auto-restart the bridge if it becomes unresponsive.

---

## 📸 Screenshots / Visual Preview

> *Note: Place your screenshot files inside `docs/img/` and update the references below.*

### 1. Main Chat Interface & Project Selector
```text
┌──────────────────────────────────────────┐
│  Saulo (Telegram Bot)                    │
├──────────────────────────────────────────┤
│ 👤 User: /proyectos                      │
│ 🤖 Bot:                                  │
│ 🗂 Projects (3)                           │
│ • huachi-sport                           │
│ • puente-opencode-telegram               │
│ • IOT_E2                                 │
│                                          │
│ Now: /home/dozelix — tap one to work.    │
└──────────────────────────────────────────┘
```
*Interactive inline buttons let you instantly switch projects, inspect sessions, or start fresh.*

### 2. Live Model Routing & Voice/Image Handling
```text
┌──────────────────────────────────────────┐
│ 🎤 [Voice Note received]                 │
│ ⚙️ Router: transcribing audio via        │
│    console-google/gemini-3.8-flash       │
│ 🤖 Agent: "Analicé la nota de voz..."    │
└──────────────────────────────────────────┘
```
*Automatic multi-model switching ensures voice notes and images are routed correctly using live capabilities.*

---

## ⚙️ Configuration & Installation

### 1. Environment Variables
Copy the template to your configuration folder:
```bash
cp plantillas/telegram.env.example ~/.config/opencode/telegram.env
```
Fill in your credentials:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
```

### 2. Systemd Service (Optional)
To run the bridge continuously as a user service without root permissions:
```bash
cp plantillas/puente.service ~/.config/systemd/user/puente.service
systemctl --user daemon-reload
systemctl --user enable --now puente.service
```

---

## 🧪 Testing & Validation

Run the type checker and self-tests locally with Bun:
```bash
# Check TypeScript types
bun run tipo

# Run self-tests against the active server
bun run autoprueba
```

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.
