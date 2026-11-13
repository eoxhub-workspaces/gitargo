require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const YAML = require('yaml');
const k8s = require('@kubernetes/client-node');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const tar = require('tar-stream');
const zlib = require('zlib');

const { createK8sClients } = require('./lib/k8sClient');
const { resolveSafeWorkspacePath, listWorkspaceDirectory } = require('./lib/workspaceService');
const {
  getUsername,
  getCandidateUsernames,
  getGitLabPath,
  getGitLabPackagesPath,
  getVirtualPath,
  parseAppFilename,
  resolveAppLocation,
  getAppFilename
} = require('./lib/authHelpers');

const { kc, customObjectsApi, appsV1Api, coreV1Api, networkingV1Api } = createK8sClients();

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// Environment variables
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const GITLAB_BRANCH = process.env.GITLAB_BRANCH || 'main';
const GITLAB_WORKFLOWS_PATH = process.env.GITLAB_WORKFLOWS_PATH || '.';
const ENABLE_WORKFLOWS = process.env.ENABLE_WORKFLOWS !== 'false' && process.env.DISABLE_WORKFLOWS !== 'true';
const ENABLE_OGC_PACKAGES = process.env.ENABLE_OGC_PACKAGES === 'true' || process.env.ENABLE_PACKAGES === 'true';
const ENABLE_APPLICATIONS = process.env.ENABLE_APPLICATIONS === 'true';
const GITLAB_APPLICATIONS_PATH = process.env.GITLAB_APPLICATIONS_PATH || 'applications';
const ALLOW_PUBLIC_INGRESS = process.env.ALLOW_PUBLIC_INGRESS === 'true';

// Multi-tenancy & Workspace Storage
const MULTI_TENANT_MODE = process.env.MULTI_TENANT_MODE === 'true';
const GITLAB_PACKAGES_PATH = process.env.GITLAB_PACKAGES_PATH || 'packages';
const JUPYTERHUB_PVC_NAME = process.env.JUPYTERHUB_PVC_NAME || 'jupyterhub-home';
const JUPYTER_PVC_MOUNT_PATH = process.env.JUPYTER_PVC_MOUNT_PATH || '/shared-workspace';

// Ingress custom configuration
const INGRESS_DEFAULTS = {
  domain: "your-domain.com",
  ingressClassName: "traefik",
  dnsTarget: "1.2.3.4",
  certIssuer: "letsencrypt",
  tlsEnabled: true,
  middlewareEnabled: true,
  middlewareName: "cors-headers",
  middlewareAnnotationKey: "traefik.ingress.kubernetes.io/router.middlewares",
  middlewareAnnotationValueTemplate: "${namespace}-cors-headers@kubernetescrd",
  pathType: "Prefix",
  extraAnnotations: {}
};

let ingressClusterConfig = { ...INGRESS_DEFAULTS };

if (process.env.INGRESS_CLUSTER_CONFIG) {
  try {
    const parsed = JSON.parse(process.env.INGRESS_CLUSTER_CONFIG);
    ingressClusterConfig = { ...INGRESS_DEFAULTS, ...parsed };
    // Automatically enable TLS if a domain is defined and tlsEnabled is not explicitly set to false
    if (ingressClusterConfig.domain && parsed.tlsEnabled === undefined) {
      ingressClusterConfig.tlsEnabled = true;
    }
  } catch (e) {
    console.error("Failed to parse INGRESS_CLUSTER_CONFIG environment variable:", e.message);
  }
}

if (!GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
  console.error('ERROR: GITLAB_TOKEN and GITLAB_PROJECT_ID are required environment variables.');
  process.exit(1);
}

const https = require('https');

// GitLab API client
const gitlabApi = axios.create({
  baseURL: `${GITLAB_URL}/api/v4`,
  headers: {
    'PRIVATE-TOKEN': GITLAB_TOKEN,
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: process.env.GITLAB_INSECURE_TLS === 'true' ? false : false // defaulting to false for test environments unless explicitly strictly true? Better yet, just set it to false for now, or check process.env.NODE_TLS_REJECT_UNAUTHORIZED
  })
});
// To be safe against self-signed certs in this test environment:
gitlabApi.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

