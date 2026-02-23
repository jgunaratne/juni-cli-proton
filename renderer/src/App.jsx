import { useState, useCallback, useRef, useEffect } from 'react';
import ConnectionForm from './components/ConnectionForm';
import Terminal from './components/Terminal';
import GeminiChat from './components/GeminiChat';
import ClaudeChat from './components/ClaudeChat';

import './App.css';

let nextId = 1;
const SPLIT_GEMINI_ID = '__split_gemini__';

const GEMINI_MODELS = [
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

const MONO_FONTS = [
  { id: 'Ubuntu Mono', label: 'Ubuntu Mono', google: true },
  { id: 'JetBrains Mono', label: 'JetBrains Mono', google: true },
  { id: 'Fira Code', label: 'Fira Code', google: true },
  { id: 'Source Code Pro', label: 'Source Code Pro', google: true },
  { id: 'Inconsolata', label: 'Inconsolata', google: true },
  { id: 'IBM Plex Mono', label: 'IBM Plex Mono', google: true },
  { id: 'Space Mono', label: 'Space Mono', google: true },
  { id: 'Roboto Mono', label: 'Roboto Mono', google: true },
  { id: 'SF Mono', label: 'SF Mono (macOS)', google: false },
  { id: 'Menlo', label: 'Menlo (macOS)', google: false },
];

const SETTINGS_KEY = 'juni-cli-proton:settings';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function loadGoogleFont(fontName) {
  const id = `gfont-${fontName.replace(/\s+/g, '-')}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;500;700&display=swap`;
  document.head.appendChild(link);
}

function App() {
  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [showForm, setShowForm] = useState(true);
  const [splitMode, setSplitMode] = useState(() => {
    const s = loadSettings();
    return s.splitMode ?? false;
  });
  const [splitGeminiStatus, setSplitGeminiStatus] = useState('connecting');
  const [splitFocus, setSplitFocus] = useState('left');
  const [splitRatio, setSplitRatio] = useState(50);
  const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');
  const [autoExecute, setAutoExecute] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [stepThrough, setStepThrough] = useState(false);
  const [serverUrl, setServerUrl] = useState('');

  const saved = loadSettings();
  const [fontFamily, setFontFamily] = useState(saved.fontFamily || 'Ubuntu Mono');
  const [fontSize, setFontSize] = useState(saved.fontSize || 15);
  const [bgColor, setBgColor] = useState(saved.bgColor || '#0d1117');
  const [claudeEnabled, setClaudeEnabled] = useState(saved.claudeEnabled ?? false);
  const [geminiApiKey, setGeminiApiKey] = useState(saved.geminiApiKey || '');
  const [showApiKey, setShowApiKey] = useState(false);

  const terminalRefs = useRef({});
  const splitGeminiRef = useRef(null);
  const settingsRef = useRef(null);
  const isDragging = useRef(false);
  const mainRef = useRef(null);

  // Discover server port from Electron main process
  useEffect(() => {
    async function discoverServer() {
      if (window.proton?.isProton) {
        const port = await window.proton.getServerPort();
        setServerUrl(`http://127.0.0.1:${port}`);
      } else {
        // Dev mode fallback
        setServerUrl(import.meta.env.VITE_SERVER_URL || window.location.origin);
      }
    }
    discoverServer();
  }, []);

  useEffect(() => {
    const font = MONO_FONTS.find((f) => f.id === fontFamily);
    if (font?.google) loadGoogleFont(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ fontFamily, fontSize, bgColor, claudeEnabled, splitMode, geminiApiKey }));
  }, [fontFamily, fontSize, bgColor, claudeEnabled, splitMode, geminiApiKey]);

  useEffect(() => {
    document.documentElement.style.setProperty('--terminal-font', `'${fontFamily}', monospace`);
    document.documentElement.style.setProperty('--terminal-font-size', `${fontSize}px`);
    document.documentElement.style.setProperty('--terminal-bg', bgColor);
  }, [fontFamily, fontSize, bgColor]);

  const handleDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      setSplitRatio(Math.min(Math.max(pct, 15), 85));
    };
    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    const handleClick = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSettings]);

  useEffect(() => {
    if (!splitMode) return;

    const handleKeyDown = (e) => {
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        setSplitFocus((prev) => {
          const next = prev === 'left' ? 'right' : 'left';
          if (next === 'right') {
            splitGeminiRef.current?.focus();
          } else if (activeTab && terminalRefs.current[activeTab]) {
            terminalRefs.current[activeTab].focus();
          }
          return next;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [splitMode, activeTab]);

  const handleConnect = useCallback((credentials) => {
    const id = nextId++;
    const newTab = { id, type: 'ssh', connection: credentials, status: 'connecting' };
    setTabs((prev) => [...prev, newTab]);
    setActiveTab(id);
    setShowForm(false);
  }, []);

  const handleLocalConnect = useCallback(() => {
    const id = nextId++;
    const newTab = {
      id,
      type: 'ssh',
      connection: { host: 'localhost', port: 0, username: '', local: true },
      status: 'connecting',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTab(id);
    setShowForm(false);
  }, []);

  const handleOpenGemini = useCallback(() => {
    const id = nextId++;
    const newTab = { id, type: 'gemini', status: 'connecting' };
    setTabs((prev) => [...prev, newTab]);
    setActiveTab(id);
    setShowForm(false);
  }, []);

  const handleOpenClaude = useCallback(() => {
    const id = nextId++;
    const newTab = { id, type: 'claude', status: 'connecting' };
    setTabs((prev) => [...prev, newTab]);
    setActiveTab(id);
    setShowForm(false);
  }, []);

  const handleStatusChange = useCallback((tabId, newStatus) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, status: newStatus } : t)),
    );
  }, []);

  const handleCloseTab = useCallback(
    (tabId) => {
      setTabs((prev) => {
        const updated = prev.filter((t) => t.id !== tabId);
        if (activeTab === tabId) {
          if (updated.length > 0) {
            setActiveTab(updated[updated.length - 1].id);
            setShowForm(false);
          } else {
            setActiveTab(null);
            setShowForm(true);
          }
        }
        return updated;
      });
    },
    [activeTab],
  );

  const handleNewTab = useCallback(() => {
    setShowForm(true);
    setActiveTab(null);
  }, []);

  const switchTab = useCallback((tabId) => {
    setActiveTab(tabId);
    setShowForm(false);
  }, []);

  const toggleSplit = useCallback(() => {
    setSplitMode((prev) => !prev);
  }, []);

  const sendToGemini = useCallback(() => {
    if (!splitMode || !activeTab) return;
    const termRef = terminalRefs.current[activeTab];
    if (!termRef) return;
    const text = termRef.getBufferText();
    if (!text.trim()) return;
    splitGeminiRef.current?.pasteText(text);
  }, [splitMode, activeTab]);

  const sendToTerminal = useCallback(() => {
    if (!splitMode || !activeTab) return;
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (!text.trim()) return;
    const termRef = terminalRefs.current[activeTab];
    if (!termRef) return;
    termRef.writeToTerminal(text);
    termRef.focus();
  }, [splitMode, activeTab]);

  const handleRunCommand = useCallback((cmd) => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return;
    const termRef = terminalRefs.current[sshTabId];
    if (!termRef) return;
    termRef.writeToTerminal(autoExecute ? cmd + '\n' : cmd);
    termRef.focus();
  }, [activeTab, tabs, autoExecute]);

  const handleRunAgentCommand = useCallback(async (command) => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return '(No SSH terminal connected)';
    const termRef = terminalRefs.current[sshTabId];
    if (!termRef) return '(Terminal ref not found)';
    return termRef.runAgentCommand(command);
  }, [activeTab, tabs]);

  const handleSendAgentKeys = useCallback(async (keys) => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return '(No SSH terminal connected)';
    const termRef = terminalRefs.current[sshTabId];
    if (!termRef) return '(Terminal ref not found)';
    return termRef.sendAgentKeys(keys);
  }, [activeTab, tabs]);

  const handleAbortAgentCapture = useCallback(() => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return;
    const termRef = terminalRefs.current[sshTabId];
    if (termRef) termRef.abortAgentCapture();
  }, [activeTab, tabs]);

  const getTabLabel = (tab) => {
    if (tab.type === 'gemini') return 'Gemini';
    if (tab.type === 'claude') return 'Claude';
    if (tab.connection?.local) return 'local';
    return `${tab.connection.username}@${tab.connection.host}`;
  };

  const activeSession = tabs.find((t) => t.id === activeTab);
  const displayStatus = showForm
    ? tabs.length > 0
      ? `${tabs.length} session${tabs.length > 1 ? 's' : ''}`
      : 'disconnected'
    : activeSession?.status || 'disconnected';

  const hasReadySSH = tabs.some((t) => t.type === 'ssh' && t.status === 'ready');
  const activeIsGeminiTab = activeSession?.type === 'gemini';

  // Don't render until server URL is known
  if (!serverUrl) {
    return (
      <div className="app">
        <div className="proton-loading">
          <div className="proton-loading-icon">⬡</div>
          <div className="proton-loading-text">Starting juni-cli-proton…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        {/* macOS drag region */}
        <div className="titlebar-drag-region" />
        <div className="logo">
          <span className="logo-icon">⬡</span>
          <h1>juni-cli<span className="proton-badge">proton</span></h1>
        </div>
        <div className="header-right">
          {hasReadySSH && (
            <button
              className={`split-toggle ${splitMode ? 'split-toggle--active' : ''}`}
              onClick={toggleSplit}
              title={splitMode ? 'Exit split screen' : 'Split screen: Terminal + Gemini'}
            >
              <span className="split-toggle-icon">⬡</span>
              {splitMode ? 'Exit Split' : 'Split'}
            </button>
          )}
          {splitMode && activeSession?.type === 'ssh' && (
            <>
              <button
                className="split-toggle split-toggle--send"
                onClick={sendToGemini}
                title="Copy terminal output to Gemini input"
              >
                <span className="split-toggle-icon">→✦</span>
                Send to Gemini
              </button>
              <button
                className="split-toggle split-toggle--send"
                onClick={sendToTerminal}
                title="Paste highlighted Gemini text into terminal"
              >
                <span className="split-toggle-icon">✦→</span>
                Send to Terminal
              </button>
            </>
          )}
          {hasReadySSH && (
            <>
              <select
                className="model-selector"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                title="Select Gemini model"
              >
                {GEMINI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <label className="auto-execute-toggle" title="When enabled, clicking a command will execute it immediately">
                <input
                  type="checkbox"
                  checked={autoExecute}
                  onChange={(e) => setAutoExecute(e.target.checked)}
                />
                <span className="auto-execute-label">Auto-execute</span>
              </label>
              <button
                className={`agent-toggle ${agentMode ? 'agent-toggle--active' : ''}`}
                onClick={() => setAgentMode((prev) => !prev)}
                title={agentMode ? 'Disable agent mode' : 'Enable agent mode: Gemini can execute commands autonomously'}
              >
                <span className="agent-toggle-icon">⚡</span>
                {agentMode ? 'Agent ON' : 'Agent'}
              </button>
              {agentMode && (
                <button
                  className={`agent-toggle ${stepThrough ? 'agent-toggle--active' : ''}`}
                  onClick={() => setStepThrough((prev) => !prev)}
                  title={stepThrough ? 'Disable step-through: commands run automatically' : 'Enable step-through: approve each command before it runs'}
                >
                  {stepThrough ? '⏯ Step ON' : '⏯ Step'}
                </button>
              )}
            </>
          )}
          <div className="settings-wrapper" ref={settingsRef}>
            <button
              className={`settings-gear ${showSettings ? 'settings-gear--active' : ''}`}
              onClick={() => setShowSettings((prev) => !prev)}
              title="Settings"
            >
              ⚙
            </button>
            {showSettings && (
              <div className="settings-panel">
                <div className="settings-title">Settings</div>
                <div className="settings-group">
                  <label className="settings-label">Font Family</label>
                  <select
                    className="settings-select"
                    value={fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                  >
                    {MONO_FONTS.map((f) => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </select>
                </div>
                <div className="settings-group">
                  <label className="settings-label">
                    Font Size: {fontSize}px
                  </label>
                  <input
                    type="range"
                    className="settings-range"
                    min="10"
                    max="22"
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                </div>
                <div className="settings-group">
                  <label className="settings-label">Background Color</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="color"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                      style={{ width: '32px', height: '32px', border: 'none', cursor: 'pointer', background: 'none' }}
                    />
                    <input
                      className="settings-input"
                      type="text"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      className="settings-reset-btn"
                      onClick={() => setBgColor('#0d1117')}
                      title="Reset to default"
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={claudeEnabled}
                    onChange={(e) => setClaudeEnabled(e.target.checked)}
                  />
                  <span className="settings-toggle-label">Enable Claude</span>
                </label>

                <div className="settings-group">
                  <label className="settings-label">Gemini API Key (GenAI)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      className="settings-input"
                      type={showApiKey ? 'text' : 'password'}
                      value={geminiApiKey}
                      onChange={(e) => setGeminiApiKey(e.target.value)}
                      placeholder="Enter your Gemini API key…"
                      spellCheck="false"
                      autoComplete="off"
                      style={{ flex: 1, fontFamily: 'monospace' }}
                    />
                    <button
                      className="settings-reset-btn"
                      onClick={() => setShowApiKey((prev) => !prev)}
                      title={showApiKey ? 'Hide API key' : 'Show API key'}
                      style={{ minWidth: '52px' }}
                    >
                      {showApiKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.4 }}>
                    Required for Gemini 3 Flash (Google AI).
                  </div>
                </div>

                <div className="settings-preview" style={{ fontFamily: `'${fontFamily}', monospace`, fontSize: `${fontSize}px` }}>
                  The quick brown fox jumps over the lazy dog
                </div>
              </div>
            )}
          </div>
          <div className="status-bar">
            <span className={`status-dot ${activeSession?.status || ''}`} />
            <span className="status-text">{displayStatus}</span>
          </div>
        </div>
      </header>

      {/* ── Tab bar ──────────────────────────────────────── */}
      {(tabs.length > 0 || showForm) && (
        <div className="tab-bar">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTab && !showForm ? 'active' : ''} ${tab.type === 'gemini' ? 'tab--gemini' : ''} ${tab.type === 'claude' ? 'tab--claude' : ''}`}
              onClick={() => switchTab(tab.id)}
            >
              {tab.type === 'gemini' ? (
                <span className="tab-gemini-icon">✦</span>
              ) : tab.type === 'claude' ? (
                <span className="tab-gemini-icon" style={{ color: '#d4a574' }}>◈</span>
              ) : (
                <span className={`tab-status-dot ${tab.status}`} />
              )}
              <span className="tab-label">
                {getTabLabel(tab)}
              </span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
                title="Close session"
              >
                ✕
              </button>
            </div>
          ))}

          {/* ── New tab buttons ─────────────────────────── */}
          <div className="tab-new-group">
            <button className="tab-new" onClick={handleNewTab} title="New SSH connection">
              +
            </button>
            {hasReadySSH && (
              <button
                className="tab-new tab-new--gemini"
                onClick={handleOpenGemini}
                title="New Gemini chat"
              >
                ✦
              </button>
            )}
            {hasReadySSH && claudeEnabled && (
              <button
                className="tab-new tab-new--claude"
                onClick={handleOpenClaude}
                title="New Claude chat"
              >
                ◈
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Content ─────────────────────────────────────── */}
      <main className={`app-main ${splitMode ? 'app-main--split' : ''}`} ref={mainRef} style={splitMode ? { '--split-left-width': `${splitRatio}%` } : undefined}>
        {/* Left panel (or full panel when not split) */}
        <div className={`split-panel split-panel--left ${splitMode ? '' : 'split-panel--full'}`}>
          {showForm && <ConnectionForm onConnect={handleConnect} onLocalConnect={handleLocalConnect} />}

          {tabs.map((tab) =>
            tab.type === 'ssh' ? (
              <Terminal
                key={tab.id}
                ref={(el) => {
                  if (el) terminalRefs.current[tab.id] = el;
                  else delete terminalRefs.current[tab.id];
                }}
                tabId={tab.id}
                connection={tab.connection}
                isActive={tab.id === activeTab && !showForm}
                onStatusChange={(status) => handleStatusChange(tab.id, status)}
                onClose={() => handleCloseTab(tab.id)}
                fontFamily={fontFamily}
                fontSize={fontSize}
                bgColor={bgColor}
                serverUrl={serverUrl}
              />
            ) : tab.type === 'gemini' ? (
              !splitMode && (
                <GeminiChat
                  key={tab.id}
                  model={selectedModel}
                  isActive={tab.id === activeTab && !showForm}
                  onStatusChange={(status) => handleStatusChange(tab.id, status)}
                  onClose={() => handleCloseTab(tab.id)}
                  onRunCommand={handleRunCommand}
                  agentMode={agentMode}
                  onRunAgentCommand={handleRunAgentCommand}
                  onSendAgentKeys={handleSendAgentKeys}
                  onAbortAgentCapture={handleAbortAgentCapture}
                    onReadTerminal={() => {
                      const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh') ? activeTab : tabs.find((t) => t.type === 'ssh')?.id;
                      if (!sshTabId) return '(No terminal connected)';
                      const termRef = terminalRefs.current[sshTabId];
                      return termRef ? termRef.getBufferText() : '(Terminal ref not found)';
                    }}
                    stepThrough={stepThrough}
                  serverUrl={serverUrl}
                    apiKey={geminiApiKey}
                />
              )
            ) : tab.type === 'claude' ? (
              !splitMode && (
                <ClaudeChat
                  key={tab.id}
                  isActive={tab.id === activeTab && !showForm}
                  onStatusChange={(status) => handleStatusChange(tab.id, status)}
                  onClose={() => handleCloseTab(tab.id)}
                  onRunCommand={handleRunCommand}
                  serverUrl={serverUrl}
                />
              )
            ) : null,
          )}
        </div>

        {/* Right panel — Gemini (only in split mode) */}
        {splitMode && (
          <>
            <div className="split-divider" onMouseDown={handleDividerMouseDown} />
            <div className="split-panel split-panel--right">
              <GeminiChat
                key={SPLIT_GEMINI_ID}
                ref={splitGeminiRef}
                model={selectedModel}
                isActive={true}
                onStatusChange={(status) => setSplitGeminiStatus(status)}
                onClose={() => setSplitMode(false)}
                onRunCommand={handleRunCommand}
                agentMode={agentMode}
                onRunAgentCommand={handleRunAgentCommand}
                onSendAgentKeys={handleSendAgentKeys}
                onAbortAgentCapture={handleAbortAgentCapture}
                onReadTerminal={() => {
                  const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh') ? activeTab : tabs.find((t) => t.type === 'ssh')?.id;
                  if (!sshTabId) return '(No terminal connected)';
                  const termRef = terminalRefs.current[sshTabId];
                  return termRef ? termRef.getBufferText() : '(Terminal ref not found)';
                }}
                stepThrough={stepThrough}
                serverUrl={serverUrl}
                apiKey={geminiApiKey}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
