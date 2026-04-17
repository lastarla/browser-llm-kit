const INSTALL_ERROR_MESSAGES = {
  INSTALL_BROWSER_UNSUPPORTED: '当前浏览器不支持本地安装',
  INSTALL_INSECURE_CONTEXT: '当前地址不是安全上下文，请改用 HTTPS 或 localhost',
  INSTALL_CONTROL_REQUIRED: '需要刷新页面以启用完整离线安装',
  INSTALL_NETWORK_ERROR: '网络异常，模型资源安装未完成，重试会重新下载未完成文件',
  INSTALL_ASSET_MISSING: '模型资源未完整进入缓存，重试会重新下载未完成文件',
  INSTALL_CLEAR_FAILED: '缓存清理失败',
};

const INSTALL_STATE_PROGRESS = {
  idle: 0,
  env_checking: 5,
  control_waiting: 10,
  downloading_model: 55,
  verifying: 85,
  partial: 66,
  ready: 100,
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
  const state = snapshot?.state || 'idle';
  const percent = getInstallProgress(snapshot);

  if (state === 'ready') {
    return '本地模型资源已就绪';
  }

  if (state === 'partial') {
    return snapshot?.errorCode === 'INSTALL_CONTROL_REQUIRED'
      ? '需要刷新页面以完成模型安装'
      : '基础资源已就绪，模型资源未完成';
  }

  if (state === 'failed') {
    return snapshot?.errorCode && INSTALL_ERROR_MESSAGES[snapshot.errorCode]
      ? INSTALL_ERROR_MESSAGES[snapshot.errorCode]
      : snapshot?.errorDetail || '本地模型安装失败';
  }

  if (state === 'cancelled') {
    return '本地模型安装已取消';
  }

  if (state === 'verifying') {
    return '正在校验模型完整性';
  }

  if (state === 'downloading_model') {
    return typeof percent === 'number'
      ? `正在下载本地模型资源（${percent}%）`
      : '正在下载本地模型资源';
  }

  if (state === 'control_waiting') {
    return '等待当前页面进入离线控制状态';
  }

  if (state === 'env_checking') {
    return '正在检查安装环境';
  }

  return '等待安装';
}
