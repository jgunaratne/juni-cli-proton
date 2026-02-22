import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io } from 'socket.io-client';

import '@xterm/xterm/css/xterm.css';

const AGENT_SENTINEL = '__JUNI_AGENT_DONE__';

const stripAnsi = (str) => str
  .replace(/\x1b\[[\?=>!]?[0-9;]*[a-zA-Z]/g, '')
  .replace(/\x9b[0-9;]*[a-zA-Z]/g, '')
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][A-Z0-9]/g, '')
  .replace(/\x1b[>=<~}|]/g, '')
  .replace(/\x1b\[[0-9;]*[ -/]*[@-~]/g, '')
  .replace(/\[[\?]?[0-9;]*[a-zA-Z]/g, '')
  .replace(/\r/g, '');

const Terminal = forwardRef(function Terminal({ tabId, connection, isActive, onStatusChange, onClose, fontFamily, fontSize, bgColor, serverUrl }, ref) {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const agentCaptureRef = useRef(null);
  const agentKeysRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
    getBufferText: () => {
      const term = xtermRef.current;
      if (!term) return '';
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)?.translateToString(true) ?? '';
        lines.push(line);
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      return lines.join('\n');
    },
    writeToTerminal: (text) => {
      if (socketRef.current) {
        socketRef.current.emit('ssh:data', text);
      }
    },
    abortAgentCapture: () => {
      if (agentCaptureRef.current) {
        const { resolve, timer, buffer } = agentCaptureRef.current;
        clearTimeout(timer);
        agentCaptureRef.current = null;
        const raw = stripAnsi(buffer).trim();
        resolve(raw || '(aborted by user)');
      }
      if (agentKeysRef.current) {
        const { resolve, timer, cleanup } = agentKeysRef.current;
        clearTimeout(timer);
        cleanup();
        agentKeysRef.current = null;
        resolve('(aborted by user)');
      }
    },
    sendAgentKeys: (keys) => {
      return new Promise((resolve) => {
        if (!socketRef.current) {
          resolve('Error: terminal not connected');
          return;
        }

        const KEY_MAP = {
          'Enter': '\r',
          'Return': '\r',
          'Tab': '\t',
          'Escape': '\x1b',
          'Esc': '\x1b',
          'Backspace': '\x7f',
          'Delete': '\x1b[3~',
          'Up': '\x1b[A',
          'Down': '\x1b[B',
          'Right': '\x1b[C',
          'Left': '\x1b[D',
          'Home': '\x1b[H',
          'End': '\x1b[F',
          'PageUp': '\x1b[5~',
          'PageDown': '\x1b[6~',
          'Ctrl+C': '\x03',
          'Ctrl+D': '\x04',
          'Ctrl+Z': '\x1a',
          'Ctrl+L': '\x0c',
          'Ctrl+A': '\x01',
          'Ctrl+E': '\x05',
          'Ctrl+K': '\x0b',
          'Ctrl+U': '\x15',
          'Ctrl+W': '\x17',
          'Ctrl+R': '\x12',
          'Space': ' ',
        };

        const tokens = keys.split(/\s+/);
        let payload = '';
        for (const token of tokens) {
          if (KEY_MAP[token] !== undefined) {
            payload += KEY_MAP[token];
          } else {
            payload += token;
          }
        }

        let outputBuffer = '';
        const onOutput = (data) => {
          outputBuffer += data;
        };
        socketRef.current.on('ssh:output', onOutput);

        const cleanup = () => {
          socketRef.current?.off('ssh:output', onOutput);
        };

        socketRef.current.emit('ssh:data', payload);

        const timer = setTimeout(() => {
          cleanup();
          agentKeysRef.current = null;
          const cleaned = stripAnsi(outputBuffer).trim();
          resolve(cleaned || '(no visible output after sending keys)');
        }, 3000);

        agentKeysRef.current = { resolve, timer, cleanup };
      });
    },
    runAgentCommand: (command) => {
      return new Promise((resolve) => {
        if (!socketRef.current) {
          resolve('Error: terminal not connected');
          return;
        }
        const timer = setTimeout(() => {
          if (agentCaptureRef.current) {
            const raw = stripAnsi(agentCaptureRef.current.buffer).trim();
            agentCaptureRef.current = null;
            resolve(raw || '(command timed out after 60s — it may be waiting for input)');
          }
        }, 60000);
        agentCaptureRef.current = { buffer: '', resolve, timer };
        socketRef.current.emit('ssh:data', `${command}; echo ${AGENT_SENTINEL}\n`);
      });
    },
  }));

  useEffect(() => {
    if (isActive && fitRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current.fit();
          if (xtermRef.current) {
            xtermRef.current.focus();
          }
        } catch {
          // may throw if terminal not ready yet
        }
      });
    }
  }, [isActive]);

  useEffect(() => {
    if (!xtermRef.current || !fitRef.current) return;
    if (fontFamily) xtermRef.current.options.fontFamily = `'${fontFamily}', monospace`;
    if (fontSize) xtermRef.current.options.fontSize = fontSize;
    if (bgColor) xtermRef.current.options.theme = { ...xtermRef.current.options.theme, background: bgColor };
    try { fitRef.current.fit(); } catch { /* not ready */ }
  }, [fontFamily, fontSize, bgColor]);

  useEffect(() => {
    if (!serverUrl) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: fontFamily ? `'${fontFamily}', monospace` : '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: fontSize || 14,
      lineHeight: 1.35,
      theme: {
        background: bgColor || '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#f0f6fc',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);

    const safeFit = () => {
      fit.fit();
      const { cols, rows } = term;
      const safeRows = Math.max(rows - 1, 1);
      term.resize(cols, safeRows);
      if (socketRef.current) {
        socketRef.current.emit('ssh:resize', { cols, rows: safeRows });
      }
    };

    let resizeTimer;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          safeFit();
        } catch {
          // terminal may be disposed during cleanup
        }
      }, 50);
    });

    resizeObserver.observe(termRef.current);

    const initTimers = [100, 300, 600].map((ms) => setTimeout(safeFit, ms));

    xtermRef.current = term;
    fitRef.current = fit;

    term.writeln('\x1b[1;36m⬡ juni-cli-proton\x1b[0m');
    term.writeln(`\x1b[90mConnecting to ${connection.username}@${connection.host}:${connection.port}…\x1b[0m`);
    term.writeln('');

    const socket = io(serverUrl, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('ssh:connect', connection);
      safeFit();
    });

    socket.on('ssh:output', (data) => {
      term.write(data);
      if (agentCaptureRef.current) {
        agentCaptureRef.current.buffer += data;
        const stripped = stripAnsi(agentCaptureRef.current.buffer);
        const sentinelPattern = /[\r\n]__JUNI_AGENT_DONE__/;
        const match = sentinelPattern.exec(stripped);
        if (match) {
          const { resolve, timer } = agentCaptureRef.current;
          clearTimeout(timer);
          agentCaptureRef.current = null;
          const beforeSentinel = stripped.substring(0, match.index);
          const firstNewline = beforeSentinel.indexOf('\n');
          const output = firstNewline >= 0
            ? beforeSentinel.substring(firstNewline + 1).trim()
            : beforeSentinel.trim();
          resolve(output);
        }
      }
    });

    socket.on('ssh:status', ({ status }) => {
      onStatusChange(status);
      if (status === 'ready') {
        safeFit();
        term.focus();
      }
      if (status === 'disconnected') {
        term.writeln('\r\n\x1b[1;31mConnection closed.\x1b[0m');
      }
    });

    socket.on('ssh:error', ({ message }) => {
      term.writeln(`\r\n\x1b[1;31mError: ${message}\x1b[0m`);
      onStatusChange('error');
    });

    term.onData((data) => {
      socket.emit('ssh:data', data);
    });

    term.onResize(({ cols, rows }) => {
      socket.emit('ssh:resize', { cols, rows });
    });

    let lastSelection = '';
    const selDisposable = term.onSelectionChange(() => {
      lastSelection = term.getSelection();
    });
    const el = termRef.current;
    const handleMouseDown = () => {
      if (lastSelection) {
        const textToPaste = lastSelection;
        setTimeout(() => {
          if (!term.getSelection()) {
            socket.emit('ssh:data', textToPaste);
          }
          lastSelection = '';
        }, 50);
      }
    };
    el.addEventListener('mousedown', handleMouseDown);

    return () => {
      el.removeEventListener('mousedown', handleMouseDown);
      selDisposable.dispose();
      initTimers.forEach(clearTimeout);
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      socket.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  useEffect(() => {
    if (!isActive || !fitRef.current || !xtermRef.current) return;
    const timer = setTimeout(() => {
      try {
        fitRef.current.fit();
        const { cols, rows } = xtermRef.current;
        const safeRows = Math.max(rows - 1, 1);
        xtermRef.current.resize(cols, safeRows);
        if (socketRef.current) {
          socketRef.current.emit('ssh:resize', { cols, rows: safeRows });
        }
      } catch {
        // terminal may be disposed
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [isActive]);

  return (
    <div
      className="terminal-container"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          <span className="terminal-title">
            {connection.username}@{connection.host}:{connection.port}
          </span>
        </div>
        <button className="disconnect-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="terminal-viewport" ref={termRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
});

export default Terminal;
