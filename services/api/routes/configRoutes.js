const express = require('express');


function createConfigRouter(ctx) {
  const router = express.Router();

  const {
    gitlabApi,
    GITLAB_PROJECT_ID,
    GITLAB_BRANCH,
    GITLAB_WORKFLOWS_PATH,
    GITLAB_PACKAGES_PATH,
    GITLAB_APPLICATIONS_PATH,
    ENABLE_WORKFLOWS,
    ENABLE_OGC_PACKAGES,
    ENABLE_APPLICATIONS,
    ALLOW_PUBLIC_INGRESS,
    MULTI_TENANT_MODE,
    JUPYTERHUB_PVC_NAME,
    JUPYTER_PVC_MOUNT_PATH,
    INGRESS_DEFAULTS,
    ingressClusterConfig,
    ARGO_PROFILES,
    EPHEMERAL_VOLUME_CONFIG,
    BASE_PATH,
    customObjectsApi,
    appsV1Api,
    coreV1Api,
    networkingV1Api,
    k8sApi,
    k8sCustomApi,
    k8sCoreApi,
    kc,
    parseAppFilename,
    resolveAppLocation,
    getAppFilename,
    getCommitOptions,
    stripAnsiCodes,
    hasWorkspaceGroupAccess,
    requiresAuth,
    requiresApplicationsEnabled,
    resolveSafeWorkspacePath,
    listWorkspaceDirectory,
    validateArgoWorkflow
  } = ctx;

const apiRouter = express.Router();

/**
 * GET /api/diag/token
 * Diagnostic endpoint to view the current session token claims.
 */
router.get("/diag/token", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "No session found." });
  }

  res.json({
    user: req.user,
    token: req.token ? "present" : "missing"
  });
});

// Protect all /api routes with authentication & workspace group authorization
router.use((req, res, next) => {
  // Skip protection for diagnostic endpoint
  if (req.path === "/diag/token") return next();

  // 1. Verify token / authentication presence strictly across all environments
  const user = req.user || getUsername(req);
  if (!user) {
    return res.status(401).json({
      message: 'Authentication Required: Valid session token or gateway headers required.',
      loginUrl: `${BASE_PATH}/login`
    });
  }

  // 2. Verify workspace group membership authorization strictly
  if (!hasWorkspaceGroupAccess(req)) {
    const targetGroup = process.env.ARGO_NAMESPACE || "unconfigured-workspace";
    return res.status(403).json({
      message: `Access Denied: Your account is not authorized for workspace group "${targetGroup}".`
    });
  }

  next();
});

let APP_VERSION = process.env.APP_VERSION;
if (!APP_VERSION) {
  try {
    APP_VERSION = require("./package.json").version;
  } catch (e) {
    APP_VERSION = null;
  }
}

/**
 * GET /api/config
 * Expose relevant configuration and profiles to the frontend.
 */
router.get("/config", (req, res) => {
  const username = getUsername(req);
  res.json({
    version: APP_VERSION,
    username,
    multiTenantMode: MULTI_TENANT_MODE,
    profiles: ARGO_PROFILES,
    ephemeralVolume: EPHEMERAL_VOLUME_CONFIG,
    allowPublishing: process.env.ALLOW_PUBLISHING === "true",
    enableWorkflows: ENABLE_WORKFLOWS,
    enableOgcPackages: ENABLE_OGC_PACKAGES,
    enableApplications: ENABLE_APPLICATIONS,
    features: {
      workflows: ENABLE_WORKFLOWS,
      ogcPackages: ENABLE_OGC_PACKAGES,
      applications: ENABLE_APPLICATIONS
    },
    allowPublicIngress: ALLOW_PUBLIC_INGRESS,
    ingress: ingressClusterConfig,
    logViewerUrl: process.env.LOG_VIEWER_URL || `https://hub-test.eox.at/services/eoxhub-gateway/cif/log-viewer/search`,
    defaults: {
      namespace: process.env.ARGO_NAMESPACE || "default",
      serviceAccount: process.env.ARGO_SERVICE_ACCOUNT || "default"
    }
  });
});

