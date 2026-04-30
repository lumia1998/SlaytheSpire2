const tauriCore = window.__TAURI__?.core;
const tauriDialog = window.__TAURI__?.dialog;
const tauriEvent = window.__TAURI__?.event;

const REPO_STORAGE_KEY = 'sts2_mod_manager_repos';
const GAME_PATH_STORAGE_KEY = 'sts2_mod_manager_game_path';
const MAX_LOG_LINES = 5;
const DEFAULT_REPOS = [
  { note: '', url: 'https://github.com/lumia1998/mods' },
];

const elements = {
  pathInput: document.getElementById('gamePath'),
  logOutput: document.getElementById('logOutput'),
  savePathButton: document.getElementById('savePathButton'),
  openDirectoryButton: document.getElementById('openDirectoryButton'),
  backupButton: document.getElementById('backupButton'),
  restoreButton: document.getElementById('restoreButton'),
  repoList: document.getElementById('repoList'),
  addRepoButton: document.getElementById('addRepoButton'),
  clearLogButton: document.getElementById('clearLogButton'),
  syncButtonGrid: document.getElementById('syncButtonGrid'),
  refreshBackupsButton: document.getElementById('refreshBackupsButton'),
  backupList: document.getElementById('backupList'),
  downloadStatus: document.getElementById('downloadStatus'),
  linkGithub: document.getElementById('linkGithub'),
  linkIssue: document.getElementById('linkIssue'),
};

let repos = loadRepos();
let currentDownload = null;

// ── Navigation ──

function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const pageId = item.dataset.page;
      navItems.forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
      document.getElementById(`page-${pageId}`).classList.add('active');

      if (pageId === 'mods') {
        renderSyncButtons();
        refreshBackupList();
      }
    });
  });
}

// ── Logging ──

function appendLog(message) {
  const lines = elements.logOutput.value
    ? elements.logOutput.value.split('\n').filter(Boolean)
    : [];
  lines.push(message);
  const visible = lines.slice(-MAX_LOG_LINES);
  elements.logOutput.value = visible.join('\n');
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function clearLog() {
  elements.logOutput.value = '';
}

// ── Tauri Helpers ──

function getInvoke() {
  if (!tauriCore?.invoke) {
    throw new Error('Tauri invoke API 不可用。');
  }
  return tauriCore.invoke;
}

function getOpenDialog() {
  if (!tauriDialog?.open) {
    throw new Error('Tauri dialog API 不可用。');
  }
  return tauriDialog.open;
}

function getGameDirectory() {
  const v = elements.pathInput.value.trim();
  if (!v) throw new Error('请先设置游戏目录。');
  return v;
}

// ── Repos ──

function normalizeRepo(repo) {
  return {
    note: typeof repo?.note === 'string' ? repo.note.slice(0, 10) : '',
    url: typeof repo?.url === 'string' ? repo.url : '',
  };
}

function loadRepos() {
  const raw = window.localStorage.getItem(REPO_STORAGE_KEY);
  if (!raw) return DEFAULT_REPOS.map(normalizeRepo);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_REPOS.map(normalizeRepo);
    return parsed.map(normalizeRepo);
  } catch {
    return DEFAULT_REPOS.map(normalizeRepo);
  }
}

function saveRepos() {
  window.localStorage.setItem(REPO_STORAGE_KEY, JSON.stringify(repos.map(normalizeRepo)));
}

// ── Game Directory ──

function saveGameDirectory(v) {
  const trimmed = `${v ?? ''}`.trim();
  if (!trimmed) {
    window.localStorage.removeItem(GAME_PATH_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(GAME_PATH_STORAGE_KEY, trimmed);
}

function loadSavedGameDirectory() {
  const saved = window.localStorage.getItem(GAME_PATH_STORAGE_KEY);
  return saved ? saved.trim() : '';
}

function setGameDirectory(v) {
  const next = `${v ?? ''}`.trim();
  elements.pathInput.value = next;
  saveGameDirectory(next);
}

// ── Busy State ──

function setButtonBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
}

// ── Render: Repo List (Settings Page) ──

function renderRepoList() {
  elements.repoList.innerHTML = '';
  const showDelete = repos.length > 1;

  repos.forEach((repo, index) => {
    const row = document.createElement('div');
    row.className = 'repo-row';

    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'text-input repo-note-input';
    noteInput.placeholder = '备注';
    noteInput.maxLength = 10;
    noteInput.value = repo.note;
    noteInput.autocomplete = 'off';
    noteInput.addEventListener('input', () => {
      repos[index].note = noteInput.value;
      saveRepos();
    });

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'text-input repo-url-input';
    urlInput.placeholder = '仓库地址或下载直链';
    urlInput.value = repo.url;
    urlInput.autocomplete = 'off';
    urlInput.addEventListener('input', () => {
      repos[index].url = urlInput.value;
      saveRepos();
    });

    row.appendChild(noteInput);
    row.appendChild(urlInput);

    if (showDelete) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'repo-delete-button';
      deleteButton.textContent = '×';
      deleteButton.addEventListener('click', () => {
        repos.splice(index, 1);
        saveRepos();
        renderRepoList();
      });
      row.appendChild(deleteButton);
    }

    elements.repoList.appendChild(row);
  });
}

