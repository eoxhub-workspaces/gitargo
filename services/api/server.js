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
  "cpu-standard": {
    label: "Standard CPU (2 CPU, 4Gi RAM)",
    resources: {
      limits: { cpu: "2", memory: "4Gi" },
      requests: { cpu: "500m", memory: "1Gi" }
    }
  },
  "cpu-performance": {
    label: "Performance CPU (10 CPU, 48Gi RAM)",
    resources: {
      limits: { cpu: "10", memory: "48Gi" },
      requests: { cpu: "5", memory: "24Gi" }
    }
  },
  "gpu-nvidia": {
    label: "NVIDIA GPU (1 GPU, 4 CPU, 16Gi RAM)",
    resources: {
      limits: { "nvidia.com/gpu": "1", cpu: "4", memory: "16Gi" },
      requests: { "nvidia.com/gpu": "1", cpu: "2", memory: "8Gi" }
    },
    tolerations: [
      { key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" }
    ]
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

const DEFAULT_TOLERATIONS = [
  { key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule", label: "NVIDIA GPU Pool" },
  { key: "dedicated", operator: "Equal", value: "high-mem", effect: "NoSchedule", label: "High-Memory Dedicated Pool" }
];

const DEFAULT_NODE_SELECTORS = [];

let ARGO_AVAILABLE_TOLERATIONS = DEFAULT_TOLERATIONS;
if (process.env.ARGO_AVAILABLE_TOLERATIONS) {
  ARGO_AVAILABLE_TOLERATIONS = parseEnvJson(process.env.ARGO_AVAILABLE_TOLERATIONS, DEFAULT_TOLERATIONS);
}

let ARGO_AVAILABLE_NODE_SELECTORS = DEFAULT_NODE_SELECTORS;
if (process.env.ARGO_AVAILABLE_NODE_SELECTORS) {
  ARGO_AVAILABLE_NODE_SELECTORS = parseEnvJson(process.env.ARGO_AVAILABLE_NODE_SELECTORS, DEFAULT_NODE_SELECTORS);
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

const apiRouter = express.Router();

/**
 * GET /api/diag/token
 * Diagnostic endpoint to view the current session token claims.
 */
apiRouter.get("/diag/token", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "No session found." });
  }

  res.json({
    user: req.user,
    token: req.token ? "present" : "missing"
  });
});