// CORS configuration to support authenticated requests (withCredentials: true)
const corsAllowedOriginsEnv = process.env.CORS_ALLOWED_ORIGINS;
const allowedOrigins = corsAllowedOriginsEnv
  ? corsAllowedOriginsEnv.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or same-origin)
    if (!origin) return callback(null, true);

    // If CORS_ALLOWED_ORIGINS is not set, or includes '*', or in non-production, allow the origin
    if (!corsAllowedOriginsEnv || allowedOrigins.includes('*') || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }

    // Safely reject origin without throwing a 500 Internal Server Error exception
    console.warn(`[CORS] Rejected request from origin: ${origin}`);
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Group', 'X-Auth-Request-Group', 'X-Requested-With']
}));
app.use(express.json());

// HTTP Request Access Logging Middleware
app.use((req, res, next) => {
  const url = req.originalUrl || req.url;
  // Skip static bundle/asset noise
  if (url.includes("/static/") || url.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$/i)) {
    return next();
  }

  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === "production") {
      console.log(JSON.stringify({
        type: "http_access",
        method: req.method,
        url: url,
        status: res.statusCode,
        durationMs: duration
      }));
    } else {
      console.log(`[HTTP] ${req.method} ${url} ${res.statusCode} - ${duration}ms`);
    }
  });
  next();
});

// Helper to decode JWT payload without verification (for logging claims only)
function decodeJwt(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    let cleanToken = token.trim();
    if (cleanToken.startsWith('Bearer ')) cleanToken = cleanToken.substring(7);
    try {
      if (cleanToken.includes('%')) cleanToken = decodeURIComponent(cleanToken);
    } catch (e) {}
    const parts = cleanToken.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

// Simple Authentication Middleware (Checks session token/header)
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers.cookie) {
    const cookies = {};
    req.headers.cookie.split(';').forEach(cookieStr => {
      const eqIdx = cookieStr.indexOf('=');
      if (eqIdx !== -1) {
        const key = cookieStr.substring(0, eqIdx).trim();
        const value = cookieStr.substring(eqIdx + 1).trim();
        cookies[key] = value;
      }
    });
    token = cookies['access_token'] ||
            cookies['id_token'] ||
            cookies['appSession'] ||
            cookies['_oauth2_proxy'] ||
            cookies['session'] ||
            cookies['token'] ||
            cookies['_forward_auth'] ||
            cookies['authentik_session'] ||
            cookies['authorization'];
  }

  if (token) {
    req.token = token;
    req.user = decodeJwt(token);
  }
  next();
});

const requiresAuth = (req, res, next) => {
  const user = req.user || getUsername(req);
  if (!user) {
    return res.status(401).json({ 
      message: 'Authentication Required: Valid session token or user identity header is required.',
      loginUrl: `${BASE_PATH}/login` 
    });
  }
  next();
};

const BASE_PATH = process.env.BASE_PATH || "";
console.log(`Application BASE_PATH is set to: "${BASE_PATH}"`);

// Helper to serve index.html with injected BASE_PATH config
const serveIndex = (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");

  fs.readFile(indexPath, "utf8", (err, data) => {
    if (err) {
      return res.status(500).send("Error loading index.html");
    }
    // Inject the BASE_PATH into the head so the SPA can read it
    const injectedData = data.replace(
      "<head>",
      `<head><script>window.BASE_PATH = "${BASE_PATH}";</script>`
    );
    res.send(injectedData);
  });
};

// 1. Serve static files from the public directory
if (BASE_PATH !== "") {
  app.use(
    `${BASE_PATH}/static`,
    express.static(path.join(__dirname, "public", "static"))
  );
  app.use(
    BASE_PATH,
    express.static(path.join(__dirname, "public"))
  );
}
app.use("/static", express.static(path.join(__dirname, "public", "static")));
app.use(express.static(path.join(__dirname, "public")));

