import { useState, useEffect, useRef } from 'react';

const HISTORY_KEY = 'juni-cli-proton:connection-history';
const MAX_HISTORY = 20;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveToHistory({ host, port, username, password, savePassword }) {
  const history = loadHistory();
  const key = `${host}:${port}:${username}`;
  const filtered = history.filter(
    (h) => `${h.host}:${h.port}:${h.username}` !== key,
  );
  const entry = { host, port, username, lastUsed: Date.now() };
  if (savePassword && password) {
    entry.savedPassword = btoa(password);
  }
  filtered.unshift(entry);
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(filtered.slice(0, MAX_HISTORY)),
  );
}

export { saveToHistory };

export default function ConnectionForm({ onConnect, onLocalConnect }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [savePassword, setSavePassword] = useState(false);
  const [history, setHistory] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [filteredHistory, setFilteredHistory] = useState([]);
  const dropdownRef = useRef(null);
  const hostRef = useRef(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  useEffect(() => {
    if (!host) {
      setFilteredHistory(history);
    } else {
      setFilteredHistory(
        history.filter((h) =>
          h.host.toLowerCase().includes(host.toLowerCase()),
        ),
      );
    }
  }, [host, history]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target) &&
        hostRef.current &&
        !hostRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectHistory = (entry) => {
    setHost(entry.host);
    setPort(String(entry.port));
    setUsername(entry.username);
    if (entry.savedPassword) {
      try {
        setPassword(atob(entry.savedPassword));
        setSavePassword(true);
      } catch {
        setPassword('');
        setSavePassword(false);
      }
    } else {
      setPassword('');
      setSavePassword(false);
    }
    setShowDropdown(false);
    if (entry.savedPassword) {
      document.querySelector('.connect-btn')?.focus();
    } else {
      document.getElementById('password')?.focus();
    }
  };

  const removeHistory = (e, entry) => {
    e.stopPropagation();
    const key = `${entry.host}:${entry.port}:${entry.username}`;
    const updated = history.filter(
      (h) => `${h.host}:${h.port}:${h.username}` !== key,
    );
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    setHistory(updated);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!host || !username) return;
    const credentials = { host, port: Number(port), username, password };
    saveToHistory({ ...credentials, savePassword });
    onConnect(credentials);
  };

  return (
    <div className="connection-form-wrapper">
      <div className="connection-form-container">
        {/* ── Local Terminal ────────────────────────── */}
        <button
          type="button"
          className="local-terminal-btn"
          onClick={onLocalConnect}
        >
          <span className="local-terminal-icon">⬡</span>
          <div className="local-terminal-text">
            <span className="local-terminal-title">Local Terminal</span>
            <span className="local-terminal-sub">Open a shell on this Mac — no login required</span>
          </div>
          <span className="local-terminal-arrow">→</span>
        </button>

        <div className="form-divider">
          <span className="form-divider-text">or connect via SSH</span>
        </div>

        {/* ── SSH Connection Form ───────────────────── */}
        <form className="connection-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-group host-group">
              <label htmlFor="host">Host</label>
              <div className="host-input-wrapper">
                <input
                  id="host"
                  ref={hostRef}
                  type="text"
                  placeholder="192.168.1.1 or hostname"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onFocus={() => history.length > 0 && setShowDropdown(true)}
                  autoComplete="off"
                  required
                />
                {history.length > 0 && (
                  <button
                    type="button"
                    className="dropdown-toggle"
                    onClick={() => setShowDropdown(!showDropdown)}
                    tabIndex={-1}
                    aria-label="Show connection history"
                  >
                    ▾
                  </button>
                )}
                {showDropdown && filteredHistory.length > 0 && (
                  <ul className="host-dropdown" ref={dropdownRef}>
                    {filteredHistory.map((entry) => (
                      <li
                        key={`${entry.host}:${entry.port}:${entry.username}`}
                        onClick={() => selectHistory(entry)}
                      >
                        <div className="history-entry">
                          <span className="history-host">{entry.host}</span>
                          <span className="history-detail">
                            {entry.username}@:{entry.port}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="history-remove"
                          onClick={(e) => removeHistory(e, entry)}
                          title="Remove from history"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="form-group port-group">
              <label htmlFor="port">Port</label>
              <input
                id="port"
                type="number"
                placeholder="22"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                min="1"
                max="65535"
              />
            </div>

            <div className="form-group">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                placeholder="root"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <label className="save-password-toggle">
              <input
                type="checkbox"
                checked={savePassword}
                onChange={(e) => setSavePassword(e.target.checked)}
              />
              <span className="save-password-label">Save password</span>
            </label>
          </div>

          <button type="submit" className="connect-btn">
            <span className="btn-icon">→</span>
            Connect via SSH
          </button>
        </form>
      </div>
    </div>
  );
}
