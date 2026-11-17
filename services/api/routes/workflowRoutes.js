const express = require('express');
const YAML = require('yaml');
const path = require('path');
const fs = require('fs');
const k8s = require('@kubernetes/client-node');

function createWorkflowRouter(ctx) {
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
    k8sApi,
    k8sCustomApi,
    k8sCoreApi,
    getUsername,
    getCandidateUsernames,
    getGitLabPath,
    getGitLabPackagesPath,
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
  } = ctx;

router.get("/published-workflows", async (req, res, next) => {
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
router.post(/^\/workflows\/(.+)\/publish$/, async (req, res, next) => {
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
router.delete(/^\/workflows\/(.+)\/publish$/, async (req, res, next) => {
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
router.get(/^\/workflows\/(.+)\/sync-status$/, async (req, res, next) => {
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
router.get("/workflows", async (req, res, next) => {
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
router.get(/^\/workflows\/(.+)\/history$/, async (req, res, next) => {
  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPath(virtualPath, req);
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        params: {
          path: filePath,
          ref_name: GITLAB_BRANCH,
          with_stats: true
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
router.get(/^\/workflows\/(.+)$/, async (req, res, next) => {
  // If the wildcard matches nothing, req.path might be '/workflows/' or '/workflows'.
  if (req.path === '/workflows/' || req.path === '/workflows') return next();

  try {
    const virtualPath = getVirtualPath(req);
    const filePath = getGitLabPath(virtualPath, req);
    const ref = req.query.ref || req.query.commit_id || req.query.ref_name || GITLAB_BRANCH;

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
router.post(/^\/workflows\/(.+)\/restore$/, async (req, res, next) => {
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
router.delete(/^\/workflows\/(.+)$/, async (req, res, next) => {
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
router.post(
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
router.put(
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

  return router;
}

module.exports = { createWorkflowRouter };