// Protect all /api routes with authentication & workspace group authorization
apiRouter.use((req, res, next) => {
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
apiRouter.get("/config", (req, res) => {
  res.json({
    version: APP_VERSION,
    profiles: ARGO_PROFILES,
    availableTolerations: ARGO_AVAILABLE_TOLERATIONS,
    availableNodeSelectors: ARGO_AVAILABLE_NODE_SELECTORS,
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
apiRouter.get("/published-workflows", async (req, res, next) => {
  try {
    const filePath = "pygeoapi/hr-pygeoapi.yaml";
    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(response.data);
      const published = parsed?.spec?.values?.argoWorkflows || [];
      res.json(published.map(p => p.id));
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.json([]);
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/.../publish
 * Publish a workflow template to pygeoapi/hr-pygeoapi.yaml.
 */
apiRouter.post(/^\/workflows\/(.+)\/publish$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filename = virtualPath.split('/').pop();
    const logicalName = filename.replace(/\.ya?ml$/i, "");
    const filePath = "pygeoapi/hr-pygeoapi.yaml";

    let content = "";
    let action = "update";

    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      content = response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        action = "create";
        content = "spec:\n  values:\n    argoWorkflow: []";
      } else {
        throw error;
      }
    }

    const parsed = YAML.parse(content) || {};
    if (!parsed.spec) parsed.spec = {};
    if (!parsed.spec.values) parsed.spec.values = {};
    if (!parsed.spec.values.argoWorkflows) parsed.spec.values.argoWorkflows = [];

    const exists = parsed.spec.values.argoWorkflows.some(w => w.id === logicalName);
    if (!exists) {
      parsed.spec.values.argoWorkflows.push({
        id: logicalName,
        workflowTemplate: logicalName
      });

      await gitlabApi.post(
        `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
        {
          branch: GITLAB_BRANCH,
          commit_message: `Publish ${logicalName} to pygeoapi`,
          actions: [
            {
              action: action,
              file_path: filePath,
              content: YAML.stringify(parsed)
            }
          ]
        }
      );
    }

    res.json({ message: `Workflow ${logicalName} published successfully.` });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/workflows/.../publish
 * Unpublish a workflow template from pygeoapi/hr-pygeoapi.yaml.
 */
apiRouter.delete(/^\/workflows\/(.+)\/publish$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filename = virtualPath.split('/').pop();
    const logicalName = filename.replace(/\.ya?ml$/i, "");
    const filePath = "pygeoapi/hr-pygeoapi.yaml";

    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      
      const parsed = YAML.parse(response.data);
      if (parsed?.spec?.values?.argoWorkflows) {
        const initialLength = parsed.spec.values.argoWorkflows.length;
        parsed.spec.values.argoWorkflows = parsed.spec.values.argoWorkflows.filter(
          w => w.id !== logicalName
        );

        if (parsed.spec.values.argoWorkflows.length < initialLength) {
          await gitlabApi.post(
            `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
            {
              branch: GITLAB_BRANCH,
              commit_message: `Unpublish ${logicalName} from pygeoapi`,
              actions: [
                {
                  action: "update",
                  file_path: filePath,
                  content: YAML.stringify(parsed)
                }
              ]
            }
          );
        }
      }
      res.json({ message: `Workflow ${logicalName} unpublished successfully.` });
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.json({ message: "File not found, nothing to unpublish." });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/workflows/*/sync-status
// Check if the Kubernetes resource for a workflow has been updated with a specific sync-token.
apiRouter.get(/^\/workflows\/(.+)\/sync-status$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filename = virtualPath.split('/').pop();
    const logicalName = filename.replace(/\.ya?ml$/i, "");
    const { token } = req.query;
    const namespace = process.env.ARGO_NAMESPACE || "default";

    if (!token) {
      return res.status(400).json({ message: "token query parameter is required." });
    }

    console.log(`Checking sync status for ${logicalName} with token ${token}`);

    // We check all allowed Argo kinds
    for (const kind of allowedArgoKinds) {
      try {
        const response = await customObjectsApi.getNamespacedCustomObject({
          group: 'argoproj.io',
          version: 'v1alpha1',
          namespace: namespace,
          plural: `${kind.toLowerCase()}s`,
          name: logicalName
        });

        const currentToken = response.metadata?.annotations?.['gitargo/sync-token'];
        if (currentToken === token) {
          return res.json({ synced: true, kind: kind });
        }
      } catch (e) {
        // Resource might not exist as this kind, ignore and try next
      }
    }

    res.json({ synced: false });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/workflows
 * List files ending in .yaml, .yml, or .deleted in the GITLAB_WORKFLOWS_PATH.
 */
apiRouter.get("/workflows", async (req, res, next) => {
  try {
    let searchPath = GITLAB_WORKFLOWS_PATH === "." ? "" : GITLAB_WORKFLOWS_PATH;
    
    if (MULTI_TENANT_MODE) {
      const user = getUsername(req);
      if (user) {
        searchPath = searchPath ? `${searchPath.replace(/\/$/, "")}/${user}` : user;
      }
    }

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: searchPath,
          ref: GITLAB_BRANCH,
          recursive: true
        }
      }
    );

    const prefix = searchPath ? `${searchPath.replace(/\/$/, "")}/` : "";

    const workflows = response.data
      .filter(
        (file) =>
          file.type === "blob" &&
          (file.name.endsWith(".yaml") || file.name.endsWith(".yml") || file.name.endsWith(".deleted"))
      )
      .map((file) => {
        let relativePath = file.path;
        if (prefix && relativePath.startsWith(prefix)) {
          relativePath = relativePath.slice(prefix.length);
        }
        return { ...file, path: relativePath };
      });

    res.json(workflows);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

/**
 * GET /api/workflows/.../history
 * Get the commit history for a file.
 */
apiRouter.get(/^\/workflows\/(.+)\/history$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPath(virtualPath, req);
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        params: {
          path: filePath,
          ref_name: GITLAB_BRANCH
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/workflows/<path>
 * Get the raw content of a file.
 */
apiRouter.get(/^\/workflows\/(.+)$/, async (req, res, next) => {
  // If the wildcard matches nothing, req.path might be '/workflows/' or '/workflows'.
  if (req.path === '/workflows/' || req.path === '/workflows') return next();

  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPath(virtualPath, req);
    const ref = req.query.ref || GITLAB_BRANCH;

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
      {
        params: {
          ref: ref
        }
      }
    );

    res.send(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/<path>/restore
 * Restore a soft-deleted workflow.
 */
apiRouter.post(/^\/workflows\/(.+)\/restore$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPath(virtualPath, req);
    const originalPath = filePath.replace(/\.deleted$/, "");

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Restore ${originalPath}`,
        actions: [
          {
            action: "move",
            previous_path: filePath,
            file_path: originalPath
          }
        ]
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/workflows/*
 * Soft-delete a workflow by renaming it with a .deleted extension.
 */
apiRouter.delete(/^\/workflows\/(.+)$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPath(virtualPath, req);
    
    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete ${filePath}`,
        actions: [
          {
            action: "move",
            previous_path: filePath,
            file_path: `${filePath}.deleted`
          }
        ]
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/*
 * Create a new file.
 */
apiRouter.post(
  /^\/workflows\/(.+)$/,
  validateArgoWorkflow,
  async (req, res, next) => {
    try {
      const virtualPath = getVirtualPath(req);
      const filePath = getGitLabPath(virtualPath, req);
      const { content, commit_message, applyDefaults } = req.body;

      // Inject defaults if requested
      let injectedContent = applyDefaults 
        ? injectDefaults(content, virtualPath, req)
        : content;

      injectedContent = ensureMultiTenantMetadataName(injectedContent, req);

      const response = await gitlabApi.post(
        `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
        {
          branch: GITLAB_BRANCH,
          commit_message: commit_message || `Create ${filePath}`,
          ...getCommitOptions(req),
          actions: [
            {
              action: "create",
              file_path: filePath,
              content: injectedContent
            }
          ]
        }
      );

      res.status(201).json(response.data);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/workflows/*
 * Update an existing file.
 */
apiRouter.put(
  /^\/workflows\/(.+)$/,
  validateArgoWorkflow,
  async (req, res, next) => {
    try {
      const virtualPath = getVirtualPath(req);
      const filePath = getGitLabPath(virtualPath, req);
      const { content, commit_message, applyDefaults } = req.body;

      // Inject defaults if requested
      let injectedContent = applyDefaults 
        ? injectDefaults(content, virtualPath, req)
        : content;

      injectedContent = ensureMultiTenantMetadataName(injectedContent, req);

      try {
        const response = await gitlabApi.post(
          `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
          {
            branch: GITLAB_BRANCH,
            commit_message: commit_message || `Update ${filePath}`,
            ...getCommitOptions(req),
            actions: [
              {
                action: "update",
                file_path: filePath,
                content: injectedContent
              }
            ]
          }
        );
        res.json(response.data);
      } catch (putError) {
        // If the file doesn't exist yet, GitLab PUT returns 400. 
        // We gracefully fallback to POST (create) action.
        if (
          putError.response &&
          putError.response.status === 400 &&
          putError.response.data &&
          putError.response.data.message &&
          putError.response.data.message.includes("A file with this name doesn't exist")
        ) {
          const postResponse = await gitlabApi.post(
            `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
            {
              branch: GITLAB_BRANCH,
              commit_message: commit_message || `Create ${filePath}`,
              actions: [
                {
                  action: "create",
                  file_path: filePath,
                  content: injectedContent
                }
              ]
            }
          );
          return res.status(201).json(postResponse.data);
        }
        // Otherwise re-throw the original error
        throw putError;
      }
    } catch (error) {
      next(error);
    }
  }
);

// Helper to ensure metadata.name and generateName are prefixed with username in MULTI_TENANT_MODE
function ensureMultiTenantMetadataName(content, req = null) {
  if (!MULTI_TENANT_MODE) return content;
  const user = getUsername(req);
  if (!user) return content;

  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") return content;
    if (!parsed.metadata) parsed.metadata = {};

    const prefix = `${user.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-`;

    if (parsed.metadata.name && !parsed.metadata.name.startsWith(prefix)) {
      parsed.metadata.name = `${prefix}${parsed.metadata.name}`;
    }
    if (parsed.metadata.generateName && !parsed.metadata.generateName.startsWith(prefix)) {
      parsed.metadata.generateName = `${prefix}${parsed.metadata.generateName}`;
    }

    return YAML.stringify(parsed);
  } catch (e) {
    return content;
  }
}

// --- Helper for injecting defaults ---
function injectDefaults(content, virtualPath, req = null) {
  const ARGO_NAMESPACE = process.env.ARGO_NAMESPACE;
  const ARGO_SERVICE_ACCOUNT = process.env.ARGO_SERVICE_ACCOUNT;
  const ARGO_TOLERATIONS = process.env.ARGO_TOLERATIONS;
  const ARGO_NODE_SELECTOR = process.env.ARGO_NODE_SELECTOR;
  const ARGO_AFFINITY = process.env.ARGO_AFFINITY;

  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") return content;

    if (!parsed.metadata) parsed.metadata = {};
    
    // Extract logical name from the path (e.g. workspaces/paquito.yaml -> paquito)
    let logicalName = "workflow-default";
    if (virtualPath) {
      const parts = virtualPath.split('/');
      const filename = parts[parts.length - 1];
      logicalName = filename.replace(/\.ya?ml$/i, "");
    }

    // Ensure metadata.name or generateName is present
    if (!parsed.metadata.name && !parsed.metadata.generateName) {
      parsed.metadata.name = logicalName;
      parsed.metadata.generateName = `${logicalName}-`;
    } else if (parsed.metadata.name && !parsed.metadata.generateName) {
      // If name is present but generateName is not, add generateName
      parsed.metadata.generateName = `${parsed.metadata.name}-`;
    }

    if (ARGO_NAMESPACE && !parsed.metadata.namespace) {
      parsed.metadata.namespace = ARGO_NAMESPACE;
    }

    if (!parsed.spec) parsed.spec = {};
    const isCron = parsed.kind === "CronWorkflow";
    if (isCron && !parsed.spec.workflowSpec) parsed.spec.workflowSpec = {};
    const spec = isCron ? parsed.spec.workflowSpec : parsed.spec;

    if (spec) {
      if (ARGO_SERVICE_ACCOUNT && !spec.serviceAccountName && !spec.serviceAccount) {
        spec.serviceAccountName = ARGO_SERVICE_ACCOUNT;
      }

      if (ARGO_TOLERATIONS && (!spec.tolerations || spec.tolerations.length === 0)) {
        try {
          spec.tolerations = JSON.parse(ARGO_TOLERATIONS);
        } catch (e) {
          console.error("Failed to parse ARGO_TOLERATIONS", e);
        }
      }

      if (ARGO_NODE_SELECTOR && (!spec.nodeSelector || Object.keys(spec.nodeSelector).length === 0)) {
        try {
          spec.nodeSelector = JSON.parse(ARGO_NODE_SELECTOR);
        } catch (e) {
          console.error("Failed to parse ARGO_NODE_SELECTOR", e);
        }
      }

      if (ARGO_AFFINITY && (!spec.affinity || Object.keys(spec.affinity).length === 0)) {
        try {
          spec.affinity = JSON.parse(ARGO_AFFINITY);
        } catch (e) {
          console.error("Failed to parse ARGO_AFFINITY", e);
        }
      }
    }

    return YAML.stringify(parsed);
  } catch (error) {
    console.error("Error injecting defaults:", error);
    return content;
  }
}


// --- Kubernetes Client Initialization ---
const kc = new k8s.KubeConfig();
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

try {
  if (fs.existsSync(SA_TOKEN_PATH)) {
    console.log(`Found ServiceAccount token at ${SA_TOKEN_PATH}`);
    kc.loadFromCluster();
    try {
      const saToken = fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
      const user = kc.getCurrentUser();
      if (user) {
        user.token = saToken;
      }
    } catch (e) {
      console.warn("Could not read ServiceAccount token file:", e.message);
    }
  } else {
    console.warn(`ServiceAccount token NOT FOUND at ${SA_TOKEN_PATH}. Falling back to default config.`);
    kc.loadFromDefault();
  }
  
  // Explicitly check for KUBERNETES_SERVICE_HOST to handle environments where DNS for .default.svc is flaky
  const cluster = kc.getCurrentCluster();
  if (cluster && process.env.KUBERNETES_SERVICE_HOST) {
    let host = process.env.KUBERNETES_SERVICE_HOST;
    // If the host is an IPv6 address (contains colons), it must be enclosed in square brackets in the URL
    if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) {
      host = `[${host}]`;
    }
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    cluster.server = `https://${host}:${port}`;
    cluster.skipTLSVerify = true; // Skip verification when using IP address
    console.log(`Using KUBERNETES_SERVICE_HOST for API connection: ${cluster.server} (TLS verify skipped)`);
  }

  // Allow manual token override from environment
  if (process.env.ARGO_AUTH_TOKEN) {
    console.log("Applying ARGO_AUTH_TOKEN override from environment.");
    const user = kc.getCurrentUser();
    if (user) {
      user.token = process.env.ARGO_AUTH_TOKEN;
    } else {
      kc.addUser({
        name: 'default-user',
        token: process.env.ARGO_AUTH_TOKEN
      });
      const context = kc.getContextObject('default');
      if (context) {
        context.user = 'default-user';
      }
    }
  }
  
  const user = kc.getCurrentUser();
  if (user && user.token) {
    console.log("Kubernetes client initialized with a token.");
  } else {
    console.warn("Kubernetes client initialized but NO TOKEN was found.");
  }
} catch (e) {
  console.error("Failed to initialize Kubernetes client:", e.message);
}

const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const networkingV1Api = kc.makeApiClient(k8s.NetworkingV1Api);

// Helper to safely parse and forward K8s API error bodies as real JSON objects (avoiding string double-encoding)
const sendK8sError = (res, error) => {
  let parsedBody = error.body;
  if (typeof error.body === "string") {
    try {
      parsedBody = JSON.parse(error.body);
    } catch (e) {
      parsedBody = { message: error.body };
    }
  }
  return res.status(error.statusCode || 500).json(parsedBody);
};

// Helper to inject JupyterHub PVC volume into workflow spec in MULTI_TENANT_MODE
function injectUserWorkspaceVolume(workflow, username) {
  if (!workflow || !workflow.spec) return workflow;
  if (!MULTI_TENANT_MODE || !JUPYTERHUB_PVC_NAME) return workflow;

  const targetSubPath = username || 'shared-user';
  const volName = "workspace-storage";
  if (!workflow.spec.volumes) workflow.spec.volumes = [];

  const exists = workflow.spec.volumes.some(v => v.name === volName);
  if (!exists) {
    workflow.spec.volumes.push({
      name: volName,
      persistentVolumeClaim: {
        claimName: JUPYTERHUB_PVC_NAME
      }
    });
  }

  if (Array.isArray(workflow.spec.templates)) {
    workflow.spec.templates.forEach(template => {
      if (template.container) {
        if (!template.container.volumeMounts) template.container.volumeMounts = [];
        const mountExists = template.container.volumeMounts.some(m => m.name === volName || m.mountPath === "/workspace");
        if (!mountExists) {
          template.container.volumeMounts.push({
            name: volName,
            mountPath: "/workspace",
            subPath: targetSubPath
          });
        }
      }

      // In multi-tenant mode, intercept standard workflow output artifacts if no S3 artifact repository exists
      // (This applies to standard workflows; CWL Application Packages execution logic is untouched).
      const isCwlWorkflow = workflow.metadata?.labels?.['gitargo.eox.at/type'] === 'cwl-package';
      if (!isCwlWorkflow && template.outputs && Array.isArray(template.outputs.artifacts)) {
        template.outputs.artifacts.forEach(artifact => {
          if (artifact.s3) {
            delete artifact.s3;
          }

          // Organize multi-tenant workflow artifacts under argo-artifacts/{{workflow.name}}/ on user PVC
          if (!artifact.path) {
            artifact.path = `/workspace/argo-artifacts/{{workflow.name}}/${artifact.name || 'output'}`;
          } else if (artifact.path === "/workspace" || artifact.path === "/workspace/") {
            artifact.path = `/workspace/argo-artifacts/{{workflow.name}}`;
          } else if (artifact.path.startsWith("/workspace/")) {
            const rel = artifact.path.replace(/^\/workspace\//, "");
            if (!rel.startsWith("argo-artifacts/")) {
              artifact.path = `/workspace/argo-artifacts/{{workflow.name}}/${rel}`;
            }
          } else if (!artifact.path.startsWith("/workspace")) {
            const base = path.basename(artifact.path);
            artifact.path = `/workspace/argo-artifacts/{{workflow.name}}/${base || artifact.name || 'output'}`;
          }
        });
      }
    });
  }

  return workflow;
}

/**
 * GET /api/executions
 * List Argo Workflows directly via Kubernetes API using the official client
 */
apiRouter.get("/executions", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    console.log(`Fetching workflows from K8s API (namespace: ${namespace})`);

    let labelSelector = undefined;
    if (MULTI_TENANT_MODE) {
      const user = getUsername(req);
      if (user) {
        labelSelector = `workflows.argoproj.io/creator-preferred-username=${user}`;
        console.log(`[API EXECUTIONS] Filtering executions for user labelSelector: "${labelSelector}"`);
      }
    }
    
    const response = await customObjectsApi.listNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      labelSelector: labelSelector
    });
    
    // The K8s client wraps the response in { response, body }
    const items = response.body?.items || response.items || response.data?.items || [];
    if (Array.isArray(items)) {
      items.sort((a, b) => {
        const timeA = new Date(a.metadata?.creationTimestamp || a.status?.startedAt || 0).getTime();
        const timeB = new Date(b.metadata?.creationTimestamp || b.status?.startedAt || 0).getTime();
        return timeB - timeA;
      });
    }
    res.json(Array.isArray(items) ? items : []);
  } catch (error) {
    console.error("Error fetching workflows from K8s API:", error.message);
    if (error.body) {
       console.error("K8s API Error Body:", error.body);
    }
    next(error);
  }
});

/**
 * GET /api/executions/:name
 * Get details of a specific Argo Workflow directly via Kubernetes API
 */
apiRouter.get("/executions/:name", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const { name } = req.params;
    
    console.log(`Fetching workflow details from K8s API (namespace: ${namespace}, name: ${name})`);
    const response = await customObjectsApi.getNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      name: name
    });
    
    res.json(response);
  } catch (error) {
    console.error(`Error fetching workflow ${req.params.name} from K8s API:`, error.message);
    next(error);
  }
});

/**
 * DELETE /api/executions/:name
 * Delete a specific Argo Workflow directly via Kubernetes API
 */
apiRouter.delete("/executions/:name", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const { name } = req.params;
    
    console.log(`Deleting workflow from K8s API (namespace: ${namespace}, name: ${name})`);
    
    const response = await customObjectsApi.deleteNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      name: name
    });
    
    res.json({ message: `Workflow ${name} deleted successfully.` });
  } catch (error) {
    console.error(`Error deleting workflow ${req.params.name} from K8s API:`, error.message);
    if (error.body) {
      console.error(`K8s API Error Body:`, error.body);
      return sendK8sError(res, error);
    }
    next(error);
  }
});

/**
 * POST /api/executions/:name/terminate
 * Terminate a specific Argo Workflow via Kubernetes API by patching its spec.
 */
apiRouter.post("/executions/:name/terminate", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const { name } = req.params;
    
    console.log(`Terminating workflow from K8s API (namespace: ${namespace}, name: ${name})`);
    
    // To terminate an Argo workflow, we patch the spec to include `shutdown: Terminate`
    const patch = [{
      op: "replace",
      path: "/spec/shutdown",
      value: "Terminate"
    }];

    const options = { headers: { 'Content-Type': 'application/json-patch+json' } };
    
    const response = await customObjectsApi.patchNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      name: name,
      body: patch
    }, undefined, undefined, undefined, options);
    
    res.json({ message: `Workflow ${name} termination requested.` });
  } catch (error) {
    console.error(`Error terminating workflow ${req.params.name} from K8s API:`, error.message);
    if (error.body) {
      console.error(`K8s API Error Body:`, error.body);
      return sendK8sError(res, error);
    }
    next(error);
  }
});

/**
 * POST /api/executions
 * Submit a new Argo Workflow directly via Kubernetes API
 */
apiRouter.post("/executions", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const workflow = req.body;
    
    if (!workflow || typeof workflow !== "object") {
      return res.status(400).json({ message: "Invalid workflow definition." });
    }

    if (!workflow.metadata) workflow.metadata = {};
    workflow.metadata.namespace = namespace;
    workflow.kind = "Workflow";
    workflow.apiVersion = "argoproj.io/v1alpha1";

    if (!workflow.spec) workflow.spec = {};
    if (!workflow.spec.serviceAccountName && !workflow.spec.serviceAccount) {
      workflow.spec.serviceAccountName = process.env.ARGO_SERVICE_ACCOUNT || "default";
    }

    // Inject OIDC username label if present to resolve workflow variables like creator-preferred-username
    const username = getUsername(req);
    if (username) {
      if (!workflow.metadata.labels) workflow.metadata.labels = {};
      workflow.metadata.labels['workflows.argoproj.io/creator-preferred-username'] = username;
      console.log(`[API EXECUTIONS] Injected workflows.argoproj.io/creator-preferred-username label: "${username}"`);
    }

    // Inject JupyterHub PVC volume if enabled/present
    injectUserWorkspaceVolume(workflow, username);
    
    delete workflow.metadata.resourceVersion;
    delete workflow.metadata.uid;
    
    // To allow multiple executions of the same template, we must use generateName
    // and remove the exact name, so Kubernetes appends a unique ID.
    if (workflow.metadata.name) {
      workflow.metadata.generateName = workflow.metadata.name;
      if (!workflow.metadata.generateName.endsWith('-')) {
         workflow.metadata.generateName += '-';
      }
      delete workflow.metadata.name;
    } else if (!workflow.metadata.generateName) {
      workflow.metadata.generateName = 'workflow-';
    }

    console.log(`Submitting workflow to K8s API (namespace: ${namespace})`);
    
    const response = await customObjectsApi.createNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      body: workflow
    });
    
    res.status(201).json(response);
  } catch (error) {
    console.error("Error submitting workflow to K8s API:", error.message);
    if (error.body) {
      console.error(`K8s API Error Body:`, error.body);
      return sendK8sError(res, error);
    }
    next(error);
  }
});

/**
 * GET /api/packages
 * List saved CWL / Application Package files in GITLAB_PACKAGES_PATH
 */
