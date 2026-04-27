const INSTALL_ERROR_MESSAGES = {
  INSTALL_BROWSER_UNSUPPORTED: '当前浏览器不支持浏览器端模型安装',
  INSTALL_INSECURE_CONTEXT: '当前地址不是安全上下文，请改用 HTTPS 或 localhost',
  INSTALL_OPFS_UNAVAILABLE: '当前浏览器不支持 OPFS，无法安装本地模型',
  INSTALL_WORKER_UNAVAILABLE: '当前浏览器不支持 Worker，无法执行后台安装',
  INSTALL_STORAGE_QUOTA_INSUFFICIENT: '浏览器剩余存储空间不足，无法安装本地模型',
  INSTALL_NETWORK_ERROR: '网络异常，模型资源安装未完成',
  INSTALL_INTEGRITY_MISMATCH: '模型资源校验失败，请重新安装',
  INSTALL_CANCELLED: '本地模型安装已取消',
  INSTALL_CLEAR_FAILED: '模型清理失败',
};

const INSTALL_STATE_PROGRESS = {
  absent: 0,
  idle: 0,
  installing: 10,
  installed: 100,
  failed: 0,
  cancelled: 0,
};

export function getInstallProgress(snapshot) {
  const totalBytes = snapshot?.progress?.totalBytes;
  const downloadedBytes = snapshot?.progress?.downloadedBytes;
  if (
    typeof totalBytes === 'number'
    && Number.isFinite(totalBytes)
    && totalBytes > 0
    && typeof downloadedBytes === 'number'
    && Number.isFinite(downloadedBytes)
    && downloadedBytes >= 0
  ) {
    return Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
  }

  const explicitPercent = snapshot?.progress?.percent;
  if (typeof explicitPercent === 'number' && Number.isFinite(explicitPercent)) {
    return Math.max(0, Math.min(100, explicitPercent));
  }

  return INSTALL_STATE_PROGRESS[snapshot?.state] ?? null;
}

export function formatInstallStateMessage(snapshot) {
  const state = snapshot?.state || snapshot?.userState || 'absent';
  const systemState = snapshot?.systemState || '';
  const percent = getInstallProgress(snapshot);

  if (state === 'installed') {
    return '模型资源已写入 OPFS';
  }

  if (state === 'failed') {
    return snapshot?.errorCode && INSTALL_ERROR_MESSAGES[snapshot.errorCode]
      ? INSTALL_ERROR_MESSAGES[snapshot.errorCode]
      : snapshot?.errorDetail || '本地模型安装失败';
  }

  if (state === 'cancelled') {
    return INSTALL_ERROR_MESSAGES.INSTALL_CANCELLED;
  }

  if (state === 'installing') {
    if (systemState === 'checking-storage') {
      return '正在检查浏览器存储环境';
    }
    if (systemState === 'verifying-temp') {
      return '正在校验模型完整性';
    }
    if (systemState === 'downloading-partial') {
      return typeof percent === 'number'
        ? `正在写入模型资源到 OPFS（${percent}%）`
        : '正在写入模型资源到 OPFS';
    }
    if (systemState === 'committing') {
      return '正在提交模型安装元数据';
    }
    return '正在安装本地模型';
  }

  return '等待安装';
}
