const tauriCore = window.__TAURI__?.core;
const tauriDialog = window.__TAURI__?.dialog;

const REPO_STORAGE_KEY = 'sts2_mod_manager_repos';
const GAME_PATH_STORAGE_KEY = 'sts2_mod_manager_game_path';
const MAX_LOG_LINES = 300;
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
};

const globalButtons = [
  elements.savePathButton,
  elements.openDirectoryButton,
  elements.backupButton,
  elements.restoreButton,
];

let repos = loadRepos();

function appendLog(message) {
  const previousLines = elements.logOutput.value
    ? elements.logOutput.value.split('\n').filter(Boolean)
    : [];
  previousLines.push(message);
  const visibleLines = previousLines.slice(-MAX_LOG_LINES);
  elements.logOutput.value = visibleLines.join('\n');
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function clearLog() {
  elements.logOutput.value = '';
}

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
  const pathValue = elements.pathInput.value.trim();
  if (!pathValue) {
    throw new Error('请先设置游戏目录。');
  }
  return pathValue;
}

function normalizeRepo(repo) {
  return {
    note: typeof repo?.note === 'string' ? repo.note.slice(0, 10) : '',
    url: typeof repo?.url === 'string' ? repo.url : '',
  };
}

function loadRepos() {
  const raw = window.localStorage.getItem(REPO_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_REPOS.map(normalizeRepo);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_REPOS.map(normalizeRepo);
    }
    return parsed.map(normalizeRepo);
  } catch {
    return DEFAULT_REPOS.map(normalizeRepo);
  }
}

function saveRepos() {
  window.localStorage.setItem(REPO_STORAGE_KEY, JSON.stringify(repos.map(normalizeRepo)));
}

function saveGameDirectory(pathValue) {
  const trimmed = `${pathValue ?? ''}`.trim();
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

function setGameDirectory(pathValue) {
  const nextValue = `${pathValue ?? ''}`.trim();
  elements.pathInput.value = nextValue;
  saveGameDirectory(nextValue);
}

function setGlobalBusy(busy, activeButton = null) {
  for (const button of globalButtons) {
    button.disabled = busy;
    button.classList.toggle('is-loading', busy && button === activeButton);
  }
}

async function runGlobalBusyAction(activeButton, action, successMessage) {
  setGlobalBusy(true, activeButton);
  try {
    const result = await action();
    appendLog(successMessage);
    if (result !== undefined && result !== null && `${result}`.trim()) {
      appendLog(`[结果] ${result}`);
    }
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setGlobalBusy(false);
  }
}

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

    const syncButton = document.createElement('button');
    syncButton.type = 'button';
    syncButton.className = 'action-button secondary-button repo-sync-button';
    syncButton.textContent = '同步';
    syncButton.addEventListener('click', () => handleSyncRow(index, syncButton));

    row.appendChild(noteInput);
    row.appendChild(urlInput);
    row.appendChild(syncButton);

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

async function handleSyncRow(index, syncButton) {
  const repo = repos[index];
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

  syncButton.disabled = true;
  syncButton.classList.add('is-loading');

  try {
    const invoke = getInvoke();
    const backupExists = await invoke('has_backup', { gameDirectory });
    if (!backupExists) {
      const message = '请先备份当前 mods 后再同步。';
      window.alert(message);
      appendLog(`[同步] ${label}：${message}`);
      return;
    }
    appendLog(`[同步] ${label}：正在解析下载地址...`);
    const downloadUrl = await invoke('resolve_download_url', { url });
    appendLog(`[同步] ${label}：开始下载 mods.zip...`);
    const result = await invoke('sync_mods', { gameDirectory, downloadUrl });
    appendLog(`[同步] ${label}：同步完成。`);
    if (result) {
      appendLog(`[结果] ${result}`);
    }
  } catch (error) {
    appendLog(`[错误] ${label}：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    syncButton.disabled = false;
    syncButton.classList.remove('is-loading');
  }
}

async function detectGameDirectoryOnStartup() {
  const savedPath = loadSavedGameDirectory();
  if (savedPath) {
    setGameDirectory(savedPath);
    appendLog(`[路径] 已加载上次使用的目录: ${savedPath}`);
    return;
  }

  appendLog('[检测] 正在扫描所有盘符的常见 Steam 安装位置...');
  try {
    const invoke = getInvoke();
    const detected = await invoke('detect_game_directory');
    if (detected) {
      setGameDirectory(detected);
      appendLog(`[检测] 已找到游戏目录: ${detected}`);
      return;
    }
    appendLog('[检测] 未找到游戏目录，请手动选择。');
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    appendLog('[检测] 未找到游戏目录，请手动选择。');
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
    const pathValue = Array.isArray(selected) ? selected[0] : selected;
    if (!pathValue) {
      appendLog('[路径] 已取消选择。');
      return;
    }
    setGameDirectory(pathValue);
    appendLog(`[路径] 已选择: ${pathValue}`);
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

  await runGlobalBusyAction(
    elements.openDirectoryButton,
    async () => {
      const invoke = getInvoke();
      return invoke('open_directory', { path: gameDirectory });
    },
    '[路径] 已打开目录。'
  );
}

async function handleBackup() {
  let gameDirectory;
  try {
    gameDirectory = getGameDirectory();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  appendLog('[备份] 开始备份 mods 和 zip 文件...');
  await runGlobalBusyAction(
    elements.backupButton,
    async () => {
      const invoke = getInvoke();
      return invoke('backup_mods', { gameDirectory });
    },
    '[备份] 备份完成。'
  );
}

async function handleRestore() {
  let gameDirectory;
  try {
    gameDirectory = getGameDirectory();
  } catch (error) {
    appendLog(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const confirmed = window.confirm('是否要删除当前使用的 mod？');
  if (!confirmed) {
    appendLog('[还原] 已取消。');
    return;
  }

  appendLog('[还原] 开始恢复备份内容...');
  await runGlobalBusyAction(
    elements.restoreButton,
    async () => {
      const invoke = getInvoke();
      return invoke('restore_mods', { gameDirectory });
    },
    '[还原] 还原完成。'
  );
}

function bindEvents() {
  elements.savePathButton.addEventListener('click', handleSavePath);
  elements.openDirectoryButton.addEventListener('click', handleOpenDirectory);
  elements.backupButton.addEventListener('click', handleBackup);
  elements.restoreButton.addEventListener('click', handleRestore);
  elements.clearLogButton.addEventListener('click', clearLog);
  elements.pathInput.addEventListener('change', () => saveGameDirectory(elements.pathInput.value));
  elements.pathInput.addEventListener('blur', () => saveGameDirectory(elements.pathInput.value));
  elements.addRepoButton.addEventListener('click', () => {
    repos.push({ note: '', url: '' });
    saveRepos();
    renderRepoList();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  renderRepoList();
  await detectGameDirectoryOnStartup();
});

