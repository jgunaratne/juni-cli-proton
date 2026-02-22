const { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client } = require('ssh2');
const { VertexAI } = require('@google-cloud/vertexai');
const os = require('os');
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.warn('[proton] node-pty not available:', err.message);
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

/* ── Environment ──────────────────────────────────────────── */

// app.isPackaged may not be available at module top-level in all Electron versions.
// Use a lazy check that defers to when it's actually needed.
function getIsDev() {
  try {
    return !app.isPackaged;
  } catch {
    return true;
  }
}

// Load .env from the app root directory
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

/* ── Config ───────────────────────────────────────────────── */

const DEFAULT_PROJECT = process.env.GCP_PROJECT_ID || '';
const DEFAULT_LOCATION = process.env.GCP_LOCATION || 'us-central1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GENAI_MODELS = ['gemini-3-flash-preview'];

/* ── Vertex AI Client Cache ───────────────────────────────── */

const clientCache = new Map();

function getVertexClient(project, location) {
  const key = `${project}::${location}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new VertexAI({ project, location }));
  }
  return clientCache.get(key);
}

/* ── Generative Language API (Google AI) Helper ───────────── */

async function callGenAI(model, requestBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Google AI API error: HTTP ${res.status}`);
  }

  return res.json();
}

function convertSchemaToGenAI(schema) {
  if (!schema) return schema;
  const result = { ...schema };
  if (result.type) {
    result.type = result.type.toLowerCase();
  }
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, val]) => [key, convertSchemaToGenAI(val)])
    );
  }
  if (result.items) {
    result.items = convertSchemaToGenAI(result.items);
  }
  return result;
}

/* ── Embedded Express Server ──────────────────────────────── */

