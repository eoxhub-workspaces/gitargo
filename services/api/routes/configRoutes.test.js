const test = require('node:test');
const assert = require('node:assert');
const { createConfigRouter } = require('./configRoutes');

test('configRoutes resolves application version from root package.json', () => {
  const mockCtx = {
    BASE_PATH: '',
    hasWorkspaceGroupAccess: () => true,
    MULTI_TENANT_MODE: false,
    ARGO_PROFILES: {},
    EPHEMERAL_VOLUME_CONFIG: {},
    ENABLE_WORKFLOWS: true,
    ENABLE_OGC_PACKAGES: true,
    ENABLE_APPLICATIONS: true
  };

  const router = createConfigRouter(mockCtx);
  assert(router, 'Router should be created');

  // Find the /config route handler
  const route = router.stack.find(s => s.route && s.route.path === '/config');
  assert(route, 'GET /config route should exist');

  const req = { user: { preferred_username: 'testuser' } };
  let jsonResponse = null;
  const res = {
    json: (data) => {
      jsonResponse = data;
    }
  };

  // Execute route handler
  route.route.stack[0].handle(req, res);

  assert(jsonResponse, 'Response should be returned');
  assert.strictEqual(jsonResponse.version, '0.6.0');
});