// ── Render: Sync Buttons (Mods Page) ──

function renderSyncButtons() {
  elements.syncButtonGrid.innerHTML = '';

  const validRepos = repos.filter((r) => r.url.trim());
  if (validRepos.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sync-empty';
    empty.textContent = '请先在设置中添加同步源';
    elements.syncButtonGrid.appendChild(empty);
    return;
  }

  validRepos.forEach((repo, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sync-grid-button';
    btn.textContent = repo.note.trim() || repo.url.trim();
    btn.addEventListener('click', () => handleSync(repo, btn));
    elements.syncButtonGrid.appendChild(btn);
  });
}

// ── Render: Backup List ──

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function refreshBackupList() {
  let gameDirectory;
  try {
    gameDirectory = getGameDirectory();
  } catch {
    elements.backupList.innerHTML = '<p class="backup-empty">请先设置游戏目录</p>';
    return;
  }

  try {
    const invoke = getInvoke();
    const backups = await invoke('list_backups', { gameDirectory });
    elements.backupList.innerHTML = '';

    if (backups.length === 0) {
      elements.backupList.innerHTML = '<p class="backup-empty">暂无备份</p>';
      return;
    }

    backups.reverse().forEach((backup) => {
      const item = document.createElement('div');
      item.className = 'backup-item';

      const info = document.createElement('span');
      info.innerHTML = `<span class="backup-item-name">${backup.name}</span><span class="backup-item-size">${formatSize(backup.size_bytes)}</span>`;

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'backup-item-delete';
      deleteBtn.textContent = '删除';
      deleteBtn.addEventListener('click', async () => {
        if (!window.confirm(`确定删除备份 ${backup.name}？`)) return;
        try {
          await invoke('delete_backup', { gameDirectory, backupName: backup.name });
          appendLog(`[备份] 已删除：${backup.name}`);
          refreshBackupList();
        } catch (error) {
          appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      item.appendChild(info);
      item.appendChild(deleteBtn);
      elements.backupList.appendChild(item);
    });
  } catch (error) {
    elements.backupList.innerHTML = `<p class="backup-empty">加载失败</p>`;
  }
}

// ── Download Progress ──

function updateDownloadUI(data) {
  currentDownload = data;
  const container = elements.downloadStatus;

  if (!data || data.phase === 'done') {
    currentDownload = null;
    container.innerHTML = '<p class="empty-state">当前没有下载任务</p>';
    return;
  }

  const phaseText = {
    downloading: '下载中...',
    extracting: '解压中...',
    error: '下载失败',
  };

  const percent = data.total > 0 ? Math.min(100, Math.round((data.downloaded / data.total) * 100)) : 0;
  const percentStr = data.total > 0 ? `${percent}%` : '';
  const fillWidth = data.total > 0 ? `${percent}%` : '0%';

  container.innerHTML = `
    <div class="download-task">
      <div class="download-task-label">${data.label || 'mods.zip'}</div>
      <div class="download-task-phase">${phaseText[data.phase] || data.phase}</div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${fillWidth}"></div></div>
      <div class="download-task-percent">${percentStr}${data.total > 0 ? ' (' + formatSize(data.downloaded) + ' / ' + formatSize(data.total) + ')' : ''}</div>
    </div>
  `;
}

function listenDownloadProgress() {
  if (!tauriEvent?.listen) return;
  tauriEvent.listen('download-progress', (event) => {
    const payload = event.payload;
    if (payload) {
      updateDownloadUI({ ...payload, label: currentDownload?.label || 'mods.zip' });
    }
  });
}

// ── Handlers ──

async function handleSync(repo, button) {
  const url = repo.url.trim();
  const label = repo.note.trim() || url;

  if (!url) {
    appendLog('[同步] 同步地址不能为空。');
    return;
  }

  let gameDirectory;
  try {
    gameDirectory = getGameDirectory();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  setButtonBusy(button, true);

  try {
    const invoke = getInvoke();
    const backupExists = await invoke('has_backup', { gameDirectory });
    if (!backupExists) {
      window.alert('请先备份当前 mods 后再同步。');
      appendLog(`[同步] ${label}：请先备份当前 mods 后再同步。`);
      return;
    }

    appendLog(`[同步] ${label}：正在解析下载地址...`);
    const downloadUrl = await invoke('resolve_download_url', { url });

    currentDownload = { label, phase: 'downloading', downloaded: 0, total: 0 };
    updateDownloadUI(currentDownload);

    appendLog(`[同步] ${label}：正在下载 mods.zip...`);
    await invoke('download_mods', { gameDirectory, downloadUrl });

    updateDownloadUI({ label, phase: 'extracting', downloaded: 0, total: 0 });
    appendLog(`[同步] ${label}：下载完成，正在解压并替换...`);
    await invoke('extract_mods', { gameDirectory });

    updateDownloadUI({ phase: 'done' });
    appendLog(`[同步] ${label}：同步完成。`);
  } catch (error) {
    updateDownloadUI({ phase: 'done' });
    appendLog(`[错误] ${label}：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function handleBackup() {
  let gameDirectory;
  try {
    gameDirectory = getGameDirectory();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  setButtonBusy(elements.backupButton, true);
  appendLog('[备份] 开始备份 mods 和 zip 文件...');
  try {
    const invoke = getInvoke();
    const result = await invoke('backup_mods', { gameDirectory });
    appendLog('[备份] 备份完成。');
    if (result) appendLog(`[结果] ${result}`);
    refreshBackupList();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setButtonBusy(elements.backupButton, false);
  }
}

async function handleRestore() {
  let gameDirectory;
  try {
    gameDirectory = getGameDirectory();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!window.confirm('是否要从最近备份还原？当前 mods 将被替换。')) {
    appendLog('[还原] 已取消。');
    return;
  }

  setButtonBusy(elements.restoreButton, true);
  appendLog('[还原] 开始恢复备份内容...');
  try {
    const invoke = getInvoke();
    const result = await invoke('restore_mods', { gameDirectory });
    appendLog('[还原] 还原完成。');
    if (result) appendLog(`[结果] ${result}`);
    refreshBackupList();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setButtonBusy(elements.restoreButton, false);
  }
}

async function handleSavePath() {
  try {
    const open = getOpenDialog();
    const selected = await open({ directory: true, title: '选择游戏目录' });
    if (!selected) {
      appendLog('[路径] 已取消选择。');
      return;
    }
    const v = Array.isArray(selected) ? selected[0] : selected;
    if (!v) {
      appendLog('[路径] 已取消选择。');
      return;
    }
    setGameDirectory(v);
    appendLog(`[路径] 已选择: ${v}`);
    cleanupStaleTemp(v);
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleOpenDirectory() {
  let gameDirectory;
  try {
    gameDirectory = getGameDirectory();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const invoke = getInvoke();
    await invoke('open_directory', { path: gameDirectory });
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cleanupStaleTemp(gameDirectory) {
  try {
    const invoke = getInvoke();
    await invoke('cleanup_stale_temp', { gameDirectory });
  } catch {
    // silent
  }
}

async function detectGameDirectoryOnStartup() {
  const savedPath = loadSavedGameDirectory();
  if (savedPath) {
    setGameDirectory(savedPath);
    appendLog(`[路径] 已加载上次使用的目录: ${savedPath}`);
    cleanupStaleTemp(savedPath);
    return;
  }

  appendLog('[检测] 正在扫描常见 Steam 安装位置...');
  try {
    const invoke = getInvoke();
    const detected = await invoke('detect_game_directory');
    if (detected) {
      setGameDirectory(detected);
      appendLog(`[检测] 已找到游戏目录: ${detected}`);
      cleanupStaleTemp(detected);
      return;
    }
    appendLog('[检测] 未找到游戏目录，请在设置中手动选择。');
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    appendLog('[检测] 未找到游戏目录，请在设置中手动选择。');
  }
}

// ── About Links ──

function initAboutLinks() {
  const opener = window.__TAURI__?.opener;
  elements.linkGithub.addEventListener('click', (e) => {
    e.preventDefault();
    if (opener?.openUrl) {
      opener.openUrl('https://github.com/lumia1998/mods');
    }
  });
  elements.linkIssue.addEventListener('click', (e) => {
    e.preventDefault();
    if (opener?.openUrl) {
      opener.openUrl('https://github.com/lumia1998/mods/issues');
    }
  });
}

// ── Init ──

function bindEvents() {
  elements.savePathButton.addEventListener('click', handleSavePath);
  elements.openDirectoryButton.addEventListener('click', handleOpenDirectory);
  elements.backupButton.addEventListener('click', handleBackup);
  elements.restoreButton.addEventListener('click', handleRestore);
  elements.clearLogButton.addEventListener('click', clearLog);
  elements.refreshBackupsButton.addEventListener('click', refreshBackupList);
  elements.pathInput.addEventListener('change', () => saveGameDirectory(elements.pathInput.value));
  elements.pathInput.addEventListener('blur', () => saveGameDirectory(elements.pathInput.value));
  elements.addRepoButton.addEventListener('click', () => {
    repos.push({ note: '', url: '' });
    saveRepos();
    renderRepoList();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  initNavigation();
  bindEvents();
  initAboutLinks();
  listenDownloadProgress();
  renderRepoList();
  renderSyncButtons();
  await detectGameDirectoryOnStartup();
  refreshBackupList();
});
