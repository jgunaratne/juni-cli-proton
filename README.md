# juni-cli-proton

A native macOS desktop application version of [juni-cli](../juni-cli), built with Electron.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Main Process                                       │
│                                                              │
│  ┌────────────────────┐    ┌──────────────────────────────┐  │
│  │  BrowserWindow      │◀──│  Embedded Express Server      │  │
│  │  (renderer/dist/)   │    │  • /api/gemini/chat          │  │
│  │                     │    │  • /api/gemini/agent         │  │
│  └────────┬───────────┘    │  • /api/claude/chat          │  │
│            │                │  • Socket.io (SSH)           │  │
│            │                └──────────────┬───────────────┘  │
│            │                               │                  │
│  ┌────────┴───────────┐                    │                  │
│  │  preload.js         │    ┌──────────────┴───────────────┐  │
│  │  (context bridge)   │    │  SSH connections via ssh2     │  │
│  └────────────────────┘    └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key difference from juni-cli:** The Express server runs _inside_ the Electron main process. No separate server process is needed — everything is a single application.

## Quick Start

```bash
# Install root dependencies (Electron, Express, SSH, etc)
npm install

# Install renderer dependencies (React, xterm, etc)
cd renderer && npm install && cd ..

# Copy and edit your .env file
cp .env.example .env

# Run in development mode
npm run dev
```

## Development

```bash
npm run dev
```

This starts:
1. Vite dev server for the renderer (port 5173)
2. Electron, which embeds the Express server and loads from Vite

## Building

```bash
# Build for macOS (.dmg + .zip)
npm run build

# Build to directory (no installer, for testing)
npm run pack
```

Output goes to the `release/` directory.

## Project Structure

```
juni-cli-proton/
├── main.js               # Electron main process + embedded Express server
├── preload.js            # Context bridge (server port discovery)
├── package.json          # Root: Electron app + server dependencies
├── .env                  # API keys and config
├── assets/               # App icons
├── renderer/             # React frontend (Vite)
│   ├── src/
│   │   ├── App.jsx       # Main app (discovers server port via IPC)
│   │   ├── App.css
│   │   ├── index.css
│   │   └── components/
│   │       ├── Terminal.jsx
│   │       ├── GeminiChat.jsx
│   │       ├── ClaudeChat.jsx
│   │       └── ConnectionForm.jsx
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
└── release/              # Build output (gitignored)
```

## Differences from juni-cli

| Feature | juni-cli | juni-cli-proton |
|---------|----------|-----------------|
| Platform | Browser (any OS) | Native macOS app |
| Server | Separate Express process | Embedded in Electron |
| Window | Browser tab | Native macOS window |
| Title bar | Browser chrome | Native traffic lights (hiddenInset) |
| Server URL | Static config / env var | Dynamic IPC discovery |
| Packaging | Run `npm run dev` | Single `.app` or `.dmg` |