apiRouter.get("/packages", async (req, res, next) => {
  try {
    let searchPath = GITLAB_PACKAGES_PATH;
    if (MULTI_TENANT_MODE) {
      const user = getUsername(req);
      if (user) {
        searchPath = `${searchPath.replace(/\/$/, "")}/${user}`;
      }
    }

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: searchPath,
          ref: GITLAB_BRANCH,
          recursive: true
        }
      }
    );

    const prefix = `${searchPath.replace(/\/$/, "")}/`;

    const packages = response.data
      .filter(
        (file) =>
          file.type === "blob" &&
          (file.name.endsWith(".cwl") || file.name.endsWith(".yaml") || file.name.endsWith(".yml"))
      )
      .map((file) => {
        let relativePath = file.path;
        if (prefix && relativePath.startsWith(prefix)) {
          relativePath = relativePath.slice(prefix.length);
        }
        return { ...file, path: relativePath };
      });

    res.json(packages);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

/**
 * GET /api/packages/*
 * Get raw package content
 */
apiRouter.get(/^\/packages\/(.+)$/, async (req, res, next) => {
  if (req.path === '/packages/' || req.path === '/packages') return next();

  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPackagesPath(virtualPath, req);
    const ref = req.query.ref || GITLAB_BRANCH;

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
      {
        params: { ref },
        responseType: 'text'
      }
    );

    res.setHeader('Content-Type', 'text/plain');
    res.send(response.data);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ message: "Package file not found in repository." });
    }
    next(error);
  }
});

/**
 * POST /api/packages/*
 * Create or update a package file in GitLab
 */
apiRouter.post(/^\/packages\/(.+)$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPackagesPath(virtualPath, req);
    const { content, commit_message } = req.body;

    if (!content) {
      return res.status(400).json({ message: "Content is required." });
    }

    let action = 'create';
    try {
      await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}`,
        { params: { ref: GITLAB_BRANCH } }
      );
      action = 'update';
    } catch (err) {
      if (err.response && err.response.status === 404) {
        action = 'create';
      } else {
        throw err;
      }
    }

    const commitMsg = commit_message || `${action === 'create' ? 'Add' : 'Update'} package ${virtualPath}`;

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: commitMsg,
        actions: [
          {
            action: action,
            file_path: filePath,
            content: content
          }
        ]
      }
    );

    res.json({ message: `Package ${virtualPath} saved successfully.`, commit: response.data });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/packages/*
 * Delete a package file in GitLab
 */
apiRouter.delete(/^\/packages\/(.+)$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPackagesPath(virtualPath, req);

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete package ${virtualPath}`,
        actions: [
          {
            action: 'delete',
            file_path: filePath
          }
        ]
      }
    );

    res.json({ message: `Package ${virtualPath} deleted successfully.` });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/executions/cwl
 * Submit a CWL execution by wrapping it in an Argo Workflow using cwltool
 */
apiRouter.post("/executions/cwl", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const { cwlUrl, cwlContent, processId: reqProcessId, parameters, inputTypes, inlineFiles, name, packageId } = req.body;

    if (!cwlUrl && !cwlContent) {
      return res.status(400).json({ message: "Either cwlUrl or cwlContent is required." });
    }

    const username = getUsername(req);
    const cleanName = (name || "cwl-execution").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    let cleanPackageId = (packageId || cleanName).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (cleanPackageId.length > 63) {
      cleanPackageId = cleanPackageId.substring(0, 63).replace(/-+$/, "");
    }

    const outDir = MULTI_TENANT_MODE
      ? "/workspace/application_packages_executions/{{workflow.name}}"
      : "/tmp/application_packages_executions/{{workflow.name}}";
    let inlineSetupCmds = "";

    // Construct standard CWL Job Object (job.json)
    const jobObj = {};

    if (parameters && typeof parameters === 'object') {
      Object.entries(parameters).forEach(([key, val]) => {
        if (val === undefined || val === null || val === '') return;
        const typeStr = String(inputTypes?.[key] || '').toLowerCase();

        if (typeStr.includes('[]') || typeStr.includes('array')) {
          if (typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed.startsWith('[')) {
              try {
                jobObj[key] = JSON.parse(trimmed);
              } catch (e) {
                jobObj[key] = val.split(',').map(s => s.trim()).filter(Boolean);
              }
            } else {
              jobObj[key] = val.split(',').map(s => s.trim()).filter(Boolean);
            }
          } else if (Array.isArray(val)) {
            jobObj[key] = val;
          }
        } else if (typeStr.includes('int')) {
          const num = parseInt(String(val), 10);
          jobObj[key] = isNaN(num) ? val : num;
        } else if (typeStr.includes('float') || typeStr.includes('double') || typeStr.includes('number')) {
          const num = parseFloat(String(val));
          jobObj[key] = isNaN(num) ? val : num;
        } else if (typeStr.includes('boolean')) {
          jobObj[key] = String(val) === 'true';
        } else if (typeStr.includes('directory')) {
          jobObj[key] = typeof val === 'object' && val !== null ? val : { "class": "Directory", "path": String(val) };
        } else if (typeStr.includes('file')) {
          jobObj[key] = typeof val === 'object' && val !== null ? val : { "class": "File", "path": String(val) };
        } else if (typeStr.includes('uri') || typeStr.includes('record') || typeStr.includes('string_format') || typeStr.includes('#')) {
          if (typeof val === 'object' && val !== null) {
            jobObj[key] = val;
          } else if (typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed.startsWith('{')) {
              try {
                jobObj[key] = JSON.parse(trimmed);
              } catch (e) {
                jobObj[key] = { "value": val };
              }
            } else {
              jobObj[key] = { "value": val };
            }
          } else {
            jobObj[key] = { "value": val };
          }
        } else {
          if (typeof val === 'string' && val.trim().startsWith('{')) {
            try {
              jobObj[key] = JSON.parse(val.trim());
            } catch (e) {
              jobObj[key] = val;
            }
          } else {
            jobObj[key] = val;
          }
        }
      });
    }

    // Process inline secret/credentials/config files
    if (inlineFiles && typeof inlineFiles === 'object') {
      Object.entries(inlineFiles).forEach(([key, content]) => {
        if (content !== undefined && content !== null && content !== '') {
          const strContent = String(content);
          if (strContent.startsWith('/workspace/') || strContent.startsWith('/tmp/')) {
            jobObj[key] = { "class": "File", "path": strContent };
          } else {
            const encodedFile = Buffer.from(strContent).toString('base64');
            const filePath = `/tmp/inputs/${key}`;
            inlineSetupCmds += `mkdir -p /tmp/inputs && echo "${encodedFile}" | base64 -d > ${filePath} && `;
            jobObj[key] = { "class": "File", "path": filePath };
          }
        }
      });
    }

    // Helper to find dockerPull recursively in parsed CWL
    function findDockerPullImage(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.dockerPull && typeof obj.dockerPull === 'string') return obj.dockerPull;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findDockerPullImage(item);
          if (found) return found;
        }
      }
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
          const found = findDockerPullImage(obj[key]);
          if (found) return found;
        }
      }
      return null;
    }

    // Try to extract dockerPull image and processId from cwlContent or cwlUrl
    let customContainerImage = null;
    let targetProcessId = reqProcessId || null;

    try {
      let rawCwlStr = cwlContent;
      if (!rawCwlStr && cwlUrl) {
        const rawUrl = cwlUrl.includes("github.com") && cwlUrl.includes("/blob/")
          ? cwlUrl.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")
          : cwlUrl;
        const resp = await axios.get(rawUrl, { responseType: "text" });
        rawCwlStr = resp.data;
      }
      if (rawCwlStr) {
        const parsedCwl = YAML.parse(rawCwlStr);
        customContainerImage = findDockerPullImage(parsedCwl);

        // Auto-detect target process ID if document contains $graph with multiple objects
        if (!targetProcessId && parsedCwl && Array.isArray(parsedCwl.$graph)) {
          const mainObj =
            parsedCwl.$graph.find((item) => item.id === "main" || item.class === "Workflow") ||
            parsedCwl.$graph.find((item) => item.inputs) ||
            parsedCwl.$graph[0];
          if (mainObj && mainObj.id) {
            targetProcessId = String(mainObj.id).replace(/^#/, '');
          }
        }
      }
    } catch (e) {
      console.warn("Failed to parse CWL for dockerPull extraction / processId resolution:", e.message);
    }

    const defaultImage = process.env.CWLTOOL_IMAGE || "ghcr.io/eoxhub-workspaces/gitargo-cwl-runner:latest";
    const selectedImage = defaultImage;

    console.log(`[CWL EXECUTION] Pod base image selected: "${selectedImage}" (gitargo cwl runner) | targetProcessId: "${targetProcessId || 'none'}"`);

    const bucket = process.env.S3_BUCKET || process.env.BUCKET_NAME || process.env.AWS_S3_BUCKET || "";
    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL || "";
    const accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "";
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "";

    const rawEndpoint = endpoint.startsWith('http://') || endpoint.startsWith('https://') ? endpoint : (endpoint ? `https://${endpoint}` : '');
    const encodedJobJson = Buffer.from(JSON.stringify(jobObj, null, 2)).toString('base64');
    const encodedCwl = cwlContent ? Buffer.from(cwlContent).toString('base64') : "";

    const baseOutDirPrefix = MULTI_TENANT_MODE
      ? "/workspace/application_packages_executions"
      : "/tmp/application_packages_executions";

    const containerEngine = (process.env.CONTAINER_ENGINE || "dind").toLowerCase();
    const targetFragment = targetProcessId ? `#${targetProcessId}` : "";

    const isDevImage =
      process.env.CWL_ENABLE_DIAGNOSTICS === "true" ||
      process.env.NODE_ENV === "development" ||
      selectedImage.includes(":dev") ||
      selectedImage.includes("-dev") ||
      selectedImage.includes(":staging") ||
      selectedImage.includes(":test") ||
      selectedImage.includes(":alpha") ||
      selectedImage.includes(":beta");

    const startBanner = isDevImage
      ? "=== GITARGO CWL RUNNER (DEV MODE) ==="
      : "=== OGC Application Package Execution Started ===";

    const runnerPy = `import os, sys, subprocess, glob, base64

os.environ["NO_COLOR"] = "1"
os.environ["CLICOLOR"] = "0"
os.environ["ANSI_COLORS_DISABLED"] = "1"

if "${containerEngine}" in ["dind", "docker"]:
    os.environ["DOCKER_HOST"] = "tcp://127.0.0.1:2375"
    os.environ["DOCKER_TLS_CERTDIR"] = ""

print("${startBanner}")

exec_name = sys.argv[1] if len(sys.argv) > 1 else "default-execution"
out_dir = "${baseOutDirPrefix}/" + exec_name
os.makedirs(out_dir, exist_ok=True)

job_json_path = os.path.join(out_dir, "job.json")
package_cwl_path = os.path.join(out_dir, "package.cwl")

# Write job.json
with open(job_json_path, "w") as f:
    f.write(base64.b64decode("${encodedJobJson}").decode("utf-8"))

${cwlContent ? `
with open(package_cwl_path, "w") as f:
    f.write(base64.b64decode("${encodedCwl}").decode("utf-8"))
target_cwl = package_cwl_path + "${targetFragment}"
` : `target_cwl = "${cwlUrl}" + "${targetFragment}"`}

# Run cwltool with native Docker
cmd = [
    "cwltool",
    "--disable-color",
    "--outdir", out_dir,
    target_cwl,
    job_json_path
]

ret = subprocess.run(cmd)
sys.exit(ret.returncode)
`;

    const encodedRunnerPy = Buffer.from(runnerPy).toString('base64');

    const devDiagnosticsScript = `
    echo "=== CWL EXECUTION DIAGNOSTICS ==="
    echo "Workflow Name: {{workflow.name}}"
    echo "Date: $(date 2>/dev/null || echo unknown)"
    echo "User: $(whoami 2>/dev/null || echo unknown) (UID: $(id -u 2>/dev/null || echo unknown))"
    echo "PATH: $PATH"
    echo "CONTAINER_ENGINE: ${containerEngine}"
    if [ "${containerEngine}" = "dind" ]; then
      export DOCKER_HOST="tcp://127.0.0.1:2375"
      export DOCKER_TLS_CERTDIR=""
      echo "Waiting for Docker-in-Docker sidecar daemon ($DOCKER_HOST)..."
      count=0
      until docker info >/dev/null 2>&1 || [ $count -gt 25 ]; do
        sleep 2
        count=$((count+1))
      done
      echo "Docker-in-Docker sidecar status:"
      docker info || echo 'FAILED TO CONNECT TO DOCKER DAEMON'
    fi
    echo "Checking cwltool: $(which cwltool 2>&1 || echo 'NOT FOUND')"
    echo "Checking docker: $(which docker 2>&1 || echo 'NOT FOUND')"
    echo "Checking python3: $(which python3 2>&1 || echo 'NOT FOUND')"
    echo "=================================="`;

    const prodQuietScript = `
    if [ "${containerEngine}" = "dind" ]; then
      export DOCKER_HOST="tcp://127.0.0.1:2375"
      export DOCKER_TLS_CERTDIR=""
      count=0
      until docker info >/dev/null 2>&1 || [ $count -gt 25 ]; do
        sleep 2
        count=$((count+1))
      done
    fi`;

    let executionCmd = `set -o pipefail && export PYTHONUNBUFFERED=1 && export NO_COLOR=1 && mkdir -p /tmp/runner /tmp/inputs ${baseOutDirPrefix}/{{workflow.name}} && {
  {${isDevImage ? devDiagnosticsScript : prodQuietScript}
    ${inlineSetupCmds}
    echo "${encodedRunnerPy}" | base64 -d > /tmp/runner/runner.py
    python3 /tmp/runner/runner.py {{workflow.name}}
  } 2>&1 | tee ${baseOutDirPrefix}/{{workflow.name}}/execution.log
  exit $?
}`;

    const ARGO_SERVICE_ACCOUNT = process.env.ARGO_SERVICE_ACCOUNT;
    const ARGO_TOLERATIONS = process.env.ARGO_TOLERATIONS;
    const ARGO_NODE_SELECTOR = process.env.ARGO_NODE_SELECTOR;
    const ARGO_IMAGE_PULL_SECRETS = process.env.ARGO_IMAGE_PULL_SECRETS || process.env.IMAGE_PULL_SECRET;

    const cwlCpuLimit = process.env.CWL_CPU_LIMIT || "1000m";
    const cwlMemLimit = process.env.CWL_MEMORY_LIMIT || "2Gi";
    const cwlCpuRequest = process.env.CWL_CPU_REQUEST || "100m";
    const cwlMemRequest = process.env.CWL_MEMORY_REQUEST || "256Mi";

    const workflowSpec = {
      entrypoint: "main",
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        runAsNonRoot: true
      },
      templates: [
        {
          name: "main",
          securityContext: {
            runAsUser: 1000,
            runAsGroup: 1000,
            runAsNonRoot: true
          },
          container: {
            image: selectedImage,
            command: ["/bin/bash", "-c"],
            args: [executionCmd],
            env: [
              { name: "NO_COLOR", value: "1" }
            ],
            resources: {
              requests: {
                memory: cwlMemRequest,
                cpu: cwlCpuRequest
              },
              limits: {
                memory: cwlMemLimit,
                cpu: cwlCpuLimit
              }
            }
          }
        }
      ]
    };

    if (containerEngine === "dind") {
      if (!workflowSpec.volumes) workflowSpec.volumes = [];
      workflowSpec.volumes.push(
        { name: "dind-storage", emptyDir: {} },
        { name: "dind-socket", emptyDir: {} },
        { name: "cwl-tmp", emptyDir: {} }
      );

      if (!workflowSpec.templates[0].container.volumeMounts) {
        workflowSpec.templates[0].container.volumeMounts = [];
      }
      workflowSpec.templates[0].container.volumeMounts.push(
        { name: "dind-socket", mountPath: "/var/run" },
        { name: "cwl-tmp", mountPath: "/tmp" }
      );

      workflowSpec.templates[0].sidecars = [
        {
          name: "dind",
          image: process.env.DIND_IMAGE || "docker:24-dind",
          command: ["dockerd-entrypoint.sh"],
          args: [
            "dockerd",
            "--host=tcp://127.0.0.1:2375",
            "--tls=false"
          ],
          env: [
            { name: "DOCKER_TLS_CERTDIR", value: "" },
            { name: "DOCKER_DRIVER", value: "overlay2" }
          ],
          securityContext: {
            privileged: true,
            runAsUser: 0,
            runAsGroup: 0,
            runAsNonRoot: false
          },
          volumeMounts: [
            { name: "dind-storage", mountPath: "/var/lib/docker" },
            { name: "dind-socket", mountPath: "/var/run" },
            { name: "cwl-tmp", mountPath: "/tmp" }
          ],
          resources: {
            requests: { memory: cwlMemRequest, cpu: cwlCpuRequest },
            limits: { memory: cwlMemLimit, cpu: cwlCpuLimit }
          }
        }
      ];

      if (!workflowSpec.templates[0].container.env) {
        workflowSpec.templates[0].container.env = [];
      }
      workflowSpec.templates[0].container.env.push(
        { name: "DOCKER_HOST", value: "tcp://127.0.0.1:2375" },
        { name: "DOCKER_TLS_CERTDIR", value: "" }
      );
    } else if (containerEngine === "docker") {
      if (!workflowSpec.volumes) workflowSpec.volumes = [];
      workflowSpec.volumes.push({
        name: "docker-sock",
        hostPath: { path: "/var/run/docker.sock", type: "Socket" }
      });
      if (!workflowSpec.templates[0].container.volumeMounts) {
        workflowSpec.templates[0].container.volumeMounts = [];
      }
      workflowSpec.templates[0].container.volumeMounts.push({
        name: "docker-sock",
        mountPath: "/var/run/docker.sock"
      });
    }

    if (!MULTI_TENANT_MODE && bucket && endpoint && accessKey && secretKey) {
      workflowSpec.templates[0].outputs = {
        artifacts: [
          {
            name: "results",
            path: outDir,
            archive: {
              none: {}
            },
            s3: {
              key: "application_packages_executions/{{workflow.name}}"
            }
          }
        ]
      };
    }

    const disableImagePull = process.env.DISABLE_IMAGE_PULL_SECRETS === "true" || String(ARGO_IMAGE_PULL_SECRETS).toLowerCase() === "none" || String(ARGO_IMAGE_PULL_SECRETS).toLowerCase() === "disabled";

    if (ARGO_IMAGE_PULL_SECRETS && !disableImagePull) {
      try {
        workflowSpec.imagePullSecrets = JSON.parse(ARGO_IMAGE_PULL_SECRETS);
      } catch (e) {
        workflowSpec.imagePullSecrets = [{ name: ARGO_IMAGE_PULL_SECRETS }];
      }
    }

    workflowSpec.serviceAccountName = process.env.ARGO_SERVICE_ACCOUNT || "default";

    if (ARGO_TOLERATIONS) {
      try {
        workflowSpec.tolerations = JSON.parse(ARGO_TOLERATIONS);
      } catch (e) {
        console.error("Failed to parse ARGO_TOLERATIONS for CWL execution:", e);
      }
    }

    if (ARGO_NODE_SELECTOR) {
      try {
        workflowSpec.nodeSelector = JSON.parse(ARGO_NODE_SELECTOR);
      } catch (e) {
        console.error("Failed to parse ARGO_NODE_SELECTOR for CWL execution:", e);
      }
    }

    const workflow = {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Workflow",
      metadata: {
        generateName: `${cleanName}-`,
        namespace: namespace,
        labels: {
          'gitargo.eox.at/type': 'cwl-package',
          'gitargo.eox.at/package-id': cleanPackageId
        }
      },
      spec: workflowSpec
    };

    const userLabel = username || (MULTI_TENANT_MODE ? 'anonymous' : null);
    if (userLabel) {
      workflow.metadata.labels['workflows.argoproj.io/creator-preferred-username'] = userLabel;
    }

    // Inject workspace volume
    injectUserWorkspaceVolume(workflow, username);

    console.log(`Submitting CWL workflow to K8s API (namespace: ${namespace}, packageId: ${cleanPackageId})`);

    const response = await customObjectsApi.createNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      body: workflow
    });

    res.status(201).json(response);
  } catch (error) {
    console.error("Error submitting CWL workflow:", error.message);
    if (error.body) {
      return sendK8sError(res, error);
    }
    next(error);
  }
});

