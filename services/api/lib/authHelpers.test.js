const test = require('node:test');
const assert = require('node:assert');
const { getUsername, getCandidateUsernames, getVirtualPath, getGitLabPath, validateAndSanitizeAppYaml } = require('./authHelpers');

test('getUsername extracts username from user object or headers', () => {
  const req1 = { user: { preferred_username: 'alice' } };
  assert.strictEqual(getUsername(req1), 'alice');

  const req2 = { headers: { 'x-remote-user': 'bob@example.com' } };
  assert.strictEqual(getUsername(req2), 'bob@example.com');

  assert.strictEqual(getUsername(null), null);
});

test('getCandidateUsernames returns list of username variations', () => {
  const req = { user: { preferred_username: 'charlie@domain.com' } };
  const candidates = getCandidateUsernames(req);
  assert(candidates.includes('charlie@domain.com'));
  assert(candidates.includes('charlie'));
});

test('getVirtualPath formats virtual path correctly in multi-tenant mode', () => {
  const req = { user: { preferred_username: 'dave' }, params: { 0: 'my-workflow.yaml' } };
  const vPath = getVirtualPath(req, true);
  assert.strictEqual(vPath, 'workflows/dave/my-workflow.yaml');
});

test('getGitLabPath prevents duplicate path prefixing when virtualPath already contains user folder', () => {
  const req = { user: { preferred_username: 'dave' } };
  const envConfig = { GITLAB_WORKFLOWS_PATH: 'workflows', MULTI_TENANT_MODE: true };
  const vp = 'workflows/dave/my-workflow.yaml';
  const filePath = getGitLabPath(vp, req, envConfig);
  assert.strictEqual(filePath, 'workflows/dave/my-workflow.yaml');
});

test('validateAndSanitizeAppYaml validates and enforces metadata for deployment and service', () => {
  const inputDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: nginx
`;
  const sanitized = validateAndSanitizeAppYaml('test-app', inputDeployment, 'deployment', { enforcedNamespace: 'my-ns' });
  assert(sanitized.includes('namespace: my-ns'));
  assert(sanitized.includes('app.kubernetes.io/service: test-app'));
});