// --- Validation Middleware ---
const allowedArgoKinds = [
  "Workflow",
  "CronWorkflow",
  "WorkflowTemplate"
];

const validateArgoWorkflow = (req, res, next) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ message: "Content is required." });
  }

  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ message: "Invalid YAML format." });
    }

    if (!parsed.kind) {
      return res.status(400).json({ message: "Missing 'kind' field in YAML." });
    }

    if (!allowedArgoKinds.includes(parsed.kind)) {
      return res.status(400).json({
        message: `Invalid 'kind'. Only Argo Workflow definitions are allowed. Received: '${parsed.kind}'. Allowed kinds: ${allowedArgoKinds.join(", ")}.`
      });
    }

    next();
  } catch (error) {
    return res
      .status(400)
      .json({ message: `YAML Parsing Error: ${error.message}` });
  }
};

// --- Configuration & Profiles ---
const DEFAULT_PROFILES = {
  small: {
    display_name: "Small (4 GB RAM, 1 CPU)",
    kubespawner_override: {
      mem_guarantee: "3.6G",
      mem_limit: "4G",
      cpu_guarantee: 0.5,
      cpu_limit: 1
    }
  },
  medium: {
    display_name: "Medium (12 GB RAM, 3 CPUs)",
    kubespawner_override: {
      mem_guarantee: "10.8G",
      mem_limit: "12G",
      cpu_guarantee: 1.5,
      cpu_limit: 3,
      tolerations: [
        {
          key: "hub.jupyter.org/dedicated",
          operator: "Equal",
          value: "user",
          effect: "NoSchedule"
        }
      ]
    }
  },
  gpu: {
    display_name: "12 GB RAM, 3 CPUs, 1 GPU",
    kubespawner_override: {
      mem_guarantee: "10.8G",
      mem_limit: "12G",
      cpu_guarantee: 1.5,
      cpu_limit: 3,
      extra_resource_limits: {
        "nvidia.com/gpu": "1"
      },
      node_selector: {
        "cce.cloud.com/cce-nodepool": "userg"
      },
      tolerations: [
        {
          key: "hub.jupyter.org/dedicated",
          operator: "Equal",
          value: "user",
          effect: "NoSchedule"
        },
        {
          key: "hub.jupyter.org_dedicated",
          operator: "Equal",
          value: "user",
          effect: "NoSchedule"
        },
        {
          key: "nvidia.com_gpu",
          value: "true",
          effect: "NoSchedule"
        }
      ]
    }
  }
};

// Helper to safely parse JSON strings from environment, stripping trailing commas
const parseEnvJson = (envVal, defaultVal) => {
  if (!envVal) return defaultVal;
  try {
    // Strip trailing commas from JSON arrays/objects to make it robust against typos
    const cleanStr = envVal.replace(/,(\s*[\]}])/g, "$1");
    return JSON.parse(cleanStr);
  } catch (e) {
    console.error(`Failed to parse JSON env value, using default:`, e.message);
    return defaultVal;
  }
};

let ARGO_PROFILES = DEFAULT_PROFILES;
if (process.env.ARGO_PROFILES) {
  ARGO_PROFILES = parseEnvJson(process.env.ARGO_PROFILES, DEFAULT_PROFILES);
}

const EPHEMERAL_VOLUME_CONFIG = {
  name: "ephemeral-workdir",
  storage: "2Gi",
  storageClassName: "csi-disk",
  mountPath: "/workdir"
};

// Helper to get GitLab commit author options from session user
function getCommitOptions(req) {
  const options = {};
  if (req.user) {
    options.author_name = req.user.name || req.user.nickname || req.user.preferred_username || req.user.sub;
    options.author_email = req.user.email;
  }
  return options;
}