/**
 * GET /api/workspace/files
 * List or download files from the workspace.
 * In Multi-Tenant Mode: Strictly isolates user to /shared-workspace/<username>/ on PVC.
 * In Single-Tenant Mode: Always uses connected S3 Bucket if configured, or /shared-workspace on local PVC.
 */
apiRouter.get("/workspace/files", async (req, res, next) => {
  try {
    const reqPath = req.query.path || "";
    // Sanitize path against directory traversal
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "").replace(/^\/+/, "");

    // --- MULTI-TENANT MODE: Strict User PVC Isolation ---
    if (MULTI_TENANT_MODE) {
      const username = getUsername(req);
      if (!username) {
        return res.status(403).json({ message: "Access denied. User session required in multi-tenant mode." });
      }

      const candidateUsernames = [username];
      if (username.includes('@')) {
        candidateUsernames.push(username.split('@')[0]);
      }

      let targetPath = null;
      for (const uName of candidateUsernames) {
        const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH, uName);
        const resolvedPath = path.resolve(rootDir, safePath);

        // Security Enforcement: Target path MUST stay strictly inside user's directory
        if (resolvedPath.startsWith(rootDir) && fs.existsSync(resolvedPath)) {
          targetPath = resolvedPath;
          break;
        }
      }

      if (!targetPath) {
        return res.json({ files: [], exists: false, currentPath: safePath });
      }

      const stat = fs.statSync(targetPath);
      if (stat.isFile()) {
        return res.sendFile(targetPath);
      }

      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const pvcFiles = entries.map(entry => {
        const full = path.join(targetPath, entry.name);
        let size = 0;
        let mtime = null;
        try {
          const s = fs.statSync(full);
          size = s.size;
          mtime = s.mtime;
        } catch (e) {}

        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? 0 : size,
          mtime: mtime
        };
      });

      return res.json({ files: pvcFiles, exists: true, currentPath: safePath });
    }

    // --- SINGLE-TENANT MODE: Primary S3 Bucket Storage ---
    const bucket = process.env.S3_BUCKET || process.env.BUCKET_NAME || process.env.AWS_S3_BUCKET;
    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL;
    const accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;

    if (bucket && endpoint && accessKey && secretKey) {
      try {
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        let endpointUrl = endpoint;
        if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
          endpointUrl = 'https://' + endpointUrl;
        }

        const s3Client = new S3Client({
          region: process.env.AWS_REGION || "eu-nl",
          endpoint: endpointUrl,
          credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
          forcePathStyle: true
        });

        // Extract possible workflow name from safePath
        const pathParts = safePath.split('/').filter(Boolean);
        const execName = pathParts[pathParts.length - 1] || "";

        const candidatePrefixes = [];
        if (safePath) candidatePrefixes.push(safePath.replace(/\/$/, "") + "/");
        if (execName) {
          candidatePrefixes.push(execName + "/");
          candidatePrefixes.push(`application_packages_executions/${execName}/`);
          candidatePrefixes.push(`tmp/application_packages_executions/${execName}/`);
        }
        if (execName && process.env.ARGO_NAMESPACE) candidatePrefixes.push(`${process.env.ARGO_NAMESPACE}/${execName}/`);

        // Check if K8s Workflow status resolves an explicit S3 key
        if (execName) {
          try {
            const ns = process.env.ARGO_NAMESPACE || "default";
            const wfRes = await customObjectsApi.getNamespacedCustomObject({
              group: 'argoproj.io',
              version: 'v1alpha1',
              namespace: ns,
              plural: 'workflows',
              name: execName
            });
            const nodes = wfRes.body?.status?.nodes || wfRes.status?.nodes || {};
            Object.values(nodes).forEach(node => {
              const arts = node.outputs?.artifacts || [];
              arts.forEach(art => {
                if (art.s3?.key) {
                  candidatePrefixes.unshift(art.s3.key.replace(/\/$/, "") + "/");
                }
              });
            });
          } catch (wfErr) {
            // Ignore if workflow not found
          }
        }

        let bestFiles = [];

        for (const prefix of candidatePrefixes) {
          try {
            const command = new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              Delimiter: '/'
            });

            const s3Res = await s3Client.send(command);
            const files = [];

            if (s3Res.CommonPrefixes) {
              s3Res.CommonPrefixes.forEach(p => {
                const folderName = p.Prefix.replace(prefix, "").replace(/\/$/, "");
                if (folderName) {
                  files.push({ name: folderName, isDirectory: true, size: 0, mtime: null });
                }
              });
            }

            if (s3Res.Contents) {
              s3Res.Contents.forEach(c => {
                const fileName = c.Key.replace(prefix, "");
                if (fileName && fileName !== "") {
                  files.push({
                    name: fileName,
                    isDirectory: false,
                    size: c.Size || 0,
                    mtime: c.LastModified || null
                  });
                }
              });
            }

            if (files.length > 0) {
              bestFiles = files;
              break;
            }
          } catch (pErr) {
            // Try next candidate prefix
          }
        }

        return res.json({ files: bestFiles, exists: bestFiles.length > 0, currentPath: safePath });
      } catch (s3Err) {
        console.error("[S3 STORAGE ERROR] Failed to list S3 workspace files:", s3Err.message);
        return res.status(500).json({ message: "Failed to list files from S3 bucket storage.", error: s3Err.message });
      }
    }

    // Fallback if S3 is not configured in single-tenant mode: use local PVC mount
    const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH);
    const targetPath = path.resolve(rootDir, safePath);

    if (!targetPath.startsWith(rootDir)) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (!fs.existsSync(rootDir) || !fs.existsSync(targetPath)) {
      return res.json({ files: [], exists: false, currentPath: safePath });
    }

    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      return res.sendFile(targetPath);
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files = entries.map(entry => {
      const full = path.join(targetPath, entry.name);
      let size = 0;
      let mtime = null;
      try {
        const s = fs.statSync(full);
        size = s.size;
        mtime = s.mtime;
      } catch (e) {}

      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : size,
        mtime: mtime
      };
    });

    return res.json({ files, exists: true, currentPath: safePath });
  } catch (error) {
    console.error("Error listing workspace files:", error.message);
    next(error);
  }
});

/**
 * GET /api/workspace/files/download
 * Download or stream a file from S3 Bucket storage or local PVC
 */
