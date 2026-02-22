import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';

const CHAT_HISTORY_KEY = 'juni-cli-proton:gemini-chat';
const CMD_HISTORY_KEY = 'juni-cli-proton:gemini-cmd-history';

function loadChatHistory() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function loadCmdHistory() {
  try {
    return JSON.parse(localStorage.getItem(CMD_HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

/* ── API helpers ─────────────────────────────────────── */

async function callGemini(serverUrl, model, messages) {
  const res = await fetch(`${serverUrl}/api/gemini/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.reply ?? 'No response generated.';
}

async function callGeminiAgent(serverUrl, model, history, signal) {
  const res = await fetch(`${serverUrl}/api/gemini/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, history }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.parts ?? [{ text: 'No response generated.' }];
}

/* ── Simple markdown → ANSI-style terminal rendering ── */

function renderForTerminal(text) {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => code)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^### (.+)$/gm, '  $1')
    .replace(/^## (.+)$/gm, '  $1')
    .replace(/^# (.+)$/gm, '  $1');
}

/* ── Component ────────────────────────────────────────── */

const GeminiChat = forwardRef(function GeminiChat({
  model = 'gemini-3-flash-preview',
  isActive,
  onStatusChange,
  onRunCommand,
  agentMode = false,
  onRunAgentCommand,
  onSendAgentKeys,
  onAbortAgentCapture,
  serverUrl,
}, ref) {
  const pastedTextRef = useRef(null);
  const autoSendRef = useRef(false);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    pasteText: (text) => {
      const lineCount = text.split('\n').length;
      pastedTextRef.current = text;
      setInput(`[Terminal text — ${lineCount} line${lineCount !== 1 ? 's' : ''}]`);
      autoSendRef.current = true;
    },
  }));

  const [messages, setMessages] = useState(loadChatHistory);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [commandHistory, setCommandHistory] = useState(loadCmdHistory);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [agentHistory, setAgentHistory] = useState([]);
  const [agentSteps, setAgentSteps] = useState([]);
  const [pendingCommand, setPendingCommand] = useState(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentPaused, setAgentPaused] = useState(false);
  const [agentStopping, setAgentStopping] = useState(false);
  const abortAgentRef = useRef(false);
  const abortControllerRef = useRef(null);
  const pausedResolverRef = useRef(null);
  const lastAgentPromptRef = useRef(null);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    onStatusChange('ready');
  }, [onStatusChange]);

  useEffect(() => {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(commandHistory));
  }, [commandHistory]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, input, agentSteps, pendingCommand]);

  useEffect(() => {
    if (isActive) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isActive]);

  /* ── Agent loop ──────────────────────────────────────── */

  const runAgentStep = useCallback(async (history, signal) => {
    const parts = await callGeminiAgent(serverUrl, model, history, signal);

    const functionCall = parts.find((p) => p.functionCall);
    const textPart = parts.find((p) => p.text);

    if (functionCall) {
      const { name, args } = functionCall.functionCall;

      if (name === 'task_complete') {
        return { type: 'complete', summary: args.summary, parts };
      }

      if (name === 'run_command') {
        return { type: 'command', command: args.command, reasoning: args.reasoning, parts };
      }

      if (name === 'send_keys') {
        return { type: 'send_keys', keys: args.keys, reasoning: args.reasoning, parts };
      }
    }

    if (textPart) {
      return { type: 'text', text: textPart.text, parts };
    }

    return { type: 'text', text: 'No response generated.', parts: [{ text: 'No response generated.' }] };
  }, [serverUrl, model]);

  const executeAgentCommand = useCallback(async (command, reasoning, currentHistory) => {
    setAgentSteps((prev) => [...prev, {
      type: 'command',
      command,
      reasoning,
      status: 'running',
    }]);

    let output = '';
    if (onRunAgentCommand) {
      output = await onRunAgentCommand(command);
    } else {
      output = '(No terminal connected for agent execution)';
    }

    const timedOut = output.includes('timed out') || output.includes('waiting for input');

    setAgentSteps((prev) => prev.map((s, i) =>
      i === prev.length - 1
        ? { ...s, output, status: timedOut ? 'timeout' : 'done' }
        : s
    ));

    if (timedOut) {
      setMessages((prev) => [...prev, {
        type: 'system',
        text: 'Command may be waiting for input. Check the terminal and resolve it, then try again.',
      }]);
      abortAgentRef.current = true;
    }

    const modelEntry = {
      role: 'model',
      parts: [{ functionCall: { name: 'run_command', args: { command, reasoning } } }],
    };
    const functionResponseEntry = {
      role: 'user',
      parts: [{ functionResponse: { name: 'run_command', response: { output } } }],
    };

    return [...currentHistory, modelEntry, functionResponseEntry];
  }, [onRunAgentCommand]);

  const executeAgentSendKeys = useCallback(async (keys, reasoning, currentHistory) => {
    setAgentSteps((prev) => [...prev, {
      type: 'send_keys',
      keys,
      reasoning,
      status: 'running',
    }]);

    let output = '';
    if (onSendAgentKeys) {
      output = await onSendAgentKeys(keys);
    } else {
      output = '(No terminal connected for sending keys)';
    }

    setAgentSteps((prev) => prev.map((s, i) =>
      i === prev.length - 1
        ? { ...s, output, status: 'done' }
        : s
    ));

    const modelEntry = {
      role: 'model',
      parts: [{ functionCall: { name: 'send_keys', args: { keys, reasoning } } }],
    };
    const functionResponseEntry = {
      role: 'user',
      parts: [{ functionResponse: { name: 'send_keys', response: { output } } }],
    };

    return [...currentHistory, modelEntry, functionResponseEntry];
  }, [onSendAgentKeys]);

  const startAgentLoop = useCallback(async (userText) => {
    abortAgentRef.current = false;
    setAgentPaused(false);
    pausedResolverRef.current = null;
    lastAgentPromptRef.current = userText;
    setAgentRunning(true);
    setAgentSteps([]);
    setPendingCommand(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const userEntry = { role: 'user', parts: [{ text: userText }] };
    let history = [...agentHistory, userEntry];
    setAgentHistory(history);

    const maxIterations = 20;

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (abortAgentRef.current) {
          setAgentSteps((prev) => [...prev, { type: 'aborted', status: 'done' }]);
          break;
        }

        if (pausedResolverRef.current === 'pending') {
          setAgentPaused(true);
          await new Promise((resolve) => {
            pausedResolverRef.current = resolve;
          });
          setAgentPaused(false);
          if (abortAgentRef.current) {
            setAgentSteps((prev) => [...prev, { type: 'aborted', status: 'done' }]);
            break;
          }
        }

        setIsLoading(true);
        const result = await runAgentStep(history, controller.signal);
        setIsLoading(false);

        if (result.type === 'text') {
          const modelEntry = { role: 'model', parts: result.parts };
          history = [...history, modelEntry];
          setAgentHistory(history);
          setMessages((prev) => [...prev, { type: 'model', text: renderForTerminal(result.text) }]);
          break;
        }

        if (result.type === 'complete') {
          const modelEntry = { role: 'model', parts: result.parts };
          history = [...history, modelEntry];
          setAgentHistory(history);
          setAgentSteps((prev) => [...prev, { type: 'complete', summary: result.summary, status: 'done' }]);

          const functionResponseEntry = {
            role: 'user',
            parts: [{ functionResponse: { name: 'task_complete', response: { acknowledged: true } } }],
          };
          history = [...history, functionResponseEntry];
          setAgentHistory(history);
          break;
        }

        if (result.type === 'command') {
          history = await executeAgentCommand(result.command, result.reasoning, history);
          setAgentHistory(history);
        }

        if (result.type === 'send_keys') {
          history = await executeAgentSendKeys(result.keys, result.reasoning, history);
          setAgentHistory(history);
        }
      }
    } catch (err) {
      setIsLoading(false);
      if (err?.name === 'AbortError') {
        setAgentSteps((prev) => [...prev, { type: 'aborted', status: 'done' }]);
      } else {
        setAgentSteps((prev) => [...prev, {
          type: 'error',
          text: err instanceof Error ? err.message : 'Agent error',
          status: 'done',
        }]);
      }
    } finally {
      setAgentRunning(false);
      setAgentPaused(false);
      setAgentStopping(false);
      pausedResolverRef.current = null;
      abortControllerRef.current = null;
      setIsLoading(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [agentHistory, runAgentStep, executeAgentCommand, executeAgentSendKeys]);

  const stopAgent = useCallback(() => {
    abortAgentRef.current = true;
    setAgentStopping(true);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    onAbortAgentCapture?.();
    if (typeof pausedResolverRef.current === 'function') {
      pausedResolverRef.current();
      pausedResolverRef.current = null;
    }
    setAgentPaused(false);
  }, [onAbortAgentCapture]);

  const pauseAgent = useCallback(() => {
    if (agentRunning && !agentPaused) {
      pausedResolverRef.current = 'pending';
    }
  }, [agentRunning, agentPaused]);

  const resumeAgent = useCallback(() => {
    if (typeof pausedResolverRef.current === 'function') {
      pausedResolverRef.current();
      pausedResolverRef.current = null;
    }
  }, []);

  const retryAgent = useCallback(async () => {
    const lastPrompt = lastAgentPromptRef.current;
    if (!lastPrompt || agentRunning) return;
    setAgentHistory([]);
    setMessages((prev) => [...prev, { type: 'system', text: `retrying: ${lastPrompt}` }]);
    await startAgentLoop(lastPrompt);
  }, [agentRunning, startAgentLoop]);

  /* ── Regular chat send ───────────────────────────────── */

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading || agentRunning) return;

    if (text === 'clear') {
      setMessages([]);
      setCommandHistory([]);
      setAgentHistory([]);
      setAgentSteps([]);
      setInput('');
      return;
    }

    if (text === 'help') {
      setMessages((prev) => [
        ...prev,
        { type: 'system', text: 'Available commands:' },
        { type: 'system', text: '  clear     — Clear the terminal' },
        { type: 'system', text: '  help      — Show this help message' },
        { type: 'system', text: '  model     — Show current model info' },
        { type: 'system', text: '' },
        {
          type: 'system', text: agentMode
            ? 'Agent mode ON — commands will be auto-executed on your terminal.'
            : 'Type any message to chat with Gemini.'
        },
      ]);
      setInput('');
      return;
    }

    if (text === 'model') {
      setMessages((prev) => [
        ...prev,
        { type: 'system', text: `Model: ${model} (via Vertex AI)` },
        { type: 'system', text: `Agent mode: ${agentMode ? 'ON' : 'OFF'}` },
      ]);
      setInput('');
      return;
    }

    setCommandHistory((prev) => [text, ...prev].slice(0, 50));
    setHistoryIndex(-1);

    const fullText = pastedTextRef.current ?? text;
    const displayText = pastedTextRef.current ? text : undefined;
    pastedTextRef.current = null;

    const userEntry = { type: 'user', text: fullText, ...(displayText && { displayText }) };
    setMessages((prev) => [...prev, userEntry]);
    setInput('');

    if (agentMode) {
      await startAgentLoop(fullText);
      return;
    }

    setIsLoading(true);

    try {
      const apiMessages = [...messages, userEntry]
        .filter((m) => m.type === 'user' || m.type === 'model')
        .map((m) => ({ role: m.type === 'user' ? 'user' : 'model', text: m.text }));

      const reply = await callGemini(serverUrl, model, apiMessages);
      setMessages((prev) => [...prev, { type: 'model', text: renderForTerminal(reply) }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { type: 'error', text: err instanceof Error ? err.message : 'Unknown error' },
      ]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }, [input, isLoading, agentRunning, messages, model, agentMode, startAgentLoop, serverUrl]);

  useEffect(() => {
    if (autoSendRef.current && input) {
      autoSendRef.current = false;
      handleSend();
    }
  }, [input, handleSend]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commandHistory.length > 0) {
          const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex]);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex]);
        } else {
          setHistoryIndex(-1);
          setInput('');
        }
      }
    },
    [handleSend, commandHistory, historyIndex],
  );

  const handleClear = useCallback(() => {
    setMessages([]);
    setCommandHistory([]);
    setAgentHistory([]);
    setAgentSteps([]);
  }, []);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setCommandHistory([]);
    setAgentHistory([]);
    setAgentSteps([]);
    setPendingCommand(null);
    lastAgentPromptRef.current = null;
    setInput('');
    setHistoryIndex(-1);
    localStorage.removeItem(CHAT_HISTORY_KEY);
    localStorage.removeItem(CMD_HISTORY_KEY);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  return (
    <div
      className="terminal-container"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          <span className="gemini-toolbar-icon">✦</span>
          <span className="terminal-title">gemini — Vertex AI</span>
          {agentMode && <span className="agent-mode-badge">AGENT</span>}
        </div>
        <div className="toolbar-right-group">
          {agentRunning && (
            <>
              {agentPaused ? (
                <button className="disconnect-btn agent-resume-btn" onClick={resumeAgent}>
                  ▶ Resume
                </button>
              ) : (
                <button className="disconnect-btn agent-pause-btn" onClick={pauseAgent}>
                  ⏸ Pause
                </button>
              )}
              <button
                className={`disconnect-btn agent-stop-btn ${agentStopping ? 'agent-stop-btn--stopping' : ''}`}
                onClick={stopAgent}
                disabled={agentStopping}
              >
                {agentStopping ? (
                  <><span className="agent-stop-spinner" />Stopping…</>
                ) : (
                  '■ Stop'
                )}
              </button>
            </>
          )}
          {!agentRunning && lastAgentPromptRef.current && agentMode && (
            <button className="disconnect-btn agent-retry-btn" onClick={retryAgent}>
              ↻ Retry
            </button>
          )}
          {!agentRunning && (
            <button className="disconnect-btn new-chat-btn" onClick={handleNewChat} title="Start a new chat">
              ✦+ New Chat
            </button>
          )}
          <button className="disconnect-btn" onClick={handleClear} title="Clear screen">
            ⌫
          </button>
        </div>
      </div>

      <div
        className="gemini-terminal"
        ref={scrollRef}
        onClick={() => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) {
            inputRef.current?.focus();
          }
        }}
        style={{ position: 'relative' }}
      >

        {/* Welcome banner */}
        {messages.length === 0 && agentSteps.length === 0 && !isLoading && (
          <div className="gemini-term-welcome">
            <div className="gemini-term-info">
              <span className="gemini-term-label">{model}</span> via Vertex AI
              {agentMode && <span className="agent-welcome-badge">Agent Mode</span>}
            </div>
            <div className="gemini-term-hint">
              {agentMode
                ? <>Ask me to do something on your terminal.  e.g. <span className="gemini-term-cmd">install htop and check system load</span></>
                : <>Type a message to chat, or <span className="gemini-term-cmd">help</span> for commands.</>
              }
            </div>
          </div>
        )}

        {/* Message history */}
        {messages.map((entry, i) => (
          <div key={i} className={`gemini-term-line gemini-term-line--${entry.type}`}>
            {entry.type === 'user' && (
              <>
                <span className="gemini-term-prompt-symbol">
                  {agentMode ? 'agent:/>' : 'gemini:/>'}
                </span>
                <span className="gemini-term-prompt-text">{entry.displayText ?? entry.text}</span>
              </>
            )}
            {entry.type === 'model' && (
              <pre className="gemini-term-response">
                {entry.text.split(/(<cmd>.*?<\/cmd>)/g).map((part, j) => {
                  const match = part.match(/^<cmd>(.*?)<\/cmd>$/);
                  if (match) {
                    const cmd = match[1];
                    return (
                      <span
                        key={j}
                        className="gemini-cmd-tag"
                        title={`Click to run: ${cmd}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRunCommand?.(cmd);
                        }}
                      >
                        {cmd}
                      </span>
                    );
                  }
                  return part;
                })}
              </pre>
            )}
            {entry.type === 'error' && (
              <span className="gemini-term-error">error: {entry.text}</span>
            )}
            {entry.type === 'system' && (
              <span className="gemini-term-system">{entry.text}</span>
            )}
          </div>
        ))}

        {/* Agent steps */}
        {agentSteps.map((step, i) => (
          <div key={`agent-${i}`} className={`agent-step agent-step--${step.type}`}>
            {step.type === 'command' && (
              <>
                <div className="agent-step-header">
                  [{step.status === 'running' ? 'running' : step.status === 'timeout' ? 'timeout' : 'done'}] {step.reasoning}
                </div>
                <div className="agent-step-command">
                  {'> '}{step.command}
                </div>
                {step.output && (
                  <pre className="agent-step-output">
                    {step.output.length > 2000
                      ? step.output.substring(0, 2000) + '\n(truncated)'
                      : step.output}
                  </pre>
                )}
                {step.status === 'timeout' && (
                  <div className="agent-step-timeout-msg">
                    command may need input — check the terminal
                  </div>
                )}
              </>
            )}
            {step.type === 'send_keys' && (
              <>
                <div className="agent-step-header">
                  [{step.status === 'running' ? 'sending' : 'sent'}] {step.reasoning}
                </div>
                <div className="agent-step-command agent-step-keys">
                  {'⌨ '}{step.keys}
                </div>
                {step.output && (
                  <pre className="agent-step-output">
                    {step.output.length > 2000
                      ? step.output.substring(0, 2000) + '\n(truncated)'
                      : step.output}
                  </pre>
                )}
              </>
            )}
            {step.type === 'complete' && (
              <div className="agent-step-complete">
                [complete] {step.summary}
              </div>
            )}
            {step.type === 'aborted' && (
              <div className="agent-step-aborted">
                [stopped] agent stopped by user.
              </div>
            )}
            {step.type === 'error' && (
              <div className="agent-step-error">
                [error] {step.text}
              </div>
            )}
          </div>
        ))}

        {/* Paused indicator */}
        {agentPaused && (
          <div className="gemini-term-line agent-paused-indicator">
            <span className="agent-paused-icon">⏸</span>
            <span className="agent-paused-text">agent paused — click Resume to continue</span>
          </div>
        )}

        {/* Loading indicator */}
        {isLoading && (
          <div className="gemini-term-line gemini-term-line--loading">
            <span className="gemini-term-spinner" />
            <span className="gemini-term-loading-text">
              {agentRunning ? 'agent thinking…' : 'thinking…'}
            </span>
          </div>
        )}

        {/* Input line */}
        {!isLoading && !agentRunning && (
          <div
            className="gemini-term-input-line"
            onClick={() => inputRef.current?.focus()}
          >
            <span className="gemini-term-prompt-symbol">
              {agentMode ? 'agent:/>' : 'gemini:/>'}
            </span>
            <div className="gemini-term-input-wrapper">
              <input
                ref={inputRef}
                className="gemini-term-input"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                autoComplete="off"
                spellCheck="false"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default GeminiChat;
