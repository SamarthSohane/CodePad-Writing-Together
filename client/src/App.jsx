import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Editor from '@monaco-editor/react';
import { ChevronDown, Code2, Copy, Ellipsis, LockKeyhole, LogOut, Menu, Users, X } from 'lucide-react';
import './App.css';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;
const COLORS = ['#4f9cf9', '#32b583', '#a78bfa', '#e8a23a', '#e46b9b', '#48b7c7'];
const LANGUAGES = [
  ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'],
  ['html', 'HTML'], ['css', 'CSS'], ['json', 'JSON'], ['markdown', 'Markdown'], ['cpp', 'C++']
];
const LANGUAGE_VALUES = new Set(LANGUAGES.map(([value]) => value));

function useRoomSocket({ onRoom, onMembers, onCode, onClear, onLanguage, onCursor, onTyping, onHistory, onThrottle, onError }) {
  const socketRef = useRef(null);
  const callbacks = useRef({});
  const [status, setStatus] = useState('offline');
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [room, setRoom] = useState(null);

  useEffect(() => { callbacks.current = { onRoom, onMembers, onCode, onClear, onLanguage, onCursor, onTyping, onHistory, onThrottle, onError }; }, [onRoom, onMembers, onCode, onClear, onLanguage, onCursor, onTyping, onHistory, onThrottle, onError]);

  const join = useCallback(({ roomId, passcode, username, color }) => {
    setIsJoining(true); setJoinError('');
    const socket = io(SOCKET_URL, { reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000, timeout: 10000 });
    socketRef.current = socket;
    const payload = () => ({ roomId: roomId.trim(), passcode: passcode.trim(), username: username.trim(), color });
    const admit = (res) => {
      setIsJoining(false);
      if (!res?.success) { setJoinError(res?.error || 'Could not open this room.'); socket.disconnect(); return; }
      setRoom(res.room); callbacks.current.onRoom?.(res.room); setStatus('connected');
    };
    socket.on('connect', () => { setStatus('connected'); socket.emit('join_room', payload(), admit); });
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('reconnect_attempt', () => setStatus('syncing'));
    socket.on('reconnect', () => { setStatus('syncing'); socket.emit('join_room', payload(), (res) => { if (res?.success) { setRoom(res.room); callbacks.current.onRoom?.(res.room); setStatus('connected'); } else { setJoinError(res?.error || 'Could not reconnect.'); } }); });
    socket.on('connect_error', (err) => {
      setIsJoining(false);
      setStatus('offline');
      const isMissingUrl = !SOCKET_URL && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
      setJoinError(
        isMissingUrl
          ? 'Cannot connect to server. Please set VITE_SOCKET_URL in your Vercel Project Settings to your deployed backend URL.'
          : `Connection error: ${err?.message || 'Server unreachable'}`
      );
    });
    socket.on('members_updated', data => callbacks.current.onMembers?.(data));
    socket.on('code_change', data => callbacks.current.onCode?.(data.fullCode));
    socket.on('code_cleared', () => callbacks.current.onClear?.());
    socket.on('language_changed', data => callbacks.current.onLanguage?.(data.language));
    socket.on('peer_cursor_update', data => callbacks.current.onCursor?.(data));
    socket.on('peer_typing_status', data => callbacks.current.onTyping?.(data));
    socket.on('audit_log_entry', data => callbacks.current.onHistory?.(data));
    socket.on('throttle_warning', data => callbacks.current.onThrottle?.(data.message));
    socket.on('error_notification', data => callbacks.current.onError?.(data));
  }, []);

  const leave = useCallback(() => { socketRef.current?.disconnect(); socketRef.current = null; setRoom(null); setStatus('offline'); }, []);
  useEffect(() => () => socketRef.current?.disconnect(), []);
  const emit = useCallback((event, data) => socketRef.current?.connected && socketRef.current.emit(event, data), []);
  return { socketRef, room, status, isJoining, joinError, join, leave, emit };
}