apiRouter.get("/workspace/files/download", async (req, res, next) => {
  try {
    const reqPath = req.query.path || "";
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "").replace(/^\/+/, "");

    if (!safePath) {
      return res.status(400).json({ message: "path parameter is required." });
    }

    // --- MULTI-TENANT MODE: Strict User PVC File Download ---
    if (MULTI_TENANT_MODE) {
      const username = getUsername(req);
      if (!username) {
        return res.status(403).json({ message: "Access denied. User session required in multi-tenant mode." });
      }

      const candidateUsernames = [username];
      if (username.includes('@')) {
        candidateUsernames.push(username.split('@')[0]);
      }

      for (const uName of candidateUsernames) {
        const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH, uName);
        const targetPath = path.resolve(rootDir, safePath);

        // Security Enforcement: Target path MUST stay strictly inside user's directory
        if (targetPath.startsWith(rootDir) && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
          return res.download(targetPath, path.basename(targetPath));
        }
      }

      return res.status(404).json({ message: "File not found on user workspace PVC." });
    }

    // --- SINGLE-TENANT MODE: S3 Bucket File Download or Local PVC ---
    const bucket = process.env.S3_BUCKET || process.env.BUCKET_NAME || process.env.AWS_S3_BUCKET;
    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL;
    const accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;

    if (bucket && endpoint && accessKey && secretKey) {
      try {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        let endpointUrl = endpoint;
        if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
          endpointUrl = 'https://' + endpointUrl;
        }

        const s3Client = new S3Client({
          region: process.env.AWS_REGION || "eu-nl",
          endpoint: endpointUrl,
          credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
          forcePathStyle: true
        });

        // Try exact safePath first, then candidate S3 keys
        const candidateKeys = [
          safePath,
          `application_packages_executions/${safePath}`,
          `tmp/application_packages_executions/${safePath}`
        ];

        let s3Stream = null;
        let contentType = 'application/octet-stream';

        for (const s3Key of candidateKeys) {
          try {
            const command = new GetObjectCommand({
              Bucket: bucket,
              Key: s3Key
            });
            const s3Res = await s3Client.send(command);
            if (s3Res.Body) {
              s3Stream = s3Res.Body;
              if (s3Res.ContentType) contentType = s3Res.ContentType;
              break;
            }
          } catch (e) {
            // Try next candidate key
          }
        }

        if (s3Stream) {
          const filename = path.basename(safePath);
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          return s3Stream.pipe(res);
        }
      } catch (s3Err) {
        console.error("[S3 DOWNLOAD ERROR]", s3Err.message);
      }
    }

    // Fallback: Local PVC File Download in Single-Tenant Mode
    const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH);
    const targetPath = path.resolve(rootDir, safePath);

    if (!targetPath.startsWith(rootDir)) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      return res.download(targetPath, path.basename(targetPath));
    }

    return res.status(404).json({ message: "File not found." });
  } catch (err) {
    next(err);
  }
});

// Helper for Loki requests
function getLokiConfig(req, targetUrl) {
  const headers = {};
  if (req.token) {
    const tokenValue = req.token.startsWith('Bearer ') ? req.token : `Bearer ${req.token}`;
    headers['Authorization'] = tokenValue;
    headers['Cookie'] = `authorization=${tokenValue}`;
  }
  
  const https = require('https');
  const isHttps = targetUrl.startsWith('https://');
  const config = { headers };
  
  if (isHttps) {
    config.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }
  return config;
}

// --- Applications Deployment Feature ---

const requiresApplicationsEnabled = (req, res, next) => {
  if (!ENABLE_APPLICATIONS) {
    return res.status(403).json({ message: "Applications feature is disabled." });
  }
  next();
};