// Helper to extract authenticated username
function getUsername(req) {
  if (!req) return null;
  let rawUser = null;
  if (req.user) {
    rawUser = req.user.preferred_username ||
              req.user.nickname ||
              req.user.name ||
              req.user.email ||
              req.user.sub ||
              req.user.username ||
              req.user.upn ||
              req.user.unique_name;
  }
  if (!rawUser && req.headers && typeof req.headers === 'object') {
    rawUser = req.headers['x-authentik-username'] ||
              req.headers['x-preferred-username'] ||
              req.headers['x-user-claim-preferred-username'] ||
              req.headers['x-auth-request-preferred-username'] ||
              req.headers['x-auth-request-user'] ||
              req.headers['x-auth-request-email'] ||
              req.headers['x-forwarded-preferred-username'] ||
              req.headers['x-forwarded-user'] ||
              req.headers['x-forwarded-email'] ||
              req.headers['x-oauth2-proxy-user'] ||
              req.headers['x-oauth2-proxy-email'] ||
              req.headers['x-remote-user'] ||
              req.headers['x-user'] ||
              req.headers['x-username'] ||
              req.headers['remote-user'];
  }
  return rawUser ? String(rawUser).trim() : null;
}

// Helper to gather all possible username subfolder representations
function getCandidateUsernames(req) {
  const usernames = new Set();
  const primary = getUsername(req);
  if (primary) {
    usernames.add(primary);
    usernames.add(primary.toLowerCase());
    if (primary.includes('@')) {
      const shortName = primary.split('@')[0];
      usernames.add(shortName);
      usernames.add(shortName.toLowerCase());
    }
  }

  if (req.user) {
    ['preferred_username', 'nickname', 'name', 'email', 'sub', 'username', 'upn', 'unique_name'].forEach(k => {
      const val = req.user[k];
      if (val && typeof val === 'string') {
        usernames.add(val);
        usernames.add(val.toLowerCase());
        if (val.includes('@')) {
          const s = val.split('@')[0];
          usernames.add(s);
          usernames.add(s.toLowerCase());
        }
      }
    });
  }

  if (req.headers && typeof req.headers === 'object') {
    [
      'x-authentik-username',
      'x-preferred-username',
      'x-user-claim-preferred-username',
      'x-auth-request-preferred-username',
      'x-auth-request-user',
      'x-auth-request-email',
      'x-forwarded-preferred-username',
      'x-forwarded-user',
      'x-forwarded-email',
      'x-oauth2-proxy-user',
      'x-oauth2-proxy-email',
      'x-remote-user',
      'x-user',
      'x-username',
      'remote-user'
    ].forEach(h => {
      const val = req.headers[h];
      if (val && typeof val === 'string') {
        usernames.add(val);
        usernames.add(val.toLowerCase());
        if (val.includes('@')) {
          const s = val.split('@')[0];
          usernames.add(s);
          usernames.add(s.toLowerCase());
        }
      }
    });
  }

  return Array.from(usernames);
}

// Helper to convert a frontend virtual path to a physical GitLab path
function getGitLabPath(virtualPath, req = null) {
  if (!virtualPath) return "";
  
  // Express 5 path-to-regexp v8 matches wildcards as arrays of string segments
  let pathStr = Array.isArray(virtualPath) ? virtualPath.join('/') : String(virtualPath);

  // Prevent directory traversal
  let cleanVirtualPath = pathStr.replace(/^\//, "").replace(/\.\.\//g, "");
  
  let basePath = "";
  if (GITLAB_WORKFLOWS_PATH && GITLAB_WORKFLOWS_PATH !== ".") {
    basePath = GITLAB_WORKFLOWS_PATH.replace(/\/$/, "").replace(/^\//, "");
  }

  if (MULTI_TENANT_MODE) {
    const user = getUsername(req);
    if (user) {
      basePath = basePath ? `${basePath}/${user}` : user;
    }
  }

  return basePath ? `${basePath}/${cleanVirtualPath}` : cleanVirtualPath;
}

// Helper to convert a frontend package virtual path to a physical GitLab path
function getGitLabPackagesPath(virtualPath, req = null) {
  if (!virtualPath) return "";
  let pathStr = Array.isArray(virtualPath) ? virtualPath.join('/') : String(virtualPath);
  let cleanVirtualPath = pathStr.replace(/^\//, "").replace(/\.\.\//g, "");
  
  let basePath = GITLAB_PACKAGES_PATH.replace(/\/$/, "").replace(/^\//, "");

  if (MULTI_TENANT_MODE) {
    const user = getUsername(req);
    if (user) {
      basePath = `${basePath}/${user}`;
    }
  }

  return `${basePath}/${cleanVirtualPath}`;
}

// Helper to extract virtual path from req.params under both Express 4 and Express 5, and under both string wildcards and RegExp routes
function getVirtualPath(req) {
  const raw = req.params[0] || (Array.isArray(req.params.path) ? req.params.path.join('/') : String(req.params.path || ''));
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return raw;
  }
}

/**
 * GET /api/published-workflows
 * Get the list of published workflow IDs from pygeoapi/hr-pygeoapi.yaml.
 */

  return router;
}

module.exports = { createConfigRouter };