function useEditorCollaboration({ editorRef, monacoRef, members, emit, roomCode }) {
  const remoteDecorations = useRef(new Map());
  const typingTimer = useRef(null);
  const remoteChange = useRef(false);
  const applyRemoteCode = useCallback((code) => {
    const editor = editorRef.current; const model = editor?.getModel();
    if (!model || model.getValue() === code) return;
    remoteChange.current = true; const view = editor.saveViewState(); model.setValue(code || ''); if (view) editor.restoreViewState(view); remoteChange.current = false;
  }, [editorRef]);
  useEffect(() => { if (roomCode !== undefined) applyRemoteCode(roomCode); }, [roomCode, applyRemoteCode]);
  useEffect(() => () => { remoteDecorations.current.clear(); clearTimeout(typingTimer.current); }, []);
  const onChange = useCallback((value) => {
    if (remoteChange.current) return;
    emit('code_change', { change: null, fullCode: value || '' }); emit('typing_status', { isTyping: true });
    clearTimeout(typingTimer.current); typingTimer.current = setTimeout(() => emit('typing_status', { isTyping: false }), 1200);
  }, [emit]);
  const onMount = useCallback((editor, monaco) => {
    editorRef.current = editor; monacoRef.current = monaco;
    editor.onDidChangeCursorPosition(e => emit('cursor_move', { cursor: { lineNumber: e.position.lineNumber, column: e.position.column }, selection: editor.getSelection() }));
  }, [editorRef, monacoRef, emit]);
  const updateCursor = useCallback(({ socketId, cursor, selection }) => {
    if (!editorRef.current || !monacoRef.current || !cursor) return;
    const peer = members.find(item => item.socketId === socketId); if (!peer) return;
    const old = remoteDecorations.current.get(socketId) || [];
    const ranges = [
      { range: new monacoRef.current.Range(cursor.lineNumber, 1, cursor.lineNumber, 1), options: { isWholeLine: true, className: 'remote-line', overviewRuler: { color: peer.color, position: 2 } } },
      { range: new monacoRef.current.Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column), options: { className: 'remote-caret', before: { content: ` ${peer.username} `, inlineClassName: 'remote-label', inlineClassNameAffectsLetterSpacing: true } } }
    ];
    if (selection && selection.startLineNumber !== selection.endLineNumber) ranges.push({ range: new monacoRef.current.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn), options: { className: 'remote-selection' } });
    remoteDecorations.current.set(socketId, editorRef.current.deltaDecorations(old, ranges));
  }, [editorRef, monacoRef, members]);
  return { onChange, onMount, updateCursor, applyRemoteCode };
}

function Logo() { return <div className="logo"><Code2 size={17} strokeWidth={2.4} /><span>CodePad</span></div>; }
function ConnectionStatus({ status }) { const labels = { connected: 'Synced', syncing: 'Syncing', offline: 'Offline' }; return <div className={`connection connection-${status}`} aria-live="polite"><span className="connection-dot" />{labels[status]}</div>; }

function LobbyPage({ join, isJoining, joinError }) {
  const [room, setRoom] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState(''); const [color, setColor] = useState(COLORS[0]);
  return <main className="lobby-page"><div className="lobby-shell"><Logo /><div className="lobby-copy"><h1>Write together.</h1><p>Open a shared coding room and start building together.</p></div><form className="join-form" onSubmit={e => { e.preventDefault(); join({ roomId: room, passcode: password, username: name, color }); }}>
    <label>Room<input value={room} onChange={e => setRoom(e.target.value)} placeholder="room-name" required autoFocus /></label>
    <label>Your name<input value={name} onChange={e => setName(e.target.value)} placeholder="How should we call you?" required /></label>
    <label>Password <span>(optional)</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank for an open room" /></label>
    <fieldset><legend>Choose your color</legend><div className="color-picker">{COLORS.map(c => <button type="button" key={c} className={`color-choice ${color === c ? 'selected' : ''}`} style={{ '--color': c }} aria-label={`Choose ${c} as your color`} aria-pressed={color === c} onClick={() => setColor(c)} />)}</div></fieldset>
    {joinError && <p className="form-error" role="alert">{joinError}</p>}<button className="primary-button" disabled={isJoining}>{isJoining ? 'Opening room…' : 'Open room'}</button>
  </form><p className="lobby-note">No account needed. Room content is shared with everyone who has access.</p></div></main>;
}