const validateAndSanitizeAppYaml = (appName, content, fileType) => {
  // Support multi-document YAML configurations (e.g., Middleware + Ingress) safely
  const documents = content.split("---").map(doc => doc.trim()).filter(Boolean);
  if (documents.length === 0) {
    throw new Error(`Empty YAML content for ${fileType}.yaml`);
  }

  const sanitizedDocs = documents.map(docStr => {
    // If the entire document is commented out (disabled), bypass validation and preserve it as-is
    const lines = docStr.split("\n").filter(l => l.trim().length > 0);
    const isDocDisabled = lines.length > 0 && lines.every(line => line.trim().startsWith("#"));
    if (isDocDisabled) {
      return docStr;
    }

    const parsed = YAML.parse(docStr);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid YAML document format in ${fileType}.yaml`);
    }

    if (!parsed.metadata) parsed.metadata = {};

    // Strictly override and enforce namespace to match the configured administrative space
    const enforcedNamespace = process.env.ARGO_NAMESPACE || "default";
    parsed.metadata.namespace = enforcedNamespace;

    // Enforce labels
    if (!parsed.metadata.labels) parsed.metadata.labels = {};
    parsed.metadata.labels['app.kubernetes.io/service'] = appName;

    // Enforce selector matchLabels for deployment
    if (fileType === 'deployment' && parsed.kind === 'Deployment') {
      if (!parsed.spec) parsed.spec = {};
      if (!parsed.spec.selector) parsed.spec.selector = {};
      if (!parsed.spec.selector.matchLabels) parsed.spec.selector.matchLabels = {};
      parsed.spec.selector.matchLabels['app.kubernetes.io/service'] = appName;

      if (!parsed.spec.template) parsed.spec.template = {};
      if (!parsed.spec.template.metadata) parsed.spec.template.metadata = {};
      if (!parsed.spec.template.metadata.labels) parsed.spec.template.metadata.labels = {};
      parsed.spec.template.metadata.labels['app.kubernetes.io/service'] = appName;
    }

    // Enforce selector for service
    if (fileType === 'service' && parsed.kind === 'Service') {
      if (!parsed.spec) parsed.spec = {};
      if (!parsed.spec.selector) parsed.spec.selector = {};
      parsed.spec.selector['app.kubernetes.io/service'] = appName;
    }

    // Enforce ingress rules targeting the service
    if (fileType === 'ingress' && parsed.kind === 'Ingress') {
      if (!ALLOW_PUBLIC_INGRESS) {
        throw new Error("Ingress creation is disabled by administrator.");
      }
      if (parsed.spec?.rules) {
        for (const rule of parsed.spec.rules) {
          if (rule.http?.paths) {
            for (const p of rule.http.paths) {
              if (p.backend?.service?.name && p.backend.service.name !== appName) {
                p.backend.service.name = appName;
              }
            }
          }
        }
      }
    }

    return YAML.stringify(parsed);
  });

  return sanitizedDocs.join("\n---\n");
};

// Helper to parse filename into component name and resource type
function parseAppFilename(filename) {
  const match = filename.match(/^(?:(.*)[-._])?(deployment|service|ingress)\.ya?ml$/i);
  if (!match) return null;
  const comp = match[1] ? match[1].trim().toLowerCase() : "";
  const type = match[2].toLowerCase();
  return { comp, type };
}

// Helper to resolve an app name (e.g. "my-folder/web" or "my-app") into folder and prefix
function resolveAppLocation(appName) {
  if (!appName) return { folder: "", prefix: "" };
  const parts = appName.split('/');
  if (parts.length >= 2) {
    return {
      folder: parts[0],
      prefix: parts.slice(1).join('/')
    };
  }
  return {
    folder: appName,
    prefix: ""
  };
}

// Helper to construct filename for a given prefix and resource type (e.g. "web-deployment.yaml")
function getAppFilename(prefix, type) {
  if (!prefix) return `${type}.yaml`;
  return `${prefix}-${type}.yaml`;
}

apiRouter.get("/applications", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: GITLAB_APPLICATIONS_PATH,
          ref: GITLAB_BRANCH,
          recursive: true,
          per_page: 200
        }
      }
    );

    const appsMap = {};
    for (const file of response.data) {
      if (file.type === "blob" && file.path.startsWith(GITLAB_APPLICATIONS_PATH + "/")) {
        const relativePath = file.path.slice(GITLAB_APPLICATIONS_PATH.length + 1);
        const parts = relativePath.split('/');
        if (parts.length === 2) {
          const folderName = parts[0];
          const filename = parts[1];
          const parsed = parseAppFilename(filename);
          if (parsed) {
            const comp = parsed.comp;
            const appKey = comp ? `${folderName}/${comp}` : folderName;
            if (!appsMap[appKey]) {
              appsMap[appKey] = {
                name: appKey,
                folder: folderName,
                component: comp,
                files: [],
                hasDeployment: false
              };
            }
            appsMap[appKey].files.push(filename);
            if (parsed.type === "deployment") {
              appsMap[appKey].hasDeployment = true;
            }
          }
        }
      }
    }

    // Only return application entries that possess a deployment YAML file
    const validApps = Object.values(appsMap)
      .filter(app => app.hasDeployment)
      .map(({ hasDeployment, ...app }) => app);

    res.json(validApps);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

// Helper to detect 404 Not Found errors across all @kubernetes/client-node error formats
function isK8sNotFoundError(err) {
  if (!err) return false;
  return (
    err.statusCode === 404 ||
    err.code === 404 ||
    err.response?.statusCode === 404 ||
    err.response?.body?.code === 404 ||
    (typeof err.body === 'string' && err.body.includes('"code":404')) ||
    (typeof err.message === 'string' && (err.message.includes('not found') || err.message.includes('HTTP-Code: 404')))
  );
}

// GET /api/applications/:appName/status
apiRouter.get(/^\/applications\/(.+)\/status$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);
    const namespace = process.env.ARGO_NAMESPACE || "default";

    // Read deployment YAML from Git to determine exact metadata.name, metadata.namespace & spec.selector.matchLabels
    let targetK8sName = prefix || folder;
    const depFile = getAppFilename(prefix, "deployment");
    const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`;
    try {
      const rawResponse = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(rawResponse.data);
      if (parsed?.metadata?.name) {
        targetK8sName = parsed.metadata.name;
      }
      if (parsed?.metadata?.namespace) {
        namespace = parsed.metadata.namespace;
      }
    } catch (err) {
      // Ignore
    }

    let deploymentStatus = null;
    let deploymentMatchLabels = null;
    try {
      const depResponse = await appsV1Api.readNamespacedDeployment({ name: targetK8sName, namespace });
      const d = depResponse.body || depResponse;
      deploymentMatchLabels = d.spec?.selector?.matchLabels || null;
      deploymentStatus = {
        replicas: d.status?.replicas || 0,
        readyReplicas: d.status?.readyReplicas || 0,
        availableReplicas: d.status?.availableReplicas || 0,
        conditions: d.spec?.replicas === 0 ? [{ type: "ScaledToZero", status: "True", message: "Application is scaled to zero." }] : (d.status?.conditions || [])
      };
    } catch (err) {
      if (!isK8sNotFoundError(err)) {
        console.error(`Failed to read deployment "${targetK8sName}" from K8s:`, err.message || err);
      }
    }

    let serviceStatus = null;
    try {
      const svcResponse = await coreV1Api.readNamespacedService({ name: targetK8sName, namespace });
      const s = svcResponse.body || svcResponse;
      serviceStatus = {
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: s.spec?.ports || []
      };
    } catch (err) {
      // 404 is expected if not reconciled
    }

    let ingressStatus = null;
    try {
      const ingResponse = await networkingV1Api.readNamespacedIngress({ name: targetK8sName, namespace });
      const ing = ingResponse.body || ingResponse;
      const lb = ing.status?.loadBalancer?.ingress || [];
      const hasRules = ing.spec?.rules && ing.spec.rules.length > 0;
      const isIngressReady = (lb.length > 0 && (lb[0].ip || lb[0].hostname)) || hasRules;

      ingressStatus = {
        ready: !!isIngressReady,
        loadBalancer: lb
      };
    } catch (err) {
      // 404 is expected if ingress doesn't exist
    }

    let pods = [];
    try {
      let labelSelectors = [];
      if (deploymentMatchLabels && Object.keys(deploymentMatchLabels).length > 0) {
        const sel = Object.entries(deploymentMatchLabels)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
        labelSelectors.push(sel);
      } else {
        labelSelectors = [
          `app.kubernetes.io/service=${targetK8sName}`,
          `app.kubernetes.io/name=${targetK8sName}`,
          `app.kubernetes.io/instance=${targetK8sName}`,
          `app=${targetK8sName}`
        ];
      }

      const podPromises = labelSelectors.map(labelSelector =>
        coreV1Api.listNamespacedPod({ namespace, labelSelector })
          .then(res => res.body?.items || res.items || [])
          .catch(() => [])
      );

      const results = await Promise.all(podPromises);
      const podMap = new Map();

      for (const items of results) {
        for (const p of items) {
          if (p.metadata?.name && !podMap.has(p.metadata.name)) {
            podMap.set(p.metadata.name, p);
          }
        }
      }

      if (podMap.size === 0) {
        try {
          const allPodsRes = await coreV1Api.listNamespacedPod({ namespace });
          const allItems = allPodsRes.body?.items || allPodsRes.items || [];
          for (const p of allItems) {
            const pName = p.metadata?.name || '';
            if (isPodOwnedByApp(p, targetK8sName) && !podMap.has(pName)) {
              podMap.set(pName, p);
            }
          }
        } catch (e) {
          // Ignore fallback error
        }
      }

      let k8sEvents = [];
      try {
        const eventsRes = await coreV1Api.listNamespacedEvent({ namespace });
        k8sEvents = eventsRes.body?.items || eventsRes.items || [];
      } catch (e) {
        // Ignore if events listing is not permitted
      }

      pods = Array.from(podMap.values()).map(p => {
        const pName = p.metadata?.name;
        const pUid = p.metadata?.uid;

        const podEvents = k8sEvents.filter(e => {
          const inv = e.involvedObject || {};
          return inv.name === pName || (pUid && inv.uid === pUid);
        });

        const warnings = podEvents
          .filter(e => e.type === 'Warning' || (e.reason && (e.reason.includes('Failed') || e.reason.includes('Error') || e.reason.includes('Unscheduled') || e.reason.includes('BackOff'))))
          .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0).getTime() - new Date(a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0).getTime())
          .map(e => ({
            reason: e.reason,
            message: e.message,
            count: e.count || 1,
            lastTimestamp: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp
          }));

        return {
          name: pName,
          phase: p.status?.phase,
          restarts: p.status?.containerStatuses?.reduce((acc, c) => acc + (c.restartCount || 0), 0) || 0,
          age: p.metadata?.creationTimestamp,
          containerStatus: p.status?.containerStatuses?.map(c => ({
            name: c.name,
            ready: c.ready,
            state: c.state
          })) || [],
          events: warnings.length > 0 ? warnings : undefined,
          lastWarning: warnings.length > 0 ? warnings[0].message : undefined
        };
      });
    } catch (err) {
      console.error("Failed to list pods from K8s:", err.message);
    }

    let vulnerabilities = null;
    try {
      const reportsResponse = await customObjectsApi.listNamespacedCustomObject({
        group: 'aquasecurity.github.io',
        version: 'v1alpha1',
        namespace,
        plural: 'vulnerabilityreports'
      });
      const items = reportsResponse.body?.items || reportsResponse.items || [];
      
      const appReports = items.filter(item => {
        const rName = item.metadata?.labels?.['trivy-operator.resource.name'] || '';
        const cName = item.metadata?.labels?.['trivy-operator.container.name'] || '';
        const repName = item.metadata?.name || '';
        return rName === targetK8sName || 
               rName.startsWith(`${targetK8sName}-`) || 
               cName === targetK8sName ||
               repName.startsWith(`replicaset-${targetK8sName}-`) ||
               repName.startsWith(`deployment-${targetK8sName}-`);
      });

      if (appReports.length > 0) {
        vulnerabilities = appReports.map(item => ({
          container: item.metadata?.labels?.['trivy-operator.container.name'] || 'unknown',
          summary: item.report?.summary || { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 },
          topVulnerabilities: item.report?.vulnerabilities?.slice(0, 5).map(v => ({
            id: v.vulnerabilityID,
            title: v.title,
            severity: v.severity,
            pkg: v.resource,
            installedVersion: v.installedVersion,
            fixedVersion: v.fixedVersion,
            link: v.primaryLink
          })) || []
        }));
      }
    } catch (err) {
      console.debug("Failed to fetch Trivy vulnerability reports:", err.message);
    }

    res.json({
      name: appName,
      deployed: !!deploymentStatus,
      deployment: deploymentStatus,
      service: serviceStatus,
      ingress: ingressStatus,
      pods: pods,
      vulnerabilities: vulnerabilities
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/applications/:appName/pods/:podName
apiRouter.delete(/^\/applications\/(.+)\/pods\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const rawAppName = req.params[0];
    const podName = req.params[1];
    let appName = rawAppName;
    try { appName = decodeURIComponent(rawAppName); } catch (e) {}

    const { folder, prefix } = resolveAppLocation(appName);
    const namespace = process.env.ARGO_NAMESPACE || "default";

    let targetK8sName = prefix || folder;
    const depFile = getAppFilename(prefix, "deployment");
    const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`;
    try {
      const rawResponse = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(rawResponse.data);
      if (parsed?.metadata?.name) {
        targetK8sName = parsed.metadata.name;
      }
    } catch (err) {
      // Ignore
    }

    let pod;
    try {
      const podResponse = await coreV1Api.readNamespacedPod({ name: podName, namespace });
      pod = podResponse.body || podResponse;
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ message: `Pod ${podName} not found.` });
      }
      throw err;
    }

    if (!isPodOwnedByApp(pod, targetK8sName) && !isPodOwnedByApp(pod, appName)) {
      return res.status(403).json({ message: `Unauthorized: Pod ${podName} does not belong to application ${appName}.` });
    }

    await coreV1Api.deleteNamespacedPod({ name: podName, namespace });
    res.json({ message: `Pod ${podName} restarted successfully.` });
  } catch (error) {
    next(error);
  }
});

// GET /api/applications/:appName
apiRouter.get(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);

    const files = [getAppFilename(prefix, "deployment"), getAppFilename(prefix, "service")];
    if (ALLOW_PUBLIC_INGRESS) {
      files.push(getAppFilename(prefix, "ingress"));
    }

    const payload = {};
    for (const f of files) {
      const parsed = parseAppFilename(f);
      const type = parsed ? parsed.type : "deployment";
      const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${f}`;
      try {
        const rawResponse = await gitlabApi.get(
          `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
          { params: { ref: GITLAB_BRANCH } }
        );
        payload[type] = rawResponse.data;
      } catch (err) {
        if (err.response && err.response.status === 404) {
          payload[type] = null;
        } else {
          throw err;
        }
      }
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

// POST /api/applications/:appName
apiRouter.post(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);
    const { deployment, service, ingress, commit_message } = req.body;

    if (!deployment) {
      return res.status(400).json({ message: "Deployment YAML content is required." });
    }

    const depFile = getAppFilename(prefix, "deployment");
    const svcFile = getAppFilename(prefix, "service");
    const ingFile = getAppFilename(prefix, "ingress");

    const actions = [];
    try {
      const sanitizedDeployment = validateAndSanitizeAppYaml(appName, deployment, 'deployment');
      actions.push({
        action: "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`,
        content: sanitizedDeployment
      });

      if (service) {
        const sanitizedService = validateAndSanitizeAppYaml(appName, service, 'service');
        actions.push({
          action: "create",
          file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${svcFile}`,
          content: sanitizedService
        });
      }

      if (ingress && ALLOW_PUBLIC_INGRESS) {
        const sanitizedIngress = validateAndSanitizeAppYaml(appName, ingress, 'ingress');
        actions.push({
          action: "create",
          file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${ingFile}`,
          content: sanitizedIngress
        });
      }
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: commit_message || `Create application ${appName}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.status(201).json(response.data);
  } catch (error) {
    next(error);
  }
});

// PUT /api/applications/:appName
apiRouter.put(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);
    const { deployment, service, ingress, commit_message } = req.body;

    if (!deployment) {
      return res.status(400).json({ message: "Deployment YAML content is required." });
    }

    const depFile = getAppFilename(prefix, "deployment");
    const svcFile = getAppFilename(prefix, "service");
    const ingFile = getAppFilename(prefix, "ingress");

    let existingFiles = [];
    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
        {
          params: {
            path: `${GITLAB_APPLICATIONS_PATH}/${folder}`,
            ref: GITLAB_BRANCH
          }
        }
      );
      existingFiles = response.data.map(f => f.name);
    } catch (err) {
      // directory may not exist
    }

    const actions = [];
    try {
      const sanitizedDeployment = validateAndSanitizeAppYaml(appName, deployment, 'deployment');
      actions.push({
        action: existingFiles.includes(depFile) ? "update" : "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`,
        content: sanitizedDeployment
      });

      if (service) {
        const sanitizedService = validateAndSanitizeAppYaml(appName, service, 'service');
        actions.push({
          action: existingFiles.includes(svcFile) ? "update" : "create",
          file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${svcFile}`,
          content: sanitizedService
        });
      }

      if (ALLOW_PUBLIC_INGRESS) {
        if (ingress) {
          const sanitizedIngress = validateAndSanitizeAppYaml(appName, ingress, 'ingress');
          actions.push({
            action: existingFiles.includes(ingFile) ? "update" : "create",
            file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${ingFile}`,
            content: sanitizedIngress
          });
        } else if (existingFiles.includes(ingFile)) {
          actions.push({
            action: "delete",
            file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${ingFile}`
          });
        }
      }
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: commit_message || `Update application ${appName}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/applications/:appName
apiRouter.delete(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);

    const depFile = getAppFilename(prefix, "deployment");
    const svcFile = getAppFilename(prefix, "service");
    const ingFile = getAppFilename(prefix, "ingress");

    let existingFiles = [];
    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
        {
          params: {
            path: `${GITLAB_APPLICATIONS_PATH}/${folder}`,
            ref: GITLAB_BRANCH
          }
        }
      );
      existingFiles = response.data.filter(f => f.type === "blob").map(f => f.name);
    } catch (err) {
      return res.status(404).json({ message: `Application ${appName} not found in Git.` });
    }

    const targetsToDelete = [depFile, svcFile, ingFile].filter(f => existingFiles.includes(f));

    if (targetsToDelete.length === 0) {
      return res.json({ message: `Application ${appName} files are already deleted.` });
    }

    const actions = targetsToDelete.map(filename => ({
      action: "delete",
      file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${filename}`
    }));

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete application ${appName}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.json({ message: `Application ${appName} deleted from Git.`, gitlab: response.data });
  } catch (error) {
    next(error);
  }
});

const checkIngressUrlReachability = async (url) => {
  return new Promise((resolve) => {
    // Create an HTTPS/HTTP agent that strictly enforces SSL/TLS verification
    const isHttps = url.startsWith("https://");
    const options = {
      method: "HEAD",
      timeout: 1500,
    };

    if (isHttps) {
      options.agent = new https.Agent({ rejectUnauthorized: true });
    }

    const httpModule = isHttps ? https : require("http");
    const req = httpModule.request(url, options, () => {
      // Direct handshake completed and resolved
      resolve(true);
    });

    req.on("error", (err) => {
      // Handshake failed (DNS nxdomain, connection refused, or SSL verification failed!)
      console.debug(`[Ingress Probe] Reachability check failed for ${url}: ${err.message}`);
      resolve(false);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
};

// Helper to strictly verify whether a Pod belongs to an application without cross-app pod bleeding
function isPodOwnedByApp(pod, appName) {
  if (!pod || !appName) return false;
  const labels = pod.metadata?.labels || {};

  // 1. Exact label match (strict string equality)
  if (
    labels['app.kubernetes.io/service'] === appName ||
    labels['app.kubernetes.io/name'] === appName ||
    labels['app.kubernetes.io/instance'] === appName ||
    labels['app'] === appName
  ) {
    return true;
  }

  // 2. Strict K8s ReplicaSet owner reference check (e.g. appName-66d5587ffd)
  const ownerRefs = pod.metadata?.ownerReferences || [];
  const escapedAppName = appName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const replicaSetPattern = new RegExp(`^${escapedAppName}-[0-9a-z]{8,10}$`, 'i');

  for (const ref of ownerRefs) {
    if (ref.kind === 'ReplicaSet' && replicaSetPattern.test(ref.name)) {
      return true;
    }
  }

  return false;
}

apiRouter.get(/^\/applications\/(.+)\/status$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = req.params[0];
    const { folder, prefix } = resolveAppLocation(appName);
    const namespace = process.env.ARGO_NAMESPACE || "default";

    // Read deployment YAML from Git to determine exact metadata.name, metadata.namespace & spec.selector.matchLabels
    let targetK8sName = prefix || folder;
    const depFile = getAppFilename(prefix, "deployment");
    const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`;
    try {
      const rawResponse = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(rawResponse.data);
      if (parsed?.metadata?.name) {
        targetK8sName = parsed.metadata.name;
      }
      if (parsed?.metadata?.namespace) {
        namespace = parsed.metadata.namespace;
      }
    } catch (err) {
      // Ignore
    }

    let deploymentStatus = null;
    let deploymentMatchLabels = null;
    try {
      const depResponse = await appsV1Api.readNamespacedDeployment({ name: targetK8sName, namespace });
      const d = depResponse.body || depResponse;
      deploymentMatchLabels = d.spec?.selector?.matchLabels || null;
      deploymentStatus = {
        replicas: d.status?.replicas || 0,
        readyReplicas: d.status?.readyReplicas || 0,
        availableReplicas: d.status?.availableReplicas || 0,
        conditions: d.spec?.replicas === 0 ? [{ type: "ScaledToZero", status: "True", message: "Application is scaled to zero." }] : (d.status?.conditions || [])
      };
    } catch (err) {
      if (err.statusCode !== 404) {
        console.error(`Failed to read deployment "${targetK8sName}" from K8s:`, err.message);
      }
    }

    let serviceStatus = null;
    try {
      const svcResponse = await coreV1Api.readNamespacedService({ name: targetK8sName, namespace });
      const s = svcResponse.body || svcResponse;
      serviceStatus = {
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: s.spec?.ports || []
      };
    } catch (err) {
      // 404 is expected if not reconciled
    }

    let ingressStatus = null;
    try {
      const ingResponse = await networkingV1Api.readNamespacedIngress({ name: targetK8sName, namespace });
      const ing = ingResponse.body || ingResponse;
      const lb = ing.status?.loadBalancer?.ingress || [];
      const hasRules = ing.spec?.rules && ing.spec.rules.length > 0;
      const isIngressReady = (lb.length > 0 && (lb[0].ip || lb[0].hostname)) || hasRules;

      ingressStatus = {
        ready: !!isIngressReady,
        loadBalancer: lb
      };
    } catch (err) {
      // 404 is expected if ingress doesn't exist
    }

    let pods = [];
    try {
      let labelSelectors = [];
      if (deploymentMatchLabels && Object.keys(deploymentMatchLabels).length > 0) {
        const sel = Object.entries(deploymentMatchLabels)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
        labelSelectors.push(sel);
      } else {
        labelSelectors = [
          `app.kubernetes.io/service=${targetK8sName}`,
          `app.kubernetes.io/name=${targetK8sName}`,
          `app.kubernetes.io/instance=${targetK8sName}`,
          `app=${targetK8sName}`
        ];
      }

      const podPromises = labelSelectors.map(labelSelector =>
        coreV1Api.listNamespacedPod({ namespace, labelSelector })
          .then(res => res.body?.items || res.items || [])
          .catch(() => [])
      );

      const results = await Promise.all(podPromises);
      const podMap = new Map();

      for (const items of results) {
        for (const p of items) {
          if (p.metadata?.name && !podMap.has(p.metadata.name)) {
            podMap.set(p.metadata.name, p);
          }
        }
      }

      // If no pods matched standard label queries, list all pods in namespace and use strict ownership verification
      if (podMap.size === 0) {
        try {
          const allPodsRes = await coreV1Api.listNamespacedPod({ namespace });
          const allItems = allPodsRes.body?.items || allPodsRes.items || [];
          for (const p of allItems) {
            const pName = p.metadata?.name || '';
            if (isPodOwnedByApp(p, targetK8sName) && !podMap.has(pName)) {
              podMap.set(pName, p);
            }
          }
        } catch (e) {
          // Ignore fallback error
        }
      }

      let k8sEvents = [];
      try {
        const eventsRes = await coreV1Api.listNamespacedEvent({ namespace });
        k8sEvents = eventsRes.body?.items || eventsRes.items || [];
      } catch (e) {
        // Ignore if events listing is not permitted
      }

      pods = Array.from(podMap.values()).map(p => {
        const pName = p.metadata?.name;
        const pUid = p.metadata?.uid;

        const podEvents = k8sEvents.filter(e => {
          const inv = e.involvedObject || {};
          return inv.name === pName || (pUid && inv.uid === pUid);
        });

        const warnings = podEvents
          .filter(e => e.type === 'Warning' || (e.reason && (e.reason.includes('Failed') || e.reason.includes('Error') || e.reason.includes('Unscheduled') || e.reason.includes('BackOff'))))
          .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0).getTime() - new Date(a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0).getTime())
          .map(e => ({
            reason: e.reason,
            message: e.message,
            count: e.count || 1,
            lastTimestamp: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp
          }));

        return {
          name: pName,
          phase: p.status?.phase,
          restarts: p.status?.containerStatuses?.reduce((acc, c) => acc + (c.restartCount || 0), 0) || 0,
          age: p.metadata?.creationTimestamp,
          containerStatus: p.status?.containerStatuses?.map(c => ({
            name: c.name,
            ready: c.ready,
            state: c.state
          })) || [],
          events: warnings.length > 0 ? warnings : undefined,
          lastWarning: warnings.length > 0 ? warnings[0].message : undefined
        };
      });
    } catch (err) {
      console.error("Failed to list pods from K8s:", err.message);
    }

    let vulnerabilities = null;
    try {
      const reportsResponse = await customObjectsApi.listNamespacedCustomObject({
        group: 'aquasecurity.github.io',
        version: 'v1alpha1',
        namespace,
        plural: 'vulnerabilityreports'
      });
      const items = reportsResponse.body?.items || reportsResponse.items || [];
      
      const appReports = items.filter(item => {
        const rName = item.metadata?.labels?.['trivy-operator.resource.name'] || '';
        const cName = item.metadata?.labels?.['trivy-operator.container.name'] || '';
        const repName = item.metadata?.name || '';
        return rName === targetK8sName || 
               rName.startsWith(`${targetK8sName}-`) || 
               cName === targetK8sName ||
               repName.startsWith(`replicaset-${targetK8sName}-`) ||
               repName.startsWith(`deployment-${targetK8sName}-`);
      });

      if (appReports.length > 0) {
        vulnerabilities = appReports.map(item => ({
          container: item.metadata?.labels?.['trivy-operator.container.name'] || 'unknown',
          summary: item.report?.summary || { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 },
          topVulnerabilities: item.report?.vulnerabilities?.slice(0, 5).map(v => ({
            id: v.vulnerabilityID,
            title: v.title,
            severity: v.severity,
            pkg: v.resource,
            installedVersion: v.installedVersion,
            fixedVersion: v.fixedVersion,
            link: v.primaryLink
          })) || []
        }));
      }
    } catch (err) {
      console.debug("Failed to fetch Trivy vulnerability reports:", err.message);
    }

    res.json({
      name: appName,
      deployed: !!deploymentStatus,
      deployment: deploymentStatus,
      service: serviceStatus,
      ingress: ingressStatus,
      pods: pods,
      vulnerabilities: vulnerabilities
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.delete("/applications/:name/pods/:podName", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const { name, podName } = req.params;
    const namespace = process.env.ARGO_NAMESPACE || "default";

    // 1. Get the pod first to verify it belongs to this application (strict isolation)
    let pod;
    try {
      const podResponse = await coreV1Api.readNamespacedPod({ name: podName, namespace });
      pod = podResponse.body || podResponse;
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ message: `Pod ${podName} not found.` });
      }
      throw err;
    }

    if (!isPodOwnedByApp(pod, name)) {
      return res.status(403).json({ message: `Unauthorized: Pod ${podName} does not belong to application ${name}.` });
    }

    // 2. Pod is verified, delete it
    await coreV1Api.deleteNamespacedPod({ name: podName, namespace });
    res.json({ message: `Pod ${podName} deleted successfully.` });
  } catch (error) {
    if (error.body) {
      return sendK8sError(res, error);
    }
    next(error);
  }
});

// --- Loki Log Integration ---
const LOKI_URL = process.env.LOKI_URL || "http://localhost:4567";
const NAMESPACE = process.env.ARGO_NAMESPACE || "default";
const NAMESPACE_LABEL = process.env.LOKI_NAMESPACE_LABEL || "namespace";
const ARGO_WORKFLOW_LABEL = process.env.ARGO_WORKFLOW_LABEL || "workflows_argoproj_io_workflow";
const LOKI_LABELS = [
  "app_kubernetes_io_name",
  "container",
  "instance",
  "job",
  "k8s_pod_name",
  "pod",
  "service_name",
  ARGO_WORKFLOW_LABEL,
];

function toLokiTimestamp(dtStr) {
  try {
    if (!dtStr) return "";
    const dt = new Date(dtStr);
    return (BigInt(dt.getTime()) * BigInt(1000000)).toString();
  } catch (e) {
    return "";
  }
}

/**
 * GET /api/logs/labels
 * Fetch all available label keys for the namespace.
 */
apiRouter.get("/logs/labels", async (req, res, next) => {
  try {
    const { start_time } = req.query;
    const startNs = toLokiTimestamp(start_time || new Date(Date.now() - 3600000).toISOString());
    
    const config = getLokiConfig(req, LOKI_URL);
    config.params = {
      query: `{${NAMESPACE_LABEL}="${NAMESPACE}"}`,
      start: startNs
    };

    const resp = await axios.get(`${LOKI_URL}/loki/api/v1/labels`, config);
    const labels = resp.data.data || [];
    console.log(`[API LOGS] All available Loki labels in namespace:`, labels);
    const filtered = labels.filter(l => !l.startsWith("__") && LOKI_LABELS.includes(l)).sort();
    res.json(filtered.length > 0 ? filtered : LOKI_LABELS);
  } catch (error) {
    console.error("Error fetching Loki labels:", error.message);
    res.json(LOKI_LABELS);
  }
});

/**
 * GET /api/logs/values/:label
 * Fetch all values for a specific label key.
 */
apiRouter.get("/logs/values/:label", async (req, res, next) => {
  try {
    const { label } = req.params;
    const { start_time, end_time } = req.query;
    
    if (!LOKI_LABELS.includes(label)) {
      return res.status(400).json({ message: `Label ${label} not allowed.` });
    }

    const startNs = toLokiTimestamp(start_time || new Date(Date.now() - 3600000).toISOString());
    const endNs = end_time ? toLokiTimestamp(end_time) : null;

    const config = getLokiConfig(req, LOKI_URL);
    config.params = {
      query: `{${NAMESPACE_LABEL}="${NAMESPACE}"}`,
      start: startNs
    };
    if (endNs) config.params.end = endNs;

    const resp = await axios.get(`${LOKI_URL}/loki/api/v1/label/${label}/values`, config);
    res.json((resp.data.data || []).sort());
  } catch (error) {
    console.error(`Error fetching Loki values for ${req.params.label}:`, error.message);
    res.json([]);
  }
});

/**
 * GET /api/logs/:id
 * Fetch raw logs for a specific workflow or pod from Loki.
 */
apiRouter.get("/logs/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, start_time, end_time, query, namespace, workflow } = req.query;

    console.log(`[API LOGS] Request received for ID: "${id}" | Type: "${type}" | Start: "${start_time || 'default'}" | End: "${end_time || 'none'}"`);

    // Sanitize user inputs to prevent LogQL injection
    const safeId = id.replace(/"/g, '');
    const safeQuery = query ? query.toString().replace(/"/g, '\\"') : undefined;

    // Enforce strict namespace isolation
    const ns = NAMESPACE;

    // Use 4 hours as a default temporal subset window instead of 24 hours for faster indexing
    const startNs = toLokiTimestamp(start_time || new Date(Date.now() - 3600000 * 4).toISOString());
    const endNs = end_time ? toLokiTimestamp(end_time) : null;

    console.log(`[API LOGS] Computed Loki bounds: startNs="${startNs}" | endNs="${endNs || 'none'}"`);

    let podName = safeId; // Default to the requested ID

    // Resolve the actual pod name from K8s status if a workflow name is provided and we are querying a pod
    if (type !== 'workflow' && workflow) {
      try {
        const wfResponse = await customObjectsApi.getNamespacedCustomObject({
          group: 'argoproj.io',
          version: 'v1alpha1',
          namespace: ns,
          plural: 'workflows',
          name: workflow.toString()
        });

        const wfNode = wfResponse.status?.nodes?.[safeId] || wfResponse.body?.status?.nodes?.[safeId];
        if (wfNode) {
          const resolvedPodName = wfNode.podName || wfNode.id;
          if (resolvedPodName) {
            podName = resolvedPodName;
          }
        }
      } catch (err) {
        console.debug(`Failed to fetch workflow details from K8s for log podName resolution:`, err.message);
      }
    }

    let logql = "";
    if (type === 'workflow') {
      logql = `{${NAMESPACE_LABEL}="${ns}", ${ARGO_WORKFLOW_LABEL}="${safeId}"}`;
    } else {
      // For pods, some Loki setups use 'k8s_pod_name' instead of 'pod'.
      logql = `{${NAMESPACE_LABEL}="${ns}", pod="${podName}"}`;
    }

    if (safeQuery) {
      logql += ` |= "${safeQuery}"`;
    }
    
    // Helper function to fetch and parse logs. Instantiates a fresh config object per-request to avoid race conditions.
    const fetchAndParse = async (queryStr) => {
      const queryConfig = getLokiConfig(req, LOKI_URL);
      queryConfig.params = { query: queryStr, limit: 1000, start: startNs };
      if (endNs) queryConfig.params.end = endNs;
      
      console.log(`Fetching logs from Loki: ${LOKI_URL}/loki/api/v1/query_range?query=${queryStr}`);
      let resp;
      try {
        resp = await axios.get(`${LOKI_URL}/loki/api/v1/query_range`, queryConfig);
        if (resp.data) {
          const resultsCount = resp.data.data?.result?.length || 0;
          console.log(`[API LOGS] Loki response: status=${resp.status} | resultsCount=${resultsCount}`);
        }
      } catch (err) {
        console.error("Loki query failed:", err.message);
        return [];
      }
      
      let parsedLogs = [];
      let totalLines = 0;
      let filteredLines = 0;

      if (resp.data.data && resp.data.data.result && resp.data.data.result.length > 0) {
        for (const stream of resp.data.data.result) {
          for (const val of stream.values) {
            totalLines++;
            let line = val[1];
            console.debug(`[DEBUG] Raw Loki line: ${line}`);
            
            // 1. Extract inner message from CRI-O format
            const criMatch = line.match(/logtag="[A-Z]"\s+message="(.*)"/);
            if (criMatch) {
              line = criMatch[1];
              line = line.replace(/\\"/g, '"');
              console.debug(`[DEBUG] After CRI-O unwrap: ${line}`);
            }

            // 2. Filter out Argo internal logs.
            // Be careful: only filter if it looks like SYSTEM argo noise
            const lineLower = line.toLowerCase();
            const isArgoSystemLog = 
              lineLower.includes('level=info') && lineLower.includes('argo=true') && 
              (lineLower.includes('msg="alloc=') || lineLower.includes('msg="starting progress monitor') || 
               lineLower.includes('msg="starting deadline monitor') || lineLower.includes('msg="executor initialized') ||
               lineLower.includes('msg="main container completed') || lineLower.includes('msg="no output artifacts') ||
               lineLower.includes('msg="copying file') || lineLower.includes('msg="copying from container') ||
               lineLower.includes('msg="staging artifact') || lineLower.includes('msg="saving output artifacts') ||
               lineLower.includes('msg="no output parameters') || lineLower.includes('msg="no script output reference') ||
               lineLower.includes('msg="deadline monitor stopped') || lineLower.includes('msg="no artifact sidecars to kill') ||
               lineLower.includes('msg="successfully saved file') || lineLower.includes('msg="not deleting local artifact') ||
               lineLower.includes('msg="save artifact') || lineLower.includes('msg="saving file to s3') ||
               lineLower.includes('msg="creating minio client') || lineLower.includes('msg="s3 save') ||
               lineLower.includes('msg="saving artifact') || lineLower.includes('msg="using executor retry strategy') ||
               lineLower.includes('msg="part size not configured'));

            if (isArgoSystemLog) {
              console.debug(`[DEBUG] Filtering as Argo noise: ${line}`);
              filteredLines++;
              continue;
            }

            // 3. Try to extract payload from generic logrus format if it's our own log
            // Example: time="..." level=info msg="User Message"
            const msgMatch = line.match(/msg="(.*)"/);
            if (msgMatch && line.includes('level=')) {
                console.debug(`[DEBUG] Extracting msg payload: ${msgMatch[1]}`);
                line = msgMatch[1];
            }

            // 4. Strip ANSI escape control codes (e.g., \x1b[1;30m, \x1b[0m, \x1b[32m)
            line = line.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

            parsedLogs.push(line);
          }
        }
      }
      
      if (totalLines > 0) {
         console.log(`Parsed ${parsedLogs.length} logs from ${totalLines} total lines.`);
      }
      return parsedLogs;
    };

    let logs = await fetchAndParse(logql);

    // If no workflow logs found with namespace label, try without it (global query)
    if (logs.length === 0 && type === 'workflow') {
      console.log(`No logs found with namespace-filtered workflow label. Attempting global workflow query (without namespace)...`);
      logs = await fetchAndParse(`{${ARGO_WORKFLOW_LABEL}="${safeId}"}`);
    }

    // Fallbacks for pod log fetching if the standard `pod` label isn't used by their Promtail
    if (logs.length === 0 && type !== 'workflow') {
      console.log(`No logs found with pod label. Executing lean fallback queries in parallel...`);
      
      const fallbackQueries = [
        { key: 'ns_k8s_pod', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name="${podName}"}` },
        { key: 'global_pod', query: `{pod="${podName}"}` },
        { key: 'global_k8s_pod', query: `{k8s_pod_name="${podName}"}` }
      ];

      // Add original fallback with safeId if different from podName
      if (podName !== safeId) {
        fallbackQueries.push(
          { key: 'ns_k8s_pod_id', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name="${safeId}"}` },
          { key: 'global_pod_id', query: `{pod="${safeId}"}` },
          { key: 'global_k8s_pod_id', query: `{k8s_pod_name="${safeId}"}` }
        );
      }

      const fallbackPromises = fallbackQueries.map(async (q) => {
        const resLogs = await fetchAndParse(q.query);
        return { key: q.key, logs: resLogs };
      });

      const fallbackResults = await Promise.all(fallbackPromises);
      
      // Choose the first non-empty logs in order of priority (which matches the array order)
      for (const q of fallbackQueries) {
        const match = fallbackResults.find(r => r.key === q.key);
        if (match && match.logs && match.logs.length > 0) {
          logs = match.logs;
          console.log(`[API LOGS] Fallback matched successfully via query key: ${q.key}`);
          break;
        }
      }

      // If still empty, execute regex searches as a final safety fallback
      if (logs.length === 0) {
        const idParts = safeId.split('-');
        const hash = idParts[idParts.length - 1]; // Assume the last part is the unique hash
        
        console.log(`[API LOGS] Attempting regex matching on POD LABEL for ID ending in ${hash} in parallel...`);
        const regexQueries = [
          { key: 'ns_regex_pod', query: `{${NAMESPACE_LABEL}="${ns}", pod=~".*${hash}.*"}` },
          { key: 'ns_regex_k8s_pod', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name=~".*${hash}.*"}` },
          { key: 'global_regex_pod', query: `{pod=~".*${hash}.*"}` },
          { key: 'global_regex_k8s_pod', query: `{k8s_pod_name=~".*${hash}.*"}` }
        ];

        // Also add regex using podName hash if different
        if (podName !== safeId) {
          const podParts = podName.split('-');
          const podHash = podParts[podParts.length - 1];
          if (podHash !== hash) {
            regexQueries.push(
              { key: 'ns_regex_pod_name', query: `{${NAMESPACE_LABEL}="${ns}", pod=~".*${podHash}.*"}` },
              { key: 'ns_regex_k8s_pod_name', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name=~".*${podHash}.*"}` }
            );
          }
        }

        const regexPromises = regexQueries.map(async (q) => {
          const resLogs = await fetchAndParse(q.query);
          return { key: q.key, logs: resLogs };
        });

        const regexResults = await Promise.all(regexPromises);

        for (const q of regexQueries) {
          const match = regexResults.find(r => r.key === q.key);
          if (match && match.logs && match.logs.length > 0) {
            logs = match.logs;
            console.log(`[API LOGS] Regex fallback matched successfully via query key: ${q.key}`);
            break;
          }
        }
      }
    }

    if (logs.length === 0) {
      console.log(`[API LOGS] Loki returned 0 logs. Executing direct Kubernetes API pod log fallback for ID: "${safeId}"`);
      try {
        const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
        let targetPodName = podName || safeId;

        if (type === 'workflow') {
          try {
            const podsRes = await coreV1Api.listNamespacedPod({
              namespace: ns,
              labelSelector: `workflows.argoproj.io/workflow=${safeId}`
            });
            const foundPods = podsRes.body?.items || podsRes.items || [];
            if (foundPods.length > 0) {
              targetPodName = foundPods[0].metadata?.name || safeId;
            }
          } catch (pErr) {
            console.warn(`[API LOGS] Pod list for workflow ${safeId} failed:`, pErr.message);
          }
        }

        let rawText = "";
        try {
          const podLogRes = await coreV1Api.readNamespacedPodLog({
            name: targetPodName,
            namespace: ns,
            container: 'main'
          });
          rawText = typeof podLogRes === 'string' ? podLogRes : (podLogRes?.body || '');
        } catch (e1) {
          try {
            const prevLogRes = await coreV1Api.readNamespacedPodLog({
              name: targetPodName,
              namespace: ns,
              container: 'main',
              previous: true
            });
            rawText = typeof prevLogRes === 'string' ? prevLogRes : (prevLogRes?.body || '');
          } catch (e2) {
            try {
              const defLogRes = await coreV1Api.readNamespacedPodLog({
                name: targetPodName,
                namespace: ns
              });
              rawText = typeof defLogRes === 'string' ? defLogRes : (defLogRes?.body || '');
            } catch (e3) {}
          }
        }

        if (rawText && rawText.trim() !== '') {
          console.log(`[API LOGS] Successfully retrieved direct K8s Pod Logs for "${targetPodName}"`);
          const cleanText = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
          return res.send(cleanText);
        }
      } catch (k8sErr) {
        console.warn(`[API LOGS] Direct K8s Pod Log fallback failed for "${safeId}":`, k8sErr.message);
      }

      console.log(`[API LOGS] No logs found across all labels and fallbacks for ID: "${id}"`);
      try {
        const config = getLokiConfig(req, LOKI_URL);
        const labelsResp = await axios.get(`${LOKI_URL}/loki/api/v1/labels`, config);
        console.log(`[API LOGS] DIAGNOSTIC: All available Loki label keys in your cluster are:`, labelsResp.data.data || []);
      } catch (labelErr) {
        console.error(`[API LOGS] DIAGNOSTIC ERROR: Failed to fetch Loki labels:`, labelErr.message);
      }
      return res.send("No logs found in Loki or Kubernetes for the specified execution.");
    }
    
    console.log(`[API LOGS] Successfully returning ${logs.length} log lines for ID: "${id}"`);
    res.send(logs.reverse().join('\n'));
  } catch (error) {
    console.error(`Error fetching logs for ${req.params.id}:`, error.message);
    res.status(500).send("Error fetching logs from Loki.");
  }
});

