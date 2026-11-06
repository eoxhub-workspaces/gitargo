const express = require('express');
const YAML = require('yaml');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const tar = require('tar-stream');
const zlib = require('zlib');

function createExecutionRouter(ctx) {
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
    ARGO_AVAILABLE_TOLERATIONS,
    ARGO_AVAILABLE_NODE_SELECTORS,
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

router.get("/executions", async (req, res, next) => {
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
router.get("/executions/:name", async (req, res, next) => {
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
router.delete("/executions/:name", async (req, res, next) => {
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
router.post("/executions/:name/terminate", async (req, res, next) => {
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
router.post("/executions", async (req, res, next) => {
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
router.post("/executions/cwl", async (req, res, next) => {
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

  return router;
}

module.exports = { createExecutionRouter };
