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
const PORT = process.env.PORT || 3000;

// Environment variables
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const GITLAB_BRANCH = process.env.GITLAB_BRANCH || 'main';
const GITLAB_WORKFLOWS_PATH = process.env.GITLAB_WORKFLOWS_PATH || '.';
const ENABLE_APPLICATIONS = process.env.ENABLE_APPLICATIONS === 'true';
const GITLAB_APPLICATIONS_PATH = process.env.GITLAB_APPLICATIONS_PATH || 'applications';
const ALLOW_PUBLIC_INGRESS = process.env.ALLOW_PUBLIC_INGRESS === 'true';

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
  middlewareAnnotationValueTemplate: "${namespace}-${middlewareName}@kubernetescrd",
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
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS 
  ? process.env.CORS_ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:8000', 'http://localhost:8080'];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Helper to decode JWT payload without verification (for logging claims only)
function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString();
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
    const cookies = req.headers.cookie.split(';').reduce((acc, cookie) => {
      const [key, value] = cookie.trim().split('=');
      acc[key] = value;
      return acc;
    }, {});
    token = cookies['access_token'] || cookies['id_token'] || cookies['appSession'];
  }

  if (token) {
    req.token = token;
    req.user = decodeJwt(token);
  }
  next();
});

const requiresAuth = (req, res, next) => {
  if (req.user || process.env.NODE_ENV === 'development') {
    return next();
  }
  res.status(401).json({ 
    message: 'Authentication Required',
    loginUrl: `${BASE_PATH}/login` 
  });
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

// Protect all /api routes
apiRouter.use((req, res, next) => {
  // Skip protection for diagnostic endpoint
  if (req.path === "/diag/token") return next();
  requiresAuth(req, res, next);
});

/**
 * GET /api/config
 * Expose relevant configuration and profiles to the frontend.
 */
apiRouter.get("/config", (req, res) => {
  res.json({
    profiles: ARGO_PROFILES,
    availableTolerations: ARGO_AVAILABLE_TOLERATIONS,
    availableNodeSelectors: ARGO_AVAILABLE_NODE_SELECTORS,
    ephemeralVolume: EPHEMERAL_VOLUME_CONFIG,
    allowPublishing: process.env.ALLOW_PUBLISHING === "true",
    enableApplications: ENABLE_APPLICATIONS,
    allowPublicIngress: ALLOW_PUBLIC_INGRESS,
    ingress: ingressClusterConfig,
    logViewerUrl: process.env.LOG_VIEWER_URL || `https://hub-test.eox.at/services/eoxhub-gateway/cif/log-viewer/search`,
    defaults: {
      namespace: process.env.ARGO_NAMESPACE || "default",
      serviceAccount: process.env.ARGO_SERVICE_ACCOUNT || "default"
    }
  });
});

// Helper to convert a frontend virtual path to a physical GitLab path
function getGitLabPath(virtualPath) {
  if (!virtualPath) return "";
  
  // Express 5 path-to-regexp v8 matches wildcards as arrays of string segments
  let pathStr = Array.isArray(virtualPath) ? virtualPath.join('/') : String(virtualPath);

  // Prevent directory traversal
  let cleanVirtualPath = pathStr.replace(/^\//, "").replace(/\.\.\//g, "");
  
  if (!GITLAB_WORKFLOWS_PATH || GITLAB_WORKFLOWS_PATH === ".") {
    return cleanVirtualPath;
  }
  const basePath = GITLAB_WORKFLOWS_PATH.replace(/\/$/, "").replace(/^\//, "");
  return `${basePath}/${cleanVirtualPath}`;
}

// Helper to extract virtual path from req.params under both Express 4 and Express 5, and under both string wildcards and RegExp routes
function getVirtualPath(req) {
  return req.params[0] || (Array.isArray(req.params.path) ? req.params.path.join('/') : String(req.params.path || ''));
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
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: GITLAB_WORKFLOWS_PATH === "." ? "" : GITLAB_WORKFLOWS_PATH,
          ref: GITLAB_BRANCH,
          recursive: true
        }
      }
    );

    const prefix = GITLAB_WORKFLOWS_PATH && GITLAB_WORKFLOWS_PATH !== "." 
      ? `${GITLAB_WORKFLOWS_PATH.replace(/\/$/, "")}/` 
      : "";

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
    const filePath = getGitLabPath(virtualPath);
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
    const filePath = getGitLabPath(virtualPath);
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
    const filePath = getGitLabPath(virtualPath);
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
    const filePath = getGitLabPath(virtualPath);
    
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
      const filePath = getGitLabPath(virtualPath);
      const { content, commit_message, applyDefaults } = req.body;

      // Inject defaults if requested
      const injectedContent = applyDefaults 
        ? injectDefaults(content, virtualPath)
        : content;

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
      const filePath = getGitLabPath(virtualPath);
      const { content, commit_message, applyDefaults } = req.body;

      // Inject defaults if requested
      const injectedContent = applyDefaults 
        ? injectDefaults(content, virtualPath)
        : content;

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

// --- Helper for injecting defaults ---
function injectDefaults(content, virtualPath) {
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

/**
 * GET /api/executions
 * List Argo Workflows directly via Kubernetes API using the official client
 */
apiRouter.get("/executions", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    console.log(`Fetching workflows from K8s API (namespace: ${namespace})`);
    
    const response = await customObjectsApi.listNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows'
    });
    
    // The K8s client wraps the response in { response, body }
    const items = response.items || [];
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

    // Inject OIDC username label if present to resolve workflow variables like creator-preferred-username
    if (req.user) {
      const username = req.user.preferred_username || req.user.email || req.user.name || req.user.sub;
      if (username) {
        if (!workflow.metadata.labels) workflow.metadata.labels = {};
        workflow.metadata.labels['workflows.argoproj.io/creator-preferred-username'] = username;
        console.log(`[API EXECUTIONS] Injected workflows.argoproj.io/creator-preferred-username label: "${username}"`);
      }
    }
    
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

apiRouter.get("/applications", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: GITLAB_APPLICATIONS_PATH,
          ref: GITLAB_BRANCH,
          recursive: true
        }
      }
    );

    const apps = {};
    for (const file of response.data) {
      if (file.type === "blob" && file.path.startsWith(GITLAB_APPLICATIONS_PATH + "/")) {
        const relativePath = file.path.slice(GITLAB_APPLICATIONS_PATH.length + 1);
        const parts = relativePath.split('/');
        if (parts.length === 2) {
          const appName = parts[0];
          const filename = parts[1];
          if (["service.yaml", "deployment.yaml", "ingress.yaml"].includes(filename)) {
            if (!apps[appName]) {
              apps[appName] = { name: appName, files: [] };
            }
            apps[appName].files.push(filename);
          }
        }
      }
    }

    res.json(Object.values(apps));
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