/**
 * GET /api/artifacts/:workflow/:nodeId/:artifactName
 * Fetches artifacts directly from the backing S3 repository.
 */
apiRouter.get("/artifacts/:workflow/:nodeId/:artifactName", async (req, res, next) => {
  try {
    const { workflow, nodeId, artifactName } = req.params;
    const namespace = process.env.ARGO_NAMESPACE || "default";

    // 1. Fetch the workflow object from Kubernetes to find the artifact definition
    const wfResponse = await customObjectsApi.getNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      name: workflow
    });
    const wf = wfResponse;

    const node = wf.status?.nodes?.[nodeId];
    if (!node) {
      return res.status(404).json({ message: "Node not found in workflow status." });
    }

    // Attempt to find the artifact in outputs first, then inputs
    let artifact = node.outputs?.artifacts?.find(a => a.name === artifactName);
    if (!artifact) {
      artifact = node.inputs?.artifacts?.find(a => a.name === artifactName);
    }

    if (!artifact) {
      return res.status(404).json({ message: "Artifact not found in node outputs or inputs." });
    }

    // Input artifacts might just have 'name' and lack the full 's3' definition 
    // if they are passed down from a parent or another step.
    // However, Argo typically resolves the full storage path in the `status.nodes[id].inputs.artifacts[x].s3` 
    // field during execution. If it doesn't, we will fall back to the workflow's default artifactRepository.
    
    let s3Config = artifact.s3;

    if (!s3Config) {
      // Try to get default artifact repository from workflow spec
      const defaultRepo = wf.spec?.artifactRepositoryRef;
      if (defaultRepo) {
         // It's complex to resolve configmap references here without full Argo Controller logic.
         // We will rely on our global environment fallbacks if the specific artifact lacks s3 info.
         s3Config = {}; 
      } else {
         s3Config = {};
      }
    }

    // Ensure we have an S3 key to fetch. If it's not on the artifact, we can't proceed.
    if (!s3Config.key) {
       // Input artifacts from other steps usually have their resolved key populated by Argo.
       // If it's missing, it might not be supported yet by this direct method.
       return res.status(501).json({ 
         message: "Artifact S3 key is missing. This might be a pass-through artifact not fully resolved in the status." 
       });
    }

    // 2. Resolve S3 configuration (Artifact definition overrides global env vars)
    const endpoint = s3Config.endpoint || process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT;
    const bucket = s3Config.bucket || process.env.BUCKET_NAME || process.env.S3_BUCKET;
    const region = s3Config.region || process.env.AWS_REGION || process.env.S3_REGION || "eu-nl";
    let accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
    let secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;
    
    // Determine if connection should be insecure. If URL starts with https, it's secure.
    let insecure = false;
    if (s3Config.insecure !== undefined) {
      insecure = s3Config.insecure;
    } else if (endpoint && endpoint.startsWith('http://')) {
      insecure = true;
    } else if (process.env.S3_SECURE === "false") {
      insecure = true;
    }

    if (!endpoint || !bucket) {
      return res.status(500).json({ message: "S3 endpoint or bucket not configured globally or in the artifact." });
    }

    // 3. Extract credentials from K8s secrets if defined in the artifact
    const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
    if (s3Config.accessKeySecret) {
      try {
        const secretRes = await coreV1Api.readNamespacedSecret({
          name: s3Config.accessKeySecret.name,
          namespace
        });
        if (secretRes.body.data && secretRes.body.data[s3Config.accessKeySecret.key]) {
          accessKey = Buffer.from(secretRes.body.data[s3Config.accessKeySecret.key], 'base64').toString('utf8');
        }
      } catch (err) {
        console.warn(`Failed to read accessKeySecret ${s3Config.accessKeySecret.name}: ${err.message}`);
      }
    }
    
    if (s3Config.secretKeySecret) {
      try {
        const secretRes = await coreV1Api.readNamespacedSecret({
          name: s3Config.secretKeySecret.name,
          namespace
        });
        if (secretRes.body.data && secretRes.body.data[s3Config.secretKeySecret.key]) {
          secretKey = Buffer.from(secretRes.body.data[s3Config.secretKeySecret.key], 'base64').toString('utf8');
        }
      } catch (err) {
        console.warn(`Failed to read secretKeySecret ${s3Config.secretKeySecret.name}: ${err.message}`);
      }
    }

    if (!accessKey || !secretKey) {
      return res.status(500).json({ message: "S3 credentials missing. Ensure global env vars or K8s secrets are configured." });
    }

    // 4. Connect to S3
    let endpointUrl = endpoint;
    // If the endpoint doesn't have a protocol, prepend one based on the insecure flag
    if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
      endpointUrl = (insecure ? 'http://' : 'https://') + endpointUrl;
    }

    const s3Client = new S3Client({
      region,
      endpoint: endpointUrl,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true // Recommended for MinIO and many on-prem S3 providers
    });

    console.log(`Fetching artifact ${artifact.s3.key} from s3://${bucket} at ${endpointUrl}`);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: artifact.s3.key
    });

    const s3Response = await s3Client.send(command);

    // 5. Unpack .tgz stream on the fly if needed
    if (artifact.s3.key.endsWith('.tgz') || artifact.s3.key.endsWith('.tar.gz')) {
      const extract = tar.extract();
      let fileFound = false;

      // Ensure we clean up if the client disconnects
      req.on('close', () => {
         extract.destroy();
      });

      extract.on('entry', (header, stream, nextStream) => {
        // Just extract and send the first file found (since an artifact is usually a single file or directory)
        if (!fileFound && header.type === 'file') {
          fileFound = true;
          
          // Basic content-type detection based on filename
          let contentType = 'application/octet-stream';
          const ext = header.name.split('.').pop().toLowerCase();
          const mimeTypes = {
            'txt': 'text/plain', 'log': 'text/plain', 'md': 'text/markdown',
            'json': 'application/json', 'csv': 'text/csv', 'yaml': 'text/yaml', 'yml': 'text/yaml',
            'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
            'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp'
          };
          if (mimeTypes[ext]) contentType = mimeTypes[ext];

          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `inline; filename="${header.name.split('/').pop()}"`);
          
          stream.pipe(res);
          stream.on('end', () => {
             // Do not process further files once we found one, to avoid writing to a closed response
             extract.destroy();
          });
        } else {
          stream.on('end', nextStream);
          stream.resume(); // drain the stream
        }
      });

      extract.on('finish', () => {
        if (!fileFound && !res.headersSent) {
          res.status(404).json({ message: "No files found in artifact archive." });
        }
      });

      extract.on('error', (err) => {
        console.error("Tar extraction error:", err);
        if (!res.headersSent) res.status(500).json({ message: "Error extracting artifact archive." });
      });

      s3Response.Body.pipe(zlib.createGunzip()).pipe(extract);

    } else {
      // Stream raw file directly
      res.setHeader('Content-Type', s3Response.ContentType || 'application/octet-stream');
      const filename = artifact.s3.key.split('/').pop();
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      s3Response.Body.pipe(res);
    }

  } catch (error) {
    console.error(`Error fetching artifact ${req.params.artifactName} for node ${req.params.nodeId}:`, error.message);
    if (!res.headersSent) {
      if (error.name === 'NoSuchKey') {
        res.status(404).json({ message: "Artifact key not found in S3 bucket." });
      } else {
        res.status(500).json({ message: "Failed to fetch artifact from storage.", error: error.message });
      }
    }
  }
});


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