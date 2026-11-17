const fs = require('fs');
const path = require('path');

function resolveSafeWorkspacePath(baseMountPath, requestedPath) {
  const safeBase = path.resolve(baseMountPath);
  const targetPath = path.resolve(safeBase, requestedPath || '');
  if (!targetPath.startsWith(safeBase)) {
    throw new Error('Access denied: Path traversal outside workspace boundary.');
  }
  return { safeBase, targetPath };
}

function listWorkspaceDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { exists: false, files: [] };
  }
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return { exists: true, isDirectory: false, files: [] };
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  const files = entries.map((entry) => {
    const entryPath = path.join(targetPath, entry.name);
    let size = 0;
    let mtime = null;
    try {
      const s = fs.statSync(entryPath);
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch (e) {}
    return {
      name: entry.name,
      isDirectory: entry.isDirectory(),
      size,
      mtime
    };
  });

  return { exists: true, isDirectory: true, files };
}

module.exports = { resolveSafeWorkspacePath, listWorkspaceDirectory };