let serverPort = 3001;
let expressServer = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const expressApp = express();
    const server = http.createServer(expressApp);

    const io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    expressApp.use(cors());
    expressApp.use(express.json({ limit: '2mb' }));

    /* ── Health Check ──────────────────────────────────── */

    expressApp.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        project: DEFAULT_PROJECT || '(not set)',
        location: DEFAULT_LOCATION,
        mode: 'proton',
      });
    });

    /* ── Gemini Chat Endpoint ──────────────────────────── */

    expressApp.post('/api/gemini/chat', async (req, res) => {
      try {
        const {
          model = 'gemini-3-flash-preview',
          messages = [],
          project,
          location,
        } = req.body;

        if (!Array.isArray(messages) || messages.length === 0) {
          return res.status(400).json({ error: 'messages array is required' });
        }

        const contents = messages.map((m) => ({
          role: m.role === 'model' ? 'model' : 'user',
          parts: [{ text: m.text }],
        }));

        let text;

        if (GENAI_MODELS.includes(model)) {
          if (!GEMINI_API_KEY) {
            return res.status(400).json({
              error: 'GEMINI_API_KEY is required for this model. Set it in Settings.',
            });
          }

          const data = await callGenAI(model, {
            contents,
            systemInstruction: {
              parts: [{ text: 'You are a Linux/macOS expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.' }],
            },
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 4096,
            },
          });

          text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response generated.';
        } else {
          const resolvedProject = project || DEFAULT_PROJECT;
          const resolvedLocation = location || DEFAULT_LOCATION;

          if (!resolvedProject) {
            return res.status(400).json({
              error: 'GCP project ID is required. Set GCP_PROJECT_ID in Settings.',
            });
          }

          const vertexAI = getVertexClient(resolvedProject, resolvedLocation);
          const generativeModel = vertexAI.getGenerativeModel({
            model,
            systemInstruction: 'You are a Linux/macOS expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 4096,
            },
          });

          const result = await generativeModel.generateContent({ contents });
          text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response generated.';
        }

        res.json({ reply: text });
      } catch (err) {
        console.error('[gemini] Chat error:', err);
        const message = err instanceof Error ? err.message : 'Internal server error';
        res.status(500).json({ error: message });
      }
    });

    /* ── Gemini Agent Endpoint (Function Calling) ──────── */

    const AGENT_TOOLS = [
      {
        functionDeclarations: [
          {
            name: 'run_command',
            description:
              'Execute a shell command on the user\'s remote SSH terminal. ' +
              'Use this to run any Linux/macOS command. The output of the command will be returned to you. ' +
              'Run one command at a time. For multi-step tasks, run commands sequentially and inspect output between each.',
            parameters: {
              type: 'OBJECT',
              properties: {
                command: {
                  type: 'STRING',
                  description: 'The shell command to execute',
                },
                reasoning: {
                  type: 'STRING',
                  description: 'Brief explanation of why you are running this command',
                },
              },
              required: ['command', 'reasoning'],
            },
          },
          {
            name: 'send_keys',
            description:
              'Send raw keystrokes or text directly to the terminal. ' +
              'Use this to interact with interactive programs, respond to prompts (y/n, passwords, etc.), ' +
              'send control sequences (Ctrl+C to cancel, Ctrl+D for EOF), or type text into running programs. ' +
              'Unlike run_command, this does NOT wait for a command to complete — it just sends the keystrokes and captures a brief snapshot of what appears. ' +
              'Special key names you can use in the keys field: Enter, Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Tab, Escape, Up, Down, Left, Right, Backspace, Delete.',
            parameters: {
              type: 'OBJECT',
              properties: {
                keys: {
                  type: 'STRING',
                  description:
                    'The text or keystrokes to send. For regular text, just type it. ' +
                    'For special keys, use names like "Enter", "Ctrl+C", "Tab". ' +
                    'You can combine text and special keys by separating with a space, e.g. "y Enter" to type y then press Enter. ' +
                    'To send just Enter (newline), use "Enter". To send Ctrl+C, use "Ctrl+C".',
                },
                reasoning: {
                  type: 'STRING',
                  description: 'Brief explanation of why you are sending these keystrokes',
                },
              },
              required: ['keys', 'reasoning'],
            },
          },
          {
            name: 'task_complete',
            description:
              'Signal that the task is finished. Call this when you have completed the user\'s request or determined it cannot be completed.',
            parameters: {
              type: 'OBJECT',
              properties: {
                summary: {
                  type: 'STRING',
                  description: 'A concise summary of what was accomplished',
                },
              },
              required: ['summary'],
            },
          },
        ],
      },
    ];

    const AGENT_SYSTEM_PROMPT =
      'You are an expert Linux/macOS system administrator agent with full access to the user\'s terminal via SSH. ' +
      'When the user asks you to do something, use the run_command tool to execute commands on their terminal. ' +
      'Inspect the output of each command before deciding the next step. ' +
      'Break complex tasks into small, sequential steps. ' +
      'If a command fails, analyze the error and try to fix it. ' +
      'When the task is complete, call task_complete with a summary. ' +
      'If the user asks a question that does not require running commands, respond with plain text. ' +
      '\n\nTOOLS:\n' +
      '- run_command: Execute a shell command and get its full output. Best for non-interactive commands. ' +
      'Always prefer this for standard commands.\n' +
      '- send_keys: Send raw keystrokes/text to the terminal. Use this when you need to:\n' +
      '  * Respond to an interactive prompt (e.g. type "y" and press Enter)\n' +
      '  * Send Ctrl+C to cancel a stuck or long-running process\n' +
      '  * Send Ctrl+D for EOF\n' +
      '  * Interact with a running program that expects input\n' +
      '  * Type text into a TUI or interactive application\n' +
      'Note: send_keys only captures a brief snapshot of terminal output (~3 seconds), not strict command-completion output.\n' +
      '\n\nCRITICAL RULES:\n' +
      '1. Prefer run_command over send_keys for standard commands — send_keys is for interactive situations only. ' +
      '2. NEVER run interactive commands that wait for user input via run_command (vim, nano, vi, less, more, top, htop, python, node, ssh, mysql, psql, irb, etc). ' +
      'If you must interact with such programs, prefer non-interactive alternatives. If absolutely necessary, use send_keys. ' +
      '3. Always use non-interactive flags: use -y for apt/yum/dnf, use DEBIAN_FRONTEND=noninteractive, use -f for commands that prompt. ' +
      '4. For file editing, use echo/printf/cat with heredocs or sed/awk — NEVER use text editors. ' +
      '5. For writing multi-line files, use: cat > filename << \'EOF\'\n...content...\nEOF ' +
      '6. When running scripts, ensure they are non-interactive (no read commands, no prompts). ' +
      '7. If a command might produce paged output, pipe through cat (e.g. git log | cat, man cmd | cat). ' +
      '8. Never run destructive commands (rm -rf /, mkfs, etc.) without the user explicitly confirming. ' +
      '9. Keep individual commands short and focused. Avoid long command chains. ' +
      '10. If you need to check if a program is installed, use "which" or "command -v", not the program itself. ' +
      '11. If a run_command times out or reports "waiting for input", use send_keys with Ctrl+C to cancel it, then try a different approach.';

    expressApp.post('/api/gemini/agent', async (req, res) => {
      try {
        const {
          model = 'gemini-3-flash-preview',
          history = [],
          project,
          location,
        } = req.body;

        const contents = history.map((entry) => ({
          role: entry.role,
          parts: entry.parts,
        }));

        if (contents.length === 0) {
          return res.status(400).json({ error: 'history is required' });
        }

        let parts;

        if (GENAI_MODELS.includes(model)) {
          if (!GEMINI_API_KEY) {
            return res.status(400).json({
              error: 'GEMINI_API_KEY is required for this model. Set it in Settings.',
            });
          }

          const genaiTools = AGENT_TOOLS.map((toolGroup) => ({
            functionDeclarations: toolGroup.functionDeclarations.map((fn) => ({
              ...fn,
              parameters: fn.parameters ? convertSchemaToGenAI(fn.parameters) : undefined,
            })),
          }));

          const data = await callGenAI(model, {
            contents,
            systemInstruction: {
              parts: [{ text: AGENT_SYSTEM_PROMPT }],
            },
            tools: genaiTools,
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 4096,
            },
          });

          const candidate = data?.candidates?.[0];
          parts = candidate?.content?.parts ?? [{ text: 'No response generated.' }];
        } else {
          const resolvedProject = project || DEFAULT_PROJECT;
          const resolvedLocation = location || DEFAULT_LOCATION;

          if (!resolvedProject) {
            return res.status(400).json({
              error: 'GCP project ID is required. Set GCP_PROJECT_ID in Settings.',
            });
          }

          const vertexAI = getVertexClient(resolvedProject, resolvedLocation);
          const generativeModel = vertexAI.getGenerativeModel({
            model,
            systemInstruction: AGENT_SYSTEM_PROMPT,
            tools: AGENT_TOOLS,
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 4096,
            },
          });

          const result = await generativeModel.generateContent({ contents });
          const response = result.response;
          const candidate = response?.candidates?.[0];
          parts = candidate?.content?.parts ?? [{ text: 'No response generated.' }];
        }

        res.json({ parts });
      } catch (err) {
        console.error('[gemini-agent] Error:', err);
        const message = err instanceof Error ? err.message : 'Internal server error';
        res.status(500).json({ error: message });
      }
    });

    /* ── Claude Chat Endpoint ──────────────────────────── */

    expressApp.post('/api/claude/chat', async (req, res) => {
      try {
        const {
          model = 'claude-sonnet-4-20250514',
          messages = [],
          apiKey,
        } = req.body;

        const resolvedKey = apiKey || process.env.ANTHROPIC_API_KEY;

        if (!resolvedKey) {
          return res.status(400).json({
            error: 'Anthropic API key is required. Add it in Settings or set ANTHROPIC_API_KEY.',
          });
        }

        if (!Array.isArray(messages) || messages.length === 0) {
          return res.status(400).json({ error: 'messages array is required' });
        }

        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: resolvedKey });

        const anthropicMessages = messages.map((m) => ({
          role: m.role === 'model' ? 'assistant' : 'user',
          content: m.text,
        }));

        const result = await client.messages.create({
          model,
          max_tokens: 4096,
          system: 'You are a Linux/macOS expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
          messages: anthropicMessages,
        });

        const text = result.content?.[0]?.text ?? 'No response generated.';
        res.json({ reply: text });
      } catch (err) {
        console.error('[claude] Chat error:', err);
        const message = err instanceof Error ? err.message : 'Internal server error';
        res.status(500).json({ error: message });
      }
    });

    /* ── Socket.io connection handler ──────────────────── */

    io.on('connection', (socket) => {
      console.log(`[socket] client connected  id=${socket.id}`);

      let sshClient = null;
      let sshStream = null;
      let ptyProcess = null;
      let pendingSize = { rows: 24, cols: 80 };

      /* ── Helper: write to whichever backend is active ── */
      const writeToBackend = (data) => {
        if (ptyProcess) ptyProcess.write(data);
        else if (sshStream) sshStream.write(data);
      };

      const resizeBackend = (cols, rows) => {
        pendingSize = { rows, cols };
        if (ptyProcess) ptyProcess.resize(cols, rows);
        else if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
      };

      const cleanupBackend = () => {
        if (ptyProcess) {
          ptyProcess.kill();
          ptyProcess = null;
        }
        if (sshStream) sshStream.end();
        if (sshClient) sshClient.end();
        sshStream = null;
        sshClient = null;
      };

      socket.on('ssh:connect', (credentials) => {
        const { host, port = 22, username, password, privateKey, local } = credentials;
        const isLocal = local || LOCAL_HOSTS.includes(host);

        /* ── Local terminal (no login required) ────────── */
        if (isLocal) {
          if (!pty) {
            socket.emit('ssh:error', { message: 'node-pty is not available. Cannot open local terminal.' });
            return;
          }

          console.log('[local] spawning local shell');
          socket.emit('ssh:status', { status: 'authenticated' });

          const shellPath = process.env.SHELL || '/bin/zsh';
          const homeDir = os.homedir();

          ptyProcess = pty.spawn(shellPath, [], {
            name: 'xterm-256color',
            cols: pendingSize.cols,
            rows: pendingSize.rows,
            cwd: homeDir,
            env: {
              ...process.env,
              TERM: 'xterm-256color',
              HOME: homeDir,
              LANG: process.env.LANG || 'en_US.UTF-8',
            },
          });

          socket.emit('ssh:status', { status: 'ready' });

          ptyProcess.onData((data) => {
            socket.emit('ssh:output', data);
          });

          ptyProcess.onExit(({ exitCode, signal }) => {
            console.log(`[local] shell exited  code=${exitCode} signal=${signal}`);
            socket.emit('ssh:status', { status: 'disconnected' });
            ptyProcess = null;
          });

          return;
        }

        /* ── Remote SSH connection ──────────────────────── */
        console.log(`[ssh] connecting to ${username}@${host}:${port}`);
        sshClient = new Client();

        sshClient.on('ready', () => {
          console.log(`[ssh] authenticated  ${username}@${host}`);
          socket.emit('ssh:status', { status: 'authenticated' });

          sshClient.shell(
            { term: 'xterm-256color', rows: pendingSize.rows, cols: pendingSize.cols },
            (err, stream) => {
              if (err) {
                socket.emit('ssh:error', { message: err.message });
                return;
              }

              sshStream = stream;
              socket.emit('ssh:status', { status: 'ready' });

              stream.on('data', (data) => {
                socket.emit('ssh:output', data.toString('utf-8'));
              });

              stream.stderr.on('data', (data) => {
                socket.emit('ssh:output', data.toString('utf-8'));
              });

              stream.on('close', () => {
                console.log(`[ssh] shell closed  ${username}@${host}`);
                socket.emit('ssh:status', { status: 'disconnected' });
                if (sshClient) sshClient.end();
              });
            });
        });

        sshClient.on('error', (err) => {
          console.error(`[ssh] error: ${err.message}`);
          socket.emit('ssh:error', { message: err.message });
        });

        sshClient.on('close', () => {
          console.log('[ssh] connection closed');
          socket.emit('ssh:status', { status: 'disconnected' });
          sshClient = null;
          sshStream = null;
        });

        const connectConfig = {
          host,
          port: Number(port),
          username,
          tryKeyboard: true,
          readyTimeout: 10000,
        };
        if (privateKey) {
          connectConfig.privateKey = privateKey;
        } else if (password) {
          connectConfig.password = password;
        }

        sshClient.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
          finish([password || '']);
        });

        sshClient.connect(connectConfig);
      });

      socket.on('ssh:data', (data) => {
        writeToBackend(data);
      });

      socket.on('ssh:resize', ({ cols, rows }) => {
        resizeBackend(cols, rows);
      });

      socket.on('disconnect', () => {
        console.log(`[socket] client disconnected  id=${socket.id}`);
        cleanupBackend();
      });
    });

    /* ── Start server ──────────────────────────────────── */

    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      expressServer = server;
      console.log(`✦  juni-cli-proton server on http://127.0.0.1:${serverPort}`);
      resolve(serverPort);
    });

    server.on('error', reject);
  });
}

/* ── Electron Window ───────────────────────────────────────── */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  // Elegant fade-in
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (getIsDev()) {
    mainWindow.loadURL(`http://localhost:5173`);
    // Open DevTools in development
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ── macOS Menu ────────────────────────────────────────────── */

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── IPC Handlers ──────────────────────────────────────────── */

function setupIPC() {
  ipcMain.handle('get-server-port', () => serverPort);

  ipcMain.handle('get-platform', () => process.platform);

  ipcMain.handle('get-app-version', () => app.getVersion());
}

/* ── App Lifecycle ─────────────────────────────────────────── */

app.whenReady().then(async () => {
  setupIPC();
  buildMenu();

  // Start embedded server first
  try {
    const port = await startServer();
    console.log(`[proton] Server started on port ${port}`);
  } catch (err) {
    console.error('[proton] Failed to start server:', err);
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (expressServer) {
    expressServer.close();
  }
  app.quit();
});
