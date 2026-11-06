const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveSafeWorkspacePath, listWorkspaceDirectory } = require('./workspaceService');

test('resolveSafeWorkspacePath resolves paths within workspace boundary', () => {
  const base = '/tmp/test-workspace';
  const result = resolveSafeWorkspacePath(base, 'subfolder/file.txt');
  assert.strictEqual(result.safeBase, path.resolve(base));
  assert.strictEqual(result.targetPath, path.resolve(base, 'subfolder/file.txt'));
});

test('resolveSafeWorkspacePath throws error on path traversal attempt', () => {
  const base = '/tmp/test-workspace';
  assert.throws(() => {
    resolveSafeWorkspacePath(base, '../../etc/passwd');
  }, /Access denied/);
});

test('listWorkspaceDirectory handles non-existent directory gracefully', () => {
  const result = listWorkspaceDirectory('/non/existent/path/for/desloppify/test');
  assert.strictEqual(result.exists, false);
  assert.deepStrictEqual(result.files, []);
});