function WorkspaceHeader({ room, members, status, onCopy, onLeave, onOpenPanel }) { return <header className="workspace-header"><div className="header-leading"><Logo /><span className="slash">/</span><span className="room-name">{room?.id}</span><button className="icon-button" onClick={onCopy} aria-label="Copy room ID" title="Copy room ID"><Copy size={14} /></button></div><div className="header-middle"><ConnectionStatus status={status} /></div><nav className="header-actions"><button className="text-button people-button" onClick={() => onOpenPanel('people')}><Users size={15} /> <span>People</span> <b>{members.length}</b></button><button className="icon-button" onClick={() => onOpenPanel('menu')} aria-label="Open room menu"><Ellipsis size={18} /></button><button className="text-button leave-button" onClick={onLeave}><LogOut size={14} /> <span>Leave</span></button></nav></header>; }

function EditorToolbar({ language, setLanguage, isHost, onClear, onOpenPanel }) { return <div className="editor-toolbar"><label className="language-select">Language <ChevronDown size={13} /><select value={language} onChange={e => setLanguage(e.target.value)} aria-label="Editor language">{LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="toolbar-divider" /><span className="save-state"><span className="save-dot" />Saved</span><button className="toolbar-more" onClick={() => onOpenPanel('menu')} aria-label="More editor actions"><Ellipsis size={16} /></button>{isHost && <button className="clear-action" onClick={onClear}>Clear pad</button>}</div>; }

function Sidebar({ members, history, activePanel, setActivePanel, currentId }) { const shown = activePanel === 'history'; return <aside className={`workspace-sidebar ${activePanel === 'closed' ? 'sidebar-hidden' : ''}`}><div className="sidebar-tabs"><button className={shown ? '' : 'active'} onClick={() => setActivePanel('people')}>People <span>{members.length}</span></button><button className={shown ? 'active' : ''} onClick={() => setActivePanel('history')}>History</button><button className="mobile-close" onClick={() => setActivePanel('closed')} aria-label="Close panel"><X size={16} /></button></div>{shown ? <HistoryPanel history={history} /> : <PeoplePanel members={members} currentId={currentId} />}</aside>; }
function PeoplePanel({ members, currentId }) { return <div className="panel-content"><div className="panel-heading">In this room <span>{members.length}</span></div>{members.length === 0 ? <div className="empty-panel">No one else is here yet.</div> : members.map(member => <div className="person-row" key={member.socketId}><span className="person-dot" style={{ '--color': member.color }} /><div><div className="person-name">{member.username}{member.socketId === currentId && <span className="you-label">You</span>}</div><div className="person-role">{member.isHost ? 'Host' : 'Collaborator'}</div></div></div>)}</div>; }
function HistoryPanel({ history }) { return <div className="panel-content"><div className="panel-heading">Recent changes</div>{history.length === 0 ? <div className="empty-panel">No activity yet.</div> : <div className="history-list">{history.map(item => <div className="history-item" key={item.id}><span className="history-time">{item.timestamp}</span><span>{item.text}</span></div>)}</div>}</div>; }

function MenuPanel({ room, onClose }) { return <div className="room-menu"><div className="menu-heading"><span>Room details</span><button className="icon-button" onClick={onClose} aria-label="Close room details"><X size={15} /></button></div><dl><dt>Room ID</dt><dd>{room?.id}</dd><dt>Access</dt><dd>{room?.hasPasscode ? <><LockKeyhole size={13} /> Password protected</> : 'Open room'}</dd><dt>Language</dt><dd>{LANGUAGES.find(([v]) => v === room?.language)?.[1] || room?.language}</dd></dl></div>; }

export default function App() {
  const [inRoom, setInRoom] = useState(false); const [room, setRoom] = useState(null); const [members, setMembers] = useState([]); const [history, setHistory] = useState([]); const [language, setLanguage] = useState('javascript'); const [code, setCode] = useState(''); const [panel, setPanel] = useState('people'); const [toast, setToast] = useState(''); const [typing, setTyping] = useState({}); const [confirmClear, setConfirmClear] = useState(false);
  const editorRef = useRef(null); const monacoRef = useRef(null); const toastTimer = useRef(null);
  const showToast = useCallback(msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2600); }, []);
  const addHistory = useCallback(item => setHistory(h => [...h, item].slice(-100)), []);
  const onRoom = useCallback(r => { setRoom(r); setMembers(r.members || []); setHistory(r.auditLog || []); setLanguage(LANGUAGE_VALUES.has(r.language) ? r.language : 'javascript'); setCode(r.code || '// Start writing together...'); setInRoom(true); }, []);
  const onMembers = useCallback(m => { setMembers(m); setTyping(t => Object.fromEntries(Object.entries(t).filter(([id]) => m.some(member => member.socketId === id)))); }, []);
  const onCode = useCallback(c => setCode(c), []); const onClear = useCallback(() => setCode(''), []); const onHistory = useCallback(item => addHistory(item), [addHistory]);
  const onLanguage = useCallback(l => { if (LANGUAGE_VALUES.has(l)) { setLanguage(l); setRoom(r => r ? { ...r, language: l } : r); } }, []);
  const cursorHandler = useRef(null);
  const onCursor = useCallback(data => cursorHandler.current?.(data), []);
  const onTyping = useCallback(({ socketId, isTyping }) => setTyping(t => ({ ...t, [socketId]: isTyping })), []);
  const onError = useCallback(msg => showToast(msg), [showToast]); const onThrottle = useCallback(msg => showToast(msg), [showToast]);
  const socket = useRoomSocket({ onRoom, onMembers, onCode, onClear, onLanguage, onCursor, onTyping, onHistory, onThrottle, onError });
  const editor = useEditorCollaboration({ editorRef, monacoRef, members, emit: socket.emit, roomCode: code });
  const currentId = socket.socketRef.current?.id; const isHost = members.some(m => m.socketId === currentId && m.isHost);
  const copyRoom = () => { navigator.clipboard?.writeText(room?.id || ''); showToast('Room ID copied.'); };
  const leave = () => { socket.leave(); setInRoom(false); setRoom(null); setMembers([]); setHistory([]); setTyping({}); setPanel('people'); };
  const changeLanguage = value => { if (LANGUAGE_VALUES.has(value)) { setLanguage(value); socket.emit('language_change', { language: value }); } };
  const clearPad = () => { if (isHost) setConfirmClear(true); };
  useEffect(() => { cursorHandler.current = editor.updateCursor; }, [editor.updateCursor]);
  if (!inRoom) return <LobbyPage join={socket.join} isJoining={socket.isJoining} joinError={socket.joinError} />;
  return <div className="app-shell"><WorkspaceHeader room={room} members={members} status={socket.status} onCopy={copyRoom} onLeave={leave} onOpenPanel={setPanel} /><main className="workspace"><section className="editor-column"><EditorToolbar language={language} setLanguage={changeLanguage} isHost={isHost} onClear={clearPad} onOpenPanel={setPanel} /><div className="editor-wrap"><Editor height="100%" language={language} theme="vs-dark" defaultValue={code} onMount={editor.onMount} onChange={editor.onChange} options={{ fontSize: 14, fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace", lineNumbers: 'on', minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, wordWrap: 'on', renderWhitespace: 'selection', padding: { top: 14 } }} /></div><div className="editor-status"><span>{language.toUpperCase()}</span><span>{Object.values(typing).some(Boolean) ? 'Someone is editing' : 'Ready to edit'}</span></div></section><Sidebar members={members} history={history} activePanel={panel === 'history' || panel === 'people' ? panel : 'closed'} setActivePanel={setPanel} currentId={currentId} />{panel === 'menu' && <MenuPanel room={room} onClose={() => setPanel('people')} />}</main>{toast && <div className="toast" role="status">{toast}</div>}{confirmClear && <div className="dialog-backdrop" role="presentation"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-title"><h2 id="clear-title">Clear shared pad?</h2><p>This will remove the code for everyone in the room.</p><div className="dialog-actions"><button className="text-button" onClick={() => setConfirmClear(false)}>Cancel</button><button className="danger-button" onClick={() => { socket.emit('host_clear_pad'); setConfirmClear(false); }}>Clear pad</button></div></div></div>}<nav className="mobile-nav"><button className={panel === 'people' ? 'active' : ''} onClick={() => setPanel('people')}><Users size={16} />People</button><button className={panel === 'history' ? 'active' : ''} onClick={() => setPanel('history')}><Menu size={16} />History</button></nav></div>;
}
