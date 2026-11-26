const express = require('express');
const YAML = require('yaml');
const path = require('path');

function checkIsKev(v) {
  if (!v) return false;
  if (v.knownExploitable === true || v.knownExploitable === 'true') return true;
  if (v.kev === true || v.kev === 'true' || v.isKev === true || v.cisaKev === true) return true;
  if (v.vendorAttributes && (v.vendorAttributes.KEV === true || v.vendorAttributes.cisaKev === true)) return true;
  if (typeof v.primaryLink === 'string' && (v.primaryLink.includes('cisa.gov/known-exploitable') || v.primaryLink.includes('known-exploitable-vulnerabilities'))) return true;
  if (Array.isArray(v.links) && v.links.some(l => typeof l === 'string' && l.includes('cisa.gov/known-exploitable'))) return true;
  return false;
}

function parseEpssScore(v) {
  if (!v) return null;
  let raw = null;
  if (v.epssScore !== undefined && v.epssScore !== null) {
    raw = v.epssScore;
  } else if (typeof v.epss === 'number') {
    raw = v.epss;
  } else if (v.epss && typeof v.epss.score === 'number') {
    raw = v.epss.score;
  } else if (v.epss_score !== undefined && v.epss_score !== null) {
    raw = v.epss_score;
  }
  if (raw === null || raw === undefined) return null;

  let val = null;
  if (typeof raw === 'string') {
    const isPercent = raw.includes('%');
    const parsed = parseFloat(raw.replace('%', ''));
    if (isNaN(parsed)) return null;
    val = isPercent ? parsed / 100 : (parsed > 1 ? parsed / 100 : parsed);
  } else if (typeof raw === 'number') {
    if (isNaN(raw)) return null;
    val = raw > 1 ? raw / 100 : raw;
  }
  if (val === null) return null;
  return Math.round(val * 10000) / 10000;
}

function formatEpssPercentage(epssScore) {
  if (epssScore === null || epssScore === undefined) return null;
  return `${(epssScore * 100).toFixed(1)}%`;
}

function isVulnerabilityFixable(v) {
  return !!(v && v.fixedVersion && typeof v.fixedVersion === 'string' && v.fixedVersion.trim().length > 0);
}

function determineActionRequired(isKev, epssScore, isFixable, severity) {
  if (isKev) return true;
  if (epssScore !== null && epssScore >= 0.10) return true;
  if (isFixable && (severity === 'CRITICAL' || severity === 'HIGH')) return true;
  return false;
}

function getActionReason(isKev, epssScore, isFixable, severity) {
  if (isKev) return 'Active Exploit (CISA KEV)';
  if (epssScore !== null && epssScore >= 0.10) return `High Exploit Probability (EPSS ${formatEpssPercentage(epssScore)})`;
  if (isFixable && severity === 'CRITICAL') return 'Fixable Critical Vulnerability';
  if (isFixable && severity === 'HIGH') return 'Fixable High Vulnerability';
  return 'Low Risk / Informational';
}