apiRouter.get("/applications/:name", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const { name } = req.params;
    const files = ["deployment.yaml", "service.yaml"];
    if (ALLOW_PUBLIC_INGRESS) {
      files.push("ingress.yaml");
    }

    const payload = {};
    for (const f of files) {
      const filePath = `${GITLAB_APPLICATIONS_PATH}/${name}/${f}`;
      try {
        const response = await gitlabApi.get(
          `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
          { params: { ref: GITLAB_BRANCH } }
        );
        payload[f.replace(".yaml", "")] = response.data;
      } catch (err) {
        if (err.response && err.response.status === 404) {
          payload[f.replace(".yaml", "")] = null;
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

apiRouter.post("/applications/:name", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const { name } = req.params;
    const { deployment, service, ingress, commit_message } = req.body;

    if (!deployment || !service) {
      return res.status(400).json({ message: "Both deployment and service YAML content are required." });
    }

    const actions = [];
    try {
      const sanitizedDeployment = validateAndSanitizeAppYaml(name, deployment, 'deployment');
      actions.push({
        action: "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/deployment.yaml`,
        content: sanitizedDeployment
      });

      const sanitizedService = validateAndSanitizeAppYaml(name, service, 'service');
      actions.push({
        action: "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/service.yaml`,
        content: sanitizedService
      });

      if (ingress && ALLOW_PUBLIC_INGRESS) {
        const sanitizedIngress = validateAndSanitizeAppYaml(name, ingress, 'ingress');
        actions.push({
          action: "create",
          file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/ingress.yaml`,
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
        commit_message: commit_message || `Create application ${name}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.status(201).json(response.data);
  } catch (error) {
    next(error);
  }
});

apiRouter.put("/applications/:name", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const { name } = req.params;
    const { deployment, service, ingress, commit_message } = req.body;

    if (!deployment || !service) {
      return res.status(400).json({ message: "Both deployment and service YAML content are required." });
    }

    const actions = [];
    try {
      let existingFiles = [];
      try {
        const response = await gitlabApi.get(
          `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
          {
            params: {
              path: `${GITLAB_APPLICATIONS_PATH}/${name}`,
              ref: GITLAB_BRANCH
            }
          }
        );
        existingFiles = response.data.map(f => f.name);
      } catch (err) {
        // directory may not exist
      }

      const sanitizedDeployment = validateAndSanitizeAppYaml(name, deployment, 'deployment');
      actions.push({
        action: existingFiles.includes("deployment.yaml") ? "update" : "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/deployment.yaml`,
        content: sanitizedDeployment
      });

      const sanitizedService = validateAndSanitizeAppYaml(name, service, 'service');
      actions.push({
        action: existingFiles.includes("service.yaml") ? "update" : "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/service.yaml`,
        content: sanitizedService
      });

      if (ALLOW_PUBLIC_INGRESS) {
        if (ingress) {
          const sanitizedIngress = validateAndSanitizeAppYaml(name, ingress, 'ingress');
          actions.push({
            action: existingFiles.includes("ingress.yaml") ? "update" : "create",
            file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/ingress.yaml`,
            content: sanitizedIngress
          });
        } else if (existingFiles.includes("ingress.yaml")) {
          actions.push({
            action: "delete",
            file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/ingress.yaml`
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
        commit_message: commit_message || `Update application ${name}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete("/applications/:name", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const { name } = req.params;

    let existingFiles = [];
    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
        {
          params: {
            path: `${GITLAB_APPLICATIONS_PATH}/${name}`,
            ref: GITLAB_BRANCH
          }
        }
      );
      existingFiles = response.data.filter(f => f.type === "blob").map(f => f.name);
    } catch (err) {
      return res.status(404).json({ message: `Application ${name} not found in Git.` });
    }

    if (existingFiles.length === 0) {
      return res.json({ message: `Application ${name} is already empty or deleted.` });
    }

    const actions = existingFiles.map(filename => ({
      action: "delete",
      file_path: `${GITLAB_APPLICATIONS_PATH}/${name}/${filename}`
    }));

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete application ${name}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.json({ message: `Application ${name} deleted from Git.`, gitlab: response.data });
  } catch (error) {
    next(error);
  }
});

apiRouter.get("/applications/:name/status", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const { name } = req.params;
    const namespace = process.env.ARGO_NAMESPACE || "default";

    let deploymentStatus = null;
    try {
      const depResponse = await appsV1Api.readNamespacedDeployment({ name, namespace });
      const d = depResponse.body || depResponse;
      deploymentStatus = {
        replicas: d.status?.replicas || 0,
        readyReplicas: d.status?.readyReplicas || 0,
        availableReplicas: d.status?.availableReplicas || 0,
        conditions: d.spec?.replicas === 0 ? [{ type: "ScaledToZero", status: "True", message: "Application is scaled to zero." }] : (d.status?.conditions || [])
      };
    } catch (err) {
      if (err.statusCode !== 404) {
        console.error("Failed to read deployment from K8s:", err.message);
      }
    }

    let serviceStatus = null;
    try {
      const svcResponse = await coreV1Api.readNamespacedService({ name, namespace });
      const s = svcResponse.body || svcResponse;
      serviceStatus = {
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: s.spec?.ports || []
      };
    } catch (err) {
      // 404 is expected if not reconciled
    }

    let pods = [];
    try {
      const podsResponse = await coreV1Api.listNamespacedPod({
        namespace,
        labelSelector: `app.kubernetes.io/service=${name}`
      });
      const items = podsResponse.body?.items || podsResponse.items || [];
      pods = items.map(p => ({
        name: p.metadata?.name,
        phase: p.status?.phase,
        restarts: p.status?.containerStatuses?.reduce((acc, c) => acc + (c.restartCount || 0), 0) || 0,
        age: p.metadata?.creationTimestamp,
        containerStatus: p.status?.containerStatuses?.map(c => ({
          name: c.name,
          ready: c.ready,
          state: c.state
        })) || []
      }));
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
      
      // Filter reports matching the current application name
      const appReports = items.filter(item => {
        const rName = item.metadata?.labels?.['trivy-operator.resource.name'] || '';
        const cName = item.metadata?.labels?.['trivy-operator.container.name'] || '';
        const repName = item.metadata?.name || '';
        return rName === name || 
               rName.startsWith(`${name}-`) || 
               cName === name ||
               repName.startsWith(`replicaset-${name}-`) ||
               repName.startsWith(`deployment-${name}-`);
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
      // Trivy operator might not be installed, which is expected
      console.debug("Failed to fetch Trivy vulnerability reports:", err.message);
    }

    res.json({
      name,
      deployed: !!deploymentStatus,
      deployment: deploymentStatus,
      service: serviceStatus,
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

    const appLabel = pod.metadata?.labels?.['app.kubernetes.io/service'];
    if (appLabel !== name) {
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
      console.log(`[API LOGS] No logs found across all labels and fallbacks for ID: "${id}"`);
      try {
        const config = getLokiConfig(req, LOKI_URL);
        const labelsResp = await axios.get(`${LOKI_URL}/loki/api/v1/labels`, config);
        console.log(`[API LOGS] DIAGNOSTIC: All available Loki label keys in your cluster are:`, labelsResp.data.data || []);
      } catch (labelErr) {
        console.error(`[API LOGS] DIAGNOSTIC ERROR: Failed to fetch Loki labels:`, labelErr.message);
      }
      return res.send("No logs found in Loki for the specified execution time range.");
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
  // If this is an auth error from requiresAuth and we're on an API route
  if (err.status === 401 || err.statusCode === 401) {
    return res.status(401).json({ 
      message: 'Authentication Required',
      loginUrl: `${BASE_PATH}/login` 
    });
  }

  console.error(err.stack);

  // Check if this error originated from the GitLab Axios client
  const isGitLabError = err.config && (
    err.config.headers?.['PRIVATE-TOKEN'] || 
    (err.config.url && err.config.url.includes('/projects/')) ||
    (err.config.baseURL && err.config.baseURL.includes('/api/v4'))
  );

  if (isGitLabError) {
    let status = 502; // Use 502 Bad Gateway to signal backend integration failure
    let customMessage = "An error occurred while communicating with GitLab.";

    if (err.response) {
      const gitlabStatus = err.response.status;
      if (gitlabStatus === 401) {
        customMessage = "GitLab Authentication Failed: The configured GITLAB_TOKEN is invalid, expired, or does not have access rights.";
      } else if (gitlabStatus === 403) {
        customMessage = "GitLab Access Forbidden: The configured GITLAB_TOKEN does not have permissions for the project/repository.";
      } else if (gitlabStatus === 404) {
        customMessage = `GitLab Resource Not Found: The configured GITLAB_PROJECT_ID ("${process.env.GITLAB_PROJECT_ID}") or branch ("${process.env.GITLAB_BRANCH}") could not be found.`;
      } else {
        customMessage = `GitLab Error (${gitlabStatus}): ${err.response.data?.message || err.response.data?.error || err.message}`;
      }
    } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.message.includes('getaddrinfo')) {
      customMessage = `GitLab Unreachable: Failed to resolve or connect to GITLAB_URL ("${process.env.GITLAB_URL || 'https://gitlab.com'}"). Please check your network and configuration.`;
    } else {
      customMessage = `GitLab Connection Error: ${err.message}`;
    }

    return res.status(status).json({
      message: customMessage,
      originalStatus: err.response ? err.response.status : null
    });
  }

  const status = err.response ? err.response.status : 500;
  const message = err.response ? err.response.data : { message: err.message };
  res.status(status).json(message);
});


// --- 5. SERVER START ---

const server = app.listen(PORT, '::', () => {
  console.log(`Server is running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});