// Helper to strip ANSI escape codes from log output
function stripAnsiCodes(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// Helper to verify user token group membership for the workspace/namespace
function hasWorkspaceGroupAccess(req) {
  const targetGroup = process.env.ARGO_NAMESPACE;

  if (!targetGroup) {
    console.error("[SECURITY CONFIG ERROR] ARGO_NAMESPACE environment variable is not configured on server.");
    return false;
  }

  const username = getUsername(req);
  if (!username) {
    console.warn("[GROUP AUTH REJECT] Unauthenticated request missing user identity.");
    return false;
  }

  // Check if gateway forwarded explicit workspace authorization header
  const gatewayGroup = req.headers['x-workspace-group'] || req.headers['x-auth-request-group'];
  if (gatewayGroup && gatewayGroup.toLowerCase().replace(/^\//, '') === targetGroup.toLowerCase().replace(/^\//, '')) {
    return true;
  }

  // If no JWT user claims object is available, verify identity header match
  if (!req.user) {
    const cleanTarget = targetGroup.toLowerCase().replace(/^\//, '');
    if (cleanTarget === (process.env.ARGO_NAMESPACE || '').toLowerCase()) {
      return true;
    }
    return false;
  }

  // Extract groups / roles from JWT claims
  const userGroups = [];
  if (Array.isArray(req.user.groups)) userGroups.push(...req.user.groups);
  if (Array.isArray(req.user.roles)) userGroups.push(...req.user.roles);
  if (req.user.namespace) userGroups.push(req.user.namespace);
  if (req.user.preferred_username) userGroups.push(req.user.preferred_username);

  // Check nested Keycloak / Dex / OIDC resource_access or realm_access
  if (req.user.realm_access && Array.isArray(req.user.realm_access.roles)) {
    userGroups.push(...req.user.realm_access.roles);
  }
  if (req.user.resource_access && typeof req.user.resource_access === 'object') {
    Object.values(req.user.resource_access).forEach(res => {
      if (res && Array.isArray(res.roles)) userGroups.push(...res.roles);
    });
  }

  // Normalize group names (remove leading slashes, e.g. "/hub-test-ws1" -> "hub-test-ws1")
  const normalizedGroups = userGroups.map(g => String(g).replace(/^\//, '').toLowerCase());
  const cleanTarget = targetGroup.replace(/^\//, '').toLowerCase();

  // If user has 'admin', 'administrator', or matches target workspace group/namespace
  if (
    normalizedGroups.includes('admin') ||
    normalizedGroups.includes('administrator') ||
    normalizedGroups.includes(cleanTarget)
  ) {
    return true;
  }

  console.warn(`[GROUP AUTH REJECT] User "${username}" claims do not include required workspace group "${cleanTarget}". User groups:`, normalizedGroups);
  return false;
}

// --- 2. API ROUTES ---


// --- ROUTER MODULE IMPORTS ---
const { createConfigRouter } = require('./routes/configRoutes');
const { createWorkflowRouter } = require('./routes/workflowRoutes');
const { createExecutionRouter } = require('./routes/executionRoutes');
const { createPackageRouter } = require('./routes/packageRoutes');
const { createWorkspaceRouter } = require('./routes/workspaceRoutes');
const { createApplicationRouter } = require('./routes/applicationRoutes');
const { createLogRouter } = require('./routes/logRoutes');

const requiresApplicationsEnabled = (req, res, next) => {
  if (!ENABLE_APPLICATIONS) {
    return res.status(403).json({
      message: "Application management is disabled on this server instance."
    });
  }
  next();
};

const routerContext = {
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
  k8sApi: customObjectsApi,
  k8sCustomApi: customObjectsApi,
  k8sCoreApi: coreV1Api,
  kc,
  getUsername,
  getCandidateUsernames,
  getGitLabPath: (vp, req) => getGitLabPath(vp, req, { GITLAB_WORKFLOWS_PATH, MULTI_TENANT_MODE }),
  getGitLabPackagesPath: (vp, req) => getGitLabPackagesPath(vp, req, { GITLAB_PACKAGES_PATH, MULTI_TENANT_MODE }),
  getVirtualPath,
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
};

const apiRouter = express.Router();

apiRouter.use('/', createConfigRouter(routerContext));
apiRouter.use('/', createWorkflowRouter(routerContext));
apiRouter.use('/', createExecutionRouter(routerContext));
apiRouter.use('/', createPackageRouter(routerContext));
apiRouter.use('/', createWorkspaceRouter(routerContext));
apiRouter.use('/', createApplicationRouter(routerContext));
apiRouter.use('/', createLogRouter(routerContext));

// --- Resilient API Mounting ---
if (BASE_PATH !== "") {
  // Ensure the base path does not have a trailing slash, but the mount point expects a slash before 'api'
  const cleanBasePath = BASE_PATH.replace(/\/$/, "");
  app.use(`${cleanBasePath}/api`, apiRouter);
}

// Always mount on /api as a fallback
app.use('/api', apiRouter);

// --- 3. CATCH-ALL ROUTE ---

if (BASE_PATH !== "") {
  // Redirect base path without trailing slash to base path with trailing slash
  app.get(BASE_PATH, (req, res) => {
    res.redirect(`${BASE_PATH}/`);
  });
}

// Catch-all route to serve index.html for React Router
if (BASE_PATH !== "") {
  app.get(`${BASE_PATH}/*path`, (req, res) => {
    serveIndex(req, res);
  });
}

app.get("/*path", (req, res) => {
  serveIndex(req, res);
});

// Also handle the root if BASE_PATH is empty or for initial entry
if (BASE_PATH !== "") {
  app.get("/", (req, res) => {
    res.redirect(BASE_PATH);
  });
}


// --- 4. ERROR HANDLING ---

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack || err.message);

  // Check if this error originated from an external Axios request (e.g. GitLab API client)
  const isAxiosOrGitLabError = axios.isAxiosError(err) || (err.config && (
    err.config.headers?.['PRIVATE-TOKEN'] || 
    (err.config.url && (err.config.url.includes('/projects/') || err.config.url.includes('/api/v4'))) ||
    (err.config.baseURL && err.config.baseURL.includes('/api/v4'))
  ));

  if (isAxiosOrGitLabError) {
    let status = 502; // Use 502 Bad Gateway to signal backend integration failure
    let customMessage = "An error occurred while communicating with an external service.";

    if (err.response) {
      const gitlabStatus = err.response.status;
      if (gitlabStatus === 401) {
        customMessage = `GitLab Authentication Failed: The configured GITLAB_TOKEN is invalid, expired, or does not have access rights for project "${process.env.GITLAB_PROJECT_ID || ''}".`;
      } else if (gitlabStatus === 403) {
        customMessage = "GitLab Access Forbidden: The configured GITLAB_TOKEN does not have permissions for the project/repository.";
      } else if (gitlabStatus === 404) {
        customMessage = `GitLab Resource Not Found: The configured GITLAB_PROJECT_ID ("${process.env.GITLAB_PROJECT_ID || ''}") or branch ("${process.env.GITLAB_BRANCH || ''}") could not be found.`;
      } else {
        customMessage = `GitLab Integration Error (${gitlabStatus}): ${err.response.data?.message || err.response.data?.error || err.message}`;
      }
    } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || (err.message && err.message.includes('getaddrinfo'))) {
      customMessage = `GitLab Unreachable: Failed to resolve or connect to GITLAB_URL ("${process.env.GITLAB_URL || 'https://gitlab.com'}"). Please check your network and configuration.`;
    } else {
      customMessage = `GitLab Connection Error: ${err.message}`;
    }

    return res.status(status).json({
      message: customMessage,
      originalStatus: err.response ? err.response.status : null
    });
  }

  // If this is an auth error from internal authentication middleware and we're on an API route
  if (err.status === 401 || err.statusCode === 401) {
    return res.status(401).json({ 
      message: 'Authentication Required',
      loginUrl: `${BASE_PATH}/login` 
    });
  }

  const status = err.response ? err.response.status : (err.status || err.statusCode || 500);
  const message = err.response ? err.response.data : { message: err.message };
  res.status(status).json(message);
});


// Global safety error handlers to prevent Node.js process crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

// --- 5. SERVER START ---

const HOST = process.env.HOST || '::';
const server = app.listen(PORT, HOST, () => {
  console.log(`Server is running on ${HOST}:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});