function parseContainerReport(item) {
  const container = item.metadata?.labels?.['trivy-operator.container.name'] || 'unknown';
  const rawSummary = item.report?.summary || { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  const rawVulns = item.report?.vulnerabilities || [];

  const severityRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

  const parsedVulns = rawVulns.map(v => {
    const isKev = checkIsKev(v);
    const epssScore = parseEpssScore(v);
    const epssPercentage = formatEpssPercentage(epssScore);
    const fixable = isVulnerabilityFixable(v);
    const severity = (v.severity || 'UNKNOWN').toUpperCase();
    const actionReq = determineActionRequired(isKev, epssScore, fixable, severity);
    const actionReason = getActionReason(isKev, epssScore, fixable, severity);

    return {
      id: v.vulnerabilityID || v.id || 'CVE-UNKNOWN',
      title: v.title || '',
      severity: severity,
      pkg: v.resource || v.pkgName || v.package || 'unknown',
      installedVersion: v.installedVersion || 'unknown',
      fixedVersion: v.fixedVersion || null,
      link: v.primaryLink || (Array.isArray(v.links) ? v.links[0] : null) || null,
      isKev: isKev,
      epssScore: epssScore,
      epssPercentage: epssPercentage,
      isFixable: fixable,
      actionRequired: actionReq,
      actionReason: actionReason
    };
  });

  parsedVulns.sort((a, b) => {
    if (a.actionRequired !== b.actionRequired) return a.actionRequired ? -1 : 1;
    if (a.isKev !== b.isKev) return a.isKev ? -1 : 1;
    const aEpss = a.epssScore || 0;
    const bEpss = b.epssScore || 0;
    if (Math.abs(aEpss - bEpss) > 0.001) return bEpss - aEpss;
    const rankDiff = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
    if (rankDiff !== 0) return rankDiff;
    return a.id.localeCompare(b.id);
  });

  const actionRequiredCount = parsedVulns.filter(v => v.actionRequired).length;
  const kevCount = parsedVulns.filter(v => v.isKev).length;
  const highEpssCount = parsedVulns.filter(v => v.epssScore !== null && v.epssScore >= 0.10).length;
  const fixableCount = parsedVulns.filter(v => v.isFixable).length;

  const summary = {
    criticalCount: rawSummary.criticalCount || 0,
    highCount: rawSummary.highCount || 0,
    mediumCount: rawSummary.mediumCount || 0,
    lowCount: rawSummary.lowCount || 0,
    unknownCount: rawSummary.unknownCount || 0,
    totalCount: parsedVulns.length,
    actionRequiredCount: actionRequiredCount,
    kevCount: kevCount,
    highEpssCount: highEpssCount,
    fixableCount: fixableCount
  };

  return {
    container,
    summary,
    topVulnerabilities: parsedVulns
  };
}

function createApplicationRouter(ctx) {
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
    validateArgoWorkflow,
    validateAndSanitizeAppYaml
  } = ctx;

const appBlobCache = new Map();
const appStatusCache = new Map();
const APP_STATUS_TTL = 10000;

let trivyReportsCache = null;
const TRIVY_CACHE_TTL = 30000;

async function getCachedTrivyReports(targetNamespace) {
  const trivyEnvNs = process.env.TRIVY_NAMESPACE;
  const namespacesToTry = Array.from(new Set([targetNamespace, trivyEnvNs, process.env.ARGO_NAMESPACE, "trivy-system", "default"].filter(Boolean)));

  if (!trivyReportsCache) trivyReportsCache = {};
  let allItems = [];

  for (const ns of namespacesToTry) {
    if (
      trivyReportsCache[ns] &&
      Date.now() - trivyReportsCache[ns].timestamp < TRIVY_CACHE_TTL
    ) {
      allItems.push(...trivyReportsCache[ns].items);
      continue;
    }
    if (!customObjectsApi) continue;
    try {
      const trivyRes = await customObjectsApi.listNamespacedCustomObject({
        group: "aquasecurity.github.io",
        version: "v1alpha1",
        namespace: ns,
        plural: "vulnerabilityreports"
      });
      const items = trivyRes.body?.items || trivyRes.items || [];
      trivyReportsCache[ns] = { timestamp: Date.now(), items };
      allItems.push(...items);
    } catch (err) {
      if (!isK8sIgnorableError(err)) {
        console.debug(`Failed to fetch Trivy vulnerability reports in namespace ${ns}:`, err.message || err);
      }
    }
  }
  return allItems;
}

async function fetchAppStatus(appName, deploymentContent = null) {
  const cached = appStatusCache.get(appName);
  if (cached && (Date.now() - cached.timestamp < APP_STATUS_TTL)) {
    return cached.data;
  }

  const { folder, prefix } = resolveAppLocation(appName);
  const expectedNamespace = process.env.ARGO_NAMESPACE || "default";
  let targetK8sName = prefix || folder;
  let configuredNamespace = null;

  if (!deploymentContent) {
    const candidateDepFiles = [
      getAppFilename(prefix, "deployment"),
      `${prefix ? `${prefix}-` : ""}deployment.yml`,
      `${prefix ? `${prefix}-` : ""}deploy.yaml`,
      `${prefix ? `${prefix}-` : ""}deploy.yml`,
      "app.yaml",
      "app.yml"
    ];
    for (const depFile of candidateDepFiles) {
      try {
        const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`;
        const rawResponse = await gitlabApi.get(
          `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
          { params: { ref: GITLAB_BRANCH } }
        );
        if (rawResponse.data) {
          deploymentContent = rawResponse.data;
          break;
        }
      } catch (e) {}
    }
  }

  if (deploymentContent) {
    const lines = deploymentContent.split("\n").filter(l => l.trim().length > 0);
    const isAppDisabled = lines.length > 0 && lines.every(l => l.trim().startsWith("#"));
    if (isAppDisabled) {
      const result = {
        name: appName,
        deployed: false,
        deployment: null,
        service: null,
        ingress: null,
        pods: [],
        vulnerabilities: null,
        namespaceWarning: null
      };
      appStatusCache.set(appName, { timestamp: Date.now(), data: result });
      return result;
    }

    try {
      const docs = deploymentContent.split(/^---$/m).map(d => d.trim()).filter(Boolean);
      for (const docStr of docs) {
        try {
          const parsed = YAML.parse(docStr);
          if (parsed && parsed.kind === "Deployment") {
            if (parsed.metadata?.name) targetK8sName = parsed.metadata.name;
            if (parsed.metadata?.namespace) configuredNamespace = parsed.metadata.namespace;
            break;
          } else if (parsed && parsed.metadata?.name && !targetK8sName) {
            targetK8sName = parsed.metadata.name;
            if (parsed.metadata?.namespace && !configuredNamespace) configuredNamespace = parsed.metadata.namespace;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  let namespaceWarning = null;
  if (configuredNamespace && configuredNamespace !== expectedNamespace) {
    namespaceWarning = {
      configured: configuredNamespace,
      expected: expectedNamespace,
      message: `Manifest specifies namespace '${configuredNamespace}', but expected namespace is '${expectedNamespace}'.`
    };
  }

  let deploymentStatus = null;
  let deploymentMatchLabels = null;

  if (appsV1Api) {
    try {
      const depResponse = await appsV1Api.readNamespacedDeployment({ name: targetK8sName, namespace: expectedNamespace });
      const d = depResponse.body || depResponse;
      deploymentMatchLabels = d.spec?.selector?.matchLabels || null;
      deploymentStatus = {
        replicas: d.status?.replicas || 0,
        readyReplicas: d.status?.readyReplicas || 0,
        availableReplicas: d.status?.availableReplicas || 0,
        conditions: d.spec?.replicas === 0 ? [{ type: "ScaledToZero", status: "True", message: "Application is scaled to zero." }] : (d.status?.conditions || [])
      };
    } catch (err) {
      // Fallback: list deployments in expectedNamespace to find matching deployment by label
      try {
        const depListRes = await appsV1Api.listNamespacedDeployment({ namespace: expectedNamespace });
        const items = depListRes.body?.items || depListRes.items || [];
        const matchedDep = items.find(d => {
          const dName = d.metadata?.name || '';
          const matchLabels = d.spec?.selector?.matchLabels || {};
          const appLabel = matchLabels['app'] || matchLabels['app.kubernetes.io/name'] || matchLabels['app.kubernetes.io/instance'] || matchLabels['app.kubernetes.io/service'] || '';
          return dName === targetK8sName || dName.includes(appName) || dName.includes(folder) || appLabel === appName || appLabel === targetK8sName || appLabel === folder;
        });
        if (matchedDep) {
          targetK8sName = matchedDep.metadata?.name || targetK8sName;
          deploymentMatchLabels = matchedDep.spec?.selector?.matchLabels || null;
          deploymentStatus = {
            replicas: matchedDep.status?.replicas || 0,
            readyReplicas: matchedDep.status?.readyReplicas || 0,
            availableReplicas: matchedDep.status?.availableReplicas || 0,
            conditions: matchedDep.spec?.replicas === 0 ? [{ type: "ScaledToZero", status: "True", message: "Application is scaled to zero." }] : (matchedDep.status?.conditions || [])
          };
        }
      } catch (listErr) {}
    }
  }

  let serviceStatus = null;
  if (coreV1Api) {
    try {
      const svcResponse = await coreV1Api.readNamespacedService({ name: targetK8sName, namespace: expectedNamespace });
      const s = svcResponse.body || svcResponse;
      serviceStatus = {
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: s.spec?.ports || []
      };
    } catch (err) {}
  }

  let ingressStatus = null;
  if (networkingV1Api) {
    try {
      const ingResponse = await networkingV1Api.readNamespacedIngress({ name: targetK8sName, namespace: expectedNamespace });
      const ing = ingResponse.body || ingResponse;
      const lb = ing.status?.loadBalancer?.ingress || [];
      const hasRules = ing.spec?.rules && ing.spec.rules.length > 0;
      const isIngressReady = (lb.length > 0 && (lb[0].ip || lb[0].hostname)) || hasRules;

      ingressStatus = {
        ready: !!isIngressReady,
        loadBalancer: lb
      };
    } catch (err) {}
  }

  let pods = [];
  const podNames = new Set();
  const podOwnerNames = new Set();

  if (coreV1Api) {
    try {
      let labelSelector = "";
      if (deploymentMatchLabels && Object.keys(deploymentMatchLabels).length > 0) {
        labelSelector = Object.entries(deploymentMatchLabels)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
      } else {
        labelSelector = `app.kubernetes.io/service=${targetK8sName}`;
      }

      const res = await coreV1Api.listNamespacedPod({ namespace: expectedNamespace, labelSelector });
      const rawPods = res.body?.items || res.items || [];
      rawPods.forEach(p => {
        if (p.metadata?.name) podNames.add(p.metadata.name);
        (p.metadata?.ownerReferences || []).forEach(o => {
          if (o.name) podOwnerNames.add(o.name);
        });
      });

      pods = rawPods.map(p => ({
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
    } catch (err) {}
  }

  let vulnerabilities = null;
  if (customObjectsApi) {
    try {
      const items = await getCachedTrivyReports(expectedNamespace);
      const workloadNames = new Set([targetK8sName, appName, folder].filter(Boolean));

      const appReports = items.filter(item => {
        const rName = item.metadata?.labels?.['trivy-operator.resource.name'] || '';
        const cName = item.metadata?.labels?.['trivy-operator.container.name'] || '';
        const repName = item.metadata?.name || '';

        // Direct pod name or replica set owner match
        if (rName && (podNames.has(rName) || podOwnerNames.has(rName))) return true;

        for (const podName of podNames) {
          if (repName.startsWith(`pod-${podName}-`) || rName === podName) return true;
        }

        for (const ownerName of podOwnerNames) {
          if (repName.startsWith(`replicaset-${ownerName}-`) || rName === ownerName) return true;
        }

        // Workload names match against labels and report names
        for (const name of workloadNames) {
          if (!name) continue;
          if (rName === name || rName.startsWith(`${name}-`) || name.startsWith(`${rName}-`)) return true;
          if (cName === name) return true;
          if (
            repName.startsWith(`deployment-${name}-`) ||
            repName.startsWith(`replicaset-${name}-`) ||
            repName.startsWith(`statefulset-${name}-`) ||
            repName.startsWith(`daemonset-${name}-`) ||
            repName.startsWith(`pod-${name}-`) ||
            repName.startsWith(`cronjob-${name}-`) ||
            repName.includes(`-${name}-`)
          ) {
            return true;
          }
        }

        return false;
      });

      if (appReports.length > 0) {
        vulnerabilities = appReports.map(parseContainerReport);
      }
    } catch (err) {}
  }

  const result = {
    name: appName,
    deployed: !!deploymentStatus,
    deployment: deploymentStatus,
    service: serviceStatus,
    ingress: ingressStatus,
    pods: pods,
    vulnerabilities: vulnerabilities,
    namespaceWarning: namespaceWarning
  };

  appStatusCache.set(appName, { timestamp: Date.now(), data: result });
  return result;
}

router.get("/applications", requiresApplicationsEnabled, async (req, res, next) => {
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
    const fileEntries = [];

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
                hasDeployment: false,
                yamls: { deployment: "", service: "", ingress: "" }
              };
            }
            appsMap[appKey].files.push(filename);
            fileEntries.push({ appKey, type: parsed.type, file });
            if (parsed.type === "deployment") {
              appsMap[appKey].hasDeployment = true;
            }
          }
        }
      }
    }

    // Fetch raw file contents in parallel (using Git blob SHA cache)
    await Promise.all(
      fileEntries.map(async ({ appKey, type, file }) => {
        let content = "";
        if (file.id && appBlobCache.has(file.id)) {
          content = appBlobCache.get(file.id);
        } else {
          try {
            const raw = await gitlabApi.get(
              `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(file.path)}/raw`,
              { params: { ref: GITLAB_BRANCH } }
            );
            content = raw.data || "";
            if (file.id) {
              appBlobCache.set(file.id, content);
            }
          } catch (e) {}
        }
        if (appsMap[appKey]) {
          appsMap[appKey].yamls[type] = content;
        }
      })
    );

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

// Helper to detect 404 Not Found or 403 Forbidden errors across all @kubernetes/client-node error formats
function isK8sIgnorableError(err) {
  if (!err) return false;
  const status = err.statusCode || err.code || err.response?.statusCode || err.response?.body?.code || err.status;
  if (status === 404 || status === 403) return true;
  if (typeof err.body === 'string' && (err.body.includes('"code":404') || err.body.includes('"code":403'))) return true;
  if (typeof err.message === 'string' && (
    err.message.includes('not found') ||
    err.message.includes('forbidden') ||
    err.message.includes('Forbidden') ||
    err.message.includes('HTTP-Code: 404') ||
    err.message.includes('HTTP-Code: 403')
  )) return true;
  return false;
}

// GET /api/applications/:appName/status
router.get(/^\/applications\/(.+)\/status$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const status = await fetchAppStatus(appName);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/applications/:appName/pods/:podName
router.delete(/^\/applications\/(.+)\/pods\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const rawAppName = req.params[0];
    const podName = req.params[1];
    let appName = rawAppName;
    try { appName = decodeURIComponent(rawAppName); } catch (e) {}

    const { folder, prefix } = resolveAppLocation(appName);
    let namespace = process.env.ARGO_NAMESPACE || "default";

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
router.get(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
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
router.post(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
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
router.put(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
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
router.delete(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
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

  return router;
}

module.exports = {
  createApplicationRouter,
  checkIsKev,
  parseEpssScore,
  determineActionRequired,
  parseContainerReport
};
