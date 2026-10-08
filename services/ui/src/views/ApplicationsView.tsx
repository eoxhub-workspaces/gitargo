import React, { useEffect, useState } from "react";
import {
  CpuChipIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  DocumentMagnifyingGlassIcon,
  ArrowPathIcon,
  XMarkIcon,
  EyeIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon
} from "@heroicons/react/24/outline";
import toast from "react-hot-toast";
import Editor from "@monaco-editor/react";
import YAML from "yaml";
import {
  getApplications,
  getApplication,
  createApplication,
  updateApplication,
  deleteApplication,
  getApplicationStatus,
  deleteApplicationPod,
  Application,
  ApplicationYamls,
  ApplicationStatus,
  getConfig,
  AppConfig,
  getLogs
} from "../utils/api";

const defaultDeploymentYaml = (name: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/service: ${name}
  strategy:
    rollingUpdate:
      maxUnavailable: 0
    type: RollingUpdate
  template:
    metadata:
      labels:
        app.kubernetes.io/service: ${name}
    spec:
      containers:
        - name: ${name}
          image: nginx:alpine
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 80
              protocol: TCP
          resources:
            limits:
              cpu: "1"
              memory: 2Gi
            requests:
              cpu: "0.1"
              memory: 0.5Gi`;

const defaultServiceYaml = (name: string) => `apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: http
      protocol: TCP
      name: http
  selector:
    app.kubernetes.io/service: ${name}`;

const generateIngressYaml = (
  name: string,
  namespace: string,
  ingressConfig?: IngressConfig
) => {
  const domain = ingressConfig?.domain || "local";
  const ingressClassName = ingressConfig?.ingressClassName || "traefik";
  const pathType = ingressConfig?.pathType || "Prefix";
  const tlsEnabled = ingressConfig?.tlsEnabled ?? false;
  const dnsTarget = ingressConfig?.dnsTarget || "";
  const certIssuer = ingressConfig?.certIssuer || "";
  const middlewareEnabled = ingressConfig?.middlewareEnabled ?? false;
  const middlewareName = ingressConfig?.middlewareName || "cors-headers";
  const middlewareAnnotationKey =
    ingressConfig?.middlewareAnnotationKey ||
    "traefik.ingress.kubernetes.io/router.middlewares";
  const middlewareAnnotationValueTemplate =
    ingressConfig?.middlewareAnnotationValueTemplate ||
    "${namespace}-${middlewareName}@kubernetescrd";

  const resolvedMiddlewareValue = middlewareAnnotationValueTemplate
    .replace("${namespace}", namespace)
    .replace("${middlewareName}", middlewareName);

  // Annotations
  const annotations: Record<string, string> = {
    ...(ingressConfig?.extraAnnotations || {})
  };
  if (dnsTarget) {
    annotations["external-dns.alpha.kubernetes.io/target"] = dnsTarget;
  }
  if (certIssuer) {
    annotations["cert-manager.io/cluster-issuer"] = certIssuer;
  }
  if (middlewareEnabled) {
    annotations[middlewareAnnotationKey] = resolvedMiddlewareValue;
  }

  const annotationsSection =
    Object.keys(annotations).length > 0
      ? "\n  annotations:\n" +
        Object.entries(annotations)
          .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
          .join("\n")
      : "";

  const tlsSection = tlsEnabled
    ? `\n  tls:\n    - hosts:\n        - ${name}.${domain}\n      secretName: ${name}.${domain}-tls`
    : "";

  const ingressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}${annotationsSection}
spec:
  ingressClassName: ${ingressClassName}${tlsSection}
  rules:
    - host: ${name}.${domain}
      http:
        paths:
          - path: /
            pathType: ${pathType}
            backend:
              service:
                name: ${name}
                port:
                  number: 80`;

  if (middlewareEnabled) {
    const middlewareYaml = `apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: ${middlewareName}
  namespace: ${namespace}
spec:
  headers:
    accessControlAllowMethods:
      - "PUT"
      - "GET"
      - "POST"
      - "OPTIONS"
    accessControlAllowOriginList:
      - "*"
    accessControlAllowCredentials: false
    accessControlExposeHeaders:
      - "Location"
    accessControlAllowHeaders:
      - "*"
    addVaryHeader: true
    accessControlMaxAge: 86400`;

    return `${middlewareYaml}\n---\n${ingressYaml}`;
  }

  return ingressYaml;
};

const commentOutYaml = (yaml: string) => {
  if (!yaml) return "";
  return yaml
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("#")) return line;
      return `# ${line}`;
    })
    .join("\n");
};

const uncommentYaml = (yaml: string) => {
  if (!yaml) return "";
  return yaml
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return line.slice(2);
      if (line.startsWith("#")) return line.slice(1);
      return line;
    })
    .join("\n");
};

const isYamlDisabled = (yaml: string) => {
  if (!yaml) return false;
  const lines = yaml.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => line.trim().startsWith("#"));
};

const ApplicationsView: React.FC = () => {
  const [apps, setApps] = useState<Application[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ApplicationStatus>>(
    {}
  );
  const [appYamls, setAppYamls] = useState<Record<string, ApplicationYamls>>(
    {}
  );
  const isAppDisabled = (appName: string) => {
    const yamls = appYamls[appName];
    if (!yamls) return false;
    return isYamlDisabled(yamls.deployment || "");
  };
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modal states
  const [showFormModal, setShowFormModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);

  // Selected Application states for modals
  const [selectedAppName, setSelectedAppName] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [expertMode, setExpertMode] = useState(false);
  const [isParseable, setIsParseable] = useState(true);
  const [formEnv, setFormEnv] = useState<{ key: string; value: string }[]>([]);
  const [formCommand, setFormCommand] = useState("");

  // Logs modal state
  const [logPodName, setLogPodName] = useState("");
  const [logsText, setLogsText] = useState("Loading logs...");
  const [logsLoading, setLogsLoading] = useState(false);

  // Form Mode Inputs
  const [formName, setFormName] = useState("");
  const [formImage, setFormImage] = useState("nginx:alpine");
  const [formPort, setFormPort] = useState(80);
  const [formCpuLimit, setFormCpuLimit] = useState("1");
  const [formMemLimit, setFormMemLimit] = useState("2Gi");
  const [formCpuReq, setFormCpuReq] = useState("0.1");
  const [formMemReq, setFormMemReq] = useState("0.5Gi");
  const [formIsPublic, setFormIsPublic] = useState(false);

  // EOXHub service annotations
  const [annServiceName, setAnnServiceName] = useState("");
  const [annAllowAnon, setAnnAllowAnon] = useState(false);
  const [annStopUnused, setAnnStopUnused] = useState(false);

  // YAML input states for Expert mode
  const [yamlDeployment, setYamlDeployment] = useState("");
  const [yamlService, setYamlService] = useState("");
  const [yamlIngress, setYamlIngress] = useState("");
  const [activeYamlTab, setActiveYamlTab] = useState<
    "deployment" | "service" | "ingress"
  >("deployment");

  const loadData = async () => {
    try {
      setRefreshing(true);
      const [applications, appConfig] = await Promise.all([
        getApplications(),
        getConfig()
      ]);
      setApps(applications);
      setConfig(appConfig);

      // Fetch status for each application
      const statusPromises = applications.map((app) =>
        getApplicationStatus(app.name)
          .then((status) => ({ name: app.name, status }))
          .catch((err) => {
            console.error(`Error loading status for ${app.name}`, err);
            return { name: app.name, status: null };
          })
      );

      // Fetch YAML for each application
      const yamlPromises = applications.map((app) =>
        getApplication(app.name)
          .then((yamls) => ({ name: app.name, yamls }))
          .catch((err) => {
            console.error(`Error loading YAML for ${app.name}`, err);
            return { name: app.name, yamls: null };
          })
      );

      const [statusResults, yamlResults] = await Promise.all([
        Promise.all(statusPromises),
        Promise.all(yamlPromises)
      ]);

      const newStatuses: Record<string, ApplicationStatus> = {};
      for (const res of statusResults) {
        if (res.status) {
          newStatuses[res.name] = res.status;
        }
      }
      setStatuses(newStatuses);

      const newYamls: Record<string, ApplicationYamls> = {};
      for (const res of yamlResults) {
        if (res.yamls) {
          newYamls[res.name] = res.yamls;
        }
      }
      setAppYamls(newYamls);
    } catch (err: any) {
      toast.error("Failed to fetch applications list: " + err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
    // Poll status every 10 seconds
    const interval = setInterval(() => {
      if (apps.length > 0) {
        apps.forEach((app) => {
          getApplicationStatus(app.name)
            .then((status) => {
              setStatuses((prev) => ({ ...prev, [app.name]: status }));
            })
            .catch(() => {});
        });
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [apps.length]);

  const handleOpenNewModal = () => {
    setIsEditing(false);
    setExpertMode(false);
    setIsParseable(true);
    setFormName("");
    setFormImage("nginx:alpine");
    setFormPort(80);
    setFormCpuLimit("1");
    setFormMemLimit("2Gi");
    setFormCpuReq("0.1");
    setFormMemReq("0.5Gi");
    setFormIsPublic(false);
    setAnnServiceName("");
    setAnnAllowAnon(false);
    setAnnStopUnused(false);
    setFormEnv([]);
    setFormCommand("");

    setYamlDeployment(defaultDeploymentYaml("my-app"));
    setYamlService(defaultServiceYaml("my-app"));
    setYamlIngress(
      generateIngressYaml(
        "my-app",
        config?.defaults?.namespace || "default",
        config?.ingress
      )
    );
    setActiveYamlTab("deployment");

    setShowFormModal(true);
  };

  const parseYamlToForm = (depYamlStr: string, svcYamlStr: string) => {
    try {
      const dep = YAML.parse(depYamlStr);
      const svc = YAML.parse(svcYamlStr);

      if (!dep || dep.kind !== "Deployment") return false;

      const container = dep.spec?.template?.spec?.containers?.[0];
      if (!container) return false;

      // Extract form values
      const name = dep.metadata?.name || "";
      const image = container.image || "";
      const port = container.ports?.[0]?.containerPort || 80;
      const cpuLimit = container.resources?.limits?.cpu || "1";
      const memLimit = container.resources?.limits?.memory || "2Gi";
      const cpuReq = container.resources?.requests?.cpu || "0.1";
      const memReq = container.resources?.requests?.memory || "0.5Gi";

      // Extract env variables
      const envs: { key: string; value: string }[] = [];
      if (Array.isArray(container.env)) {
        container.env.forEach((e: any) => {
          if (e && e.name) {
            envs.push({ key: e.name, value: String(e.value ?? "") });
          }
        });
      }

      // Extract command
      let command = "";
      if (Array.isArray(container.command)) {
        if (
          container.command[0] === "/bin/sh" &&
          container.command[1] === "-c" &&
          typeof container.command[2] === "string"
        ) {
          command = container.command[2];
        } else {
          command = container.command.join(" ");
        }
      }

      // Extract service annotations
      const svcAnnotations = svc?.metadata?.annotations || {};
      const serviceName = svcAnnotations["eoxhub/service-name"] || "";
      const allowAnon = svcAnnotations["eoxhub/allow-anonymous"] === "true";
      const stopUnused = svcAnnotations["eoxhub/stop-if-unused"] === "true";

      setFormName(name);
      setFormImage(image);
      setFormPort(port);
      setFormCpuLimit(cpuLimit);
      setFormMemLimit(memLimit);
      setFormCpuReq(cpuReq);
      setFormMemReq(memReq);
      setFormEnv(envs);
      setFormCommand(command);
      setAnnServiceName(serviceName);
      setAnnAllowAnon(allowAnon);
      setAnnStopUnused(stopUnused);

      return true;
    } catch (err) {
      console.warn("Failed to parse YAML back into form inputs", err);
      return false;
    }
  };

  const handleOpenEditModal = async (appName: string) => {
    setIsEditing(true);
    setSelectedAppName(appName);
    setActiveYamlTab("deployment");

    const loadingToast = toast.loading("Loading application config...");
    try {
      const yamls = await getApplication(appName);
      const disabled = isYamlDisabled(yamls.deployment || "");

      const rawDep = disabled
        ? uncommentYaml(yamls.deployment || "")
        : yamls.deployment || "";
      const rawSvc = disabled
        ? uncommentYaml(yamls.service || "")
        : yamls.service || "";
      const rawIng =
        disabled && yamls.ingress
          ? uncommentYaml(yamls.ingress)
          : yamls.ingress || "";

      setYamlDeployment(rawDep);
      setYamlService(rawSvc);
      setYamlIngress(rawIng);

      // Try to parse into form state. If successful, we can offer Guided Form!
      const parsedSuccessfully = parseYamlToForm(rawDep, rawSvc);
      setFormIsPublic(!!rawIng);
      setIsParseable(parsedSuccessfully);
      setExpertMode(!parsedSuccessfully); // default to form if parseable, else expert

      setShowFormModal(true);
      toast.dismiss(loadingToast);
    } catch (err: any) {
      toast.error("Failed to load application configuration: " + err.message, {
        id: loadingToast
      });
    }
  };

  const handleOpenStatusModal = async (appName: string) => {
    setSelectedAppName(appName);
    setShowStatusModal(true);
    // Refresh status for this app
    try {
      const status = await getApplicationStatus(appName);
      setStatuses((prev) => ({ ...prev, [appName]: status }));
    } catch (err) {
      console.warn("Failed to refresh status", err);
    }
  };

  const handleDeleteApp = async (appName: string) => {
    if (
      !window.confirm(
        `Are you sure you want to delete application "${appName}"? This deletes files from Git repository and tears down deployments.`
      )
    ) {
      return;
    }
    const delToast = toast.loading(`Deleting application "${appName}"...`);
    try {
      await deleteApplication(appName);
      toast.success(`Application "${appName}" deleted successfully.`, {
        id: delToast
      });
      loadData();
    } catch (err: any) {
      toast.error(`Failed to delete application: ${err.message}`, {
        id: delToast
      });
    }
  };

  const handleToggleDisableApp = async (
    appName: string,
    currentlyDisabled: boolean
  ) => {
    const actionText = currentlyDisabled ? "Enabling" : "Disabling";
    const toggleToast = toast.loading(
      `${actionText} application "${appName}"...`
    );
    try {
      // 1. Fetch current YAMLs
      const yamls = await getApplication(appName);

      // 2. Modify YAMLs
      let updatedYamls: ApplicationYamls;
      if (currentlyDisabled) {
        updatedYamls = {
          deployment: uncommentYaml(yamls.deployment || ""),
          service: uncommentYaml(yamls.service || ""),
          ingress: yamls.ingress ? uncommentYaml(yamls.ingress) : undefined
        };
      } else {
        updatedYamls = {
          deployment: commentOutYaml(yamls.deployment || ""),
          service: commentOutYaml(yamls.service || ""),
          ingress: yamls.ingress ? commentOutYaml(yamls.ingress) : undefined
        };
      }

      // 3. Save updated YAMLs
      await updateApplication(
        appName,
        updatedYamls,
        `${actionText} application ${appName}`
      );
      toast.success(
        `Application "${appName}" ${
          currentlyDisabled ? "enabled" : "disabled"
        } successfully.`,
        {
          id: toggleToast
        }
      );
      loadData();
    } catch (err: any) {
      toast.error(
        `Failed to ${currentlyDisabled ? "enable" : "disable"} application: ${
          err.message
        }`,
        {
          id: toggleToast
        }
      );
    }
  };

  const handlePodRestart = async (podName: string) => {
    if (
      !window.confirm(
        `Are you sure you want to restart (delete) pod "${podName}"?`
      )
    ) {
      return;
    }
    const restartToast = toast.loading(`Restarting pod "${podName}"...`);
    try {
      await deleteApplicationPod(selectedAppName, podName);
      toast.success(`Pod "${podName}" is restarting.`, { id: restartToast });
      // Refresh status modal after 1.5 seconds
      setTimeout(async () => {
        try {
          const status = await getApplicationStatus(selectedAppName);
          setStatuses((prev) => ({ ...prev, [selectedAppName]: status }));
        } catch (err) {
          console.warn("Failed to update status after restart", err);
        }
      }, 1500);
    } catch (err: any) {
      toast.error(`Failed to restart pod: ${err.message}`, {
        id: restartToast
      });
    }
  };

  const handleViewLogs = async (podName: string) => {
    setLogPodName(podName);
    setLogsText("Fetching logs from Loki...");
    setLogsLoading(true);
    setShowLogModal(true);
    try {
      const logs = await getLogs(podName, "pod");
      setLogsText(logs || "No logs found for this container.");
    } catch (err: any) {
      setLogsText(
        "Failed to load logs: " + (err.response?.data?.message || err.message)
      );
    } finally {
      setLogsLoading(false);
    }
  };

  const syncFormToYaml = (nameToUse?: string) => {
    const name = nameToUse || formName.trim() || "my-app";

    let commandSection = "";
    if (formCommand.trim()) {
      const lines = formCommand.trim().split("\n");
      if (lines.length === 1) {
        commandSection = `\n          command: ["/bin/sh", "-c", ${JSON.stringify(
          lines[0]
        )}]`;
      } else {
        const indentedCommand = lines
          .map((l) => `              ${l}`)
          .join("\n");
        commandSection = `\n          command:\n            - /bin/sh\n            - -c\n            - |\n${indentedCommand}`;
      }
    }

    let envSection = "";
    if (formEnv.length > 0) {
      envSection = "\n          env:";
      formEnv.forEach(({ key, value }) => {
        if (key.trim()) {
          envSection += `\n            - name: ${key.trim()}\n              value: ${JSON.stringify(
            value
          )}`;
        }
      });
    }

    // Deployment YAML Generation
    const depYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/service: ${name}
  strategy:
    rollingUpdate:
      maxUnavailable: 0
    type: RollingUpdate
  template:
    metadata:
      labels:
        app.kubernetes.io/service: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${formImage}
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: ${formPort}
              protocol: TCP${commandSection}${envSection}
          resources:
            limits:
              cpu: "${formCpuLimit}"
              memory: "${formMemLimit}"
            requests:
              cpu: "${formCpuReq}"
              memory: "${formMemReq}"`;

    setYamlDeployment(depYaml);

    // Service YAML Generation
    let svcAnnotations = "";
    if (annServiceName || annAllowAnon || annStopUnused) {
      svcAnnotations = "\n  annotations:";
      if (annServiceName) {
        svcAnnotations += `\n    eoxhub/service-name: "${annServiceName}"`;
      }
      if (annAllowAnon) {
        svcAnnotations += `\n    eoxhub/allow-anonymous: "true"`;
      }
      if (annStopUnused) {
        svcAnnotations += `\n    eoxhub/stop-if-unused: "true"`;
      }
    }

    const svcYaml = `apiVersion: v1
kind: Service
metadata:
  name: ${name}${svcAnnotations}
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: ${formPort}
      protocol: TCP
      name: http
  selector:
    app.kubernetes.io/service: ${name}`;

    setYamlService(svcYaml);

    // Ingress YAML Generation
    let ingYaml = "";
    if (formIsPublic) {
      ingYaml = generateIngressYaml(
        name,
        config?.defaults?.namespace || "default",
        config?.ingress
      );
      setYamlIngress(ingYaml);
    } else {
      setYamlIngress("");
    }

    return {
      deployment: depYaml,
      service: svcYaml,
      ingress: formIsPublic ? ingYaml : ""
    };
  };

  const handleSaveApplication = async (e: React.FormEvent) => {
    e.preventDefault();

    let appName = isEditing ? selectedAppName : formName.trim();
    if (!appName) {
      if (expertMode) {
        // Try to parse deployment name
        try {
          const parsed = YAML.parse(yamlDeployment);
          appName = parsed?.metadata?.name || "";
        } catch (e) {
          console.debug(
            "Failed to parse deployment name from raw YAML during sync",
            e
          );
        }
      }
    }

    if (!appName) {
      toast.error("Application name is required.");
      return;
    }

    let finalDeployment = yamlDeployment;
    let finalService = yamlService;
    let finalIngress = yamlIngress;

    // In Form mode, synchronize right before saving
    if (!expertMode) {
      const synced = syncFormToYaml(appName);
      finalDeployment = synced.deployment;
      finalService = synced.service;
      finalIngress = synced.ingress;
    }

    const saveToast = toast.loading("Saving application deployment...");
    try {
      const yamls: ApplicationYamls = {
        deployment: finalDeployment,
        service: finalService,
        ingress:
          formIsPublic || (expertMode && finalIngress)
            ? finalIngress
            : undefined
      };

      if (isEditing) {
        await updateApplication(appName, yamls);
        toast.success(`Application "${appName}" updated successfully.`, {
          id: saveToast
        });
      } else {
        await createApplication(appName, yamls);
        toast.success(`Application "${appName}" created successfully.`, {
          id: saveToast
        });
      }

      setShowFormModal(false);
      loadData();
    } catch (err: any) {
      const serverMsg =
        err.response?.data?.message || err.message || "Unknown error";
      toast.error(`Failed to save application: ${serverMsg}`, {
        id: saveToast
      });
    }
  };

  const getOverallStatusBadge = (appName: string) => {
    if (isAppDisabled(appName)) {
      return (
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500 border border-gray-300">
          Disabled
        </span>
      );
    }
    const status = statuses[appName];
    if (!status)
      return (
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-800">
          Pending
        </span>
      );
    if (!status.deployed)
      return (
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
          Waiting for Sync
        </span>
      );

    const pods = status.pods || [];
    if (pods.length === 0)
      return (
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
          Scaling
        </span>
      );

    const crashCount = pods.filter(
      (p) => p.phase === "Failed" || p.restarts > 3
    ).length;
    const runningCount = pods.filter((p) => p.phase === "Running").length;

    if (crashCount > 0) {
      return (
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
          Degraded ({crashCount} Pod Issues)
        </span>
      );
    }

    if (runningCount === pods.length) {
      return (
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800 flex items-center w-max">
          <CheckCircleIcon className="h-4 w-4 mr-1 text-green-600" /> Healthy (
          {runningCount}/{pods.length})
        </span>
      );
    }

    return (
      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
        Progressing
      </span>
    );
  };

  return (
    <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      {/* View Header */}
      <div className="flex justify-between items-center px-4 sm:px-0 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center">
            <CpuChipIcon className="h-7 w-7 mr-3 text-[#004170]" />
            Applications Management
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Deploy microservices and frontend apps. Managed automatically via
            GitOps and Kubernetes.
          </p>
        </div>
        <div className="flex space-x-3">
          <button
            onClick={loadData}
            disabled={refreshing}
            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#004170] transition-all"
          >
            <ArrowPathIcon
              className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          <button
            onClick={handleOpenNewModal}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-[#004170] hover:bg-[#002f54] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#004170] transition-all"
          >
            <PlusIcon className="h-4 w-4 mr-2" />
            New Application
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[#004170]"></div>
        </div>
      ) : apps.length === 0 ? (
        <div className="text-center bg-white shadow rounded-lg p-16">
          <CpuChipIcon className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            No applications
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Get started by creating a new microservice.
          </p>
          <div className="mt-6">
            <button
              onClick={handleOpenNewModal}
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-[#004170] hover:bg-[#002f54] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <PlusIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
              New Application
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white shadow overflow-hidden sm:rounded-lg">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Application Name
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Storage Files
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {apps.map((app) => (
                <tr
                  key={app.name}
                  className={`hover:bg-gray-50 transition-colors ${
                    isAppDisabled(app.name) ? "opacity-60 bg-gray-50/50" : ""
                  }`}
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0 h-10 w-10 flex items-center justify-center bg-blue-50 text-[#004170] rounded-lg">
                        <CpuChipIcon className="h-6 w-6" />
                      </div>
                      <div className="ml-4">
                        <div className="text-sm font-semibold text-gray-900">
                          {app.name}
                        </div>
                        <div className="text-xs text-gray-400">
                          Folder: applications/{app.name}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex space-x-1.5">
                      {app.files.map((file) => (
                        <span
                          key={file}
                          className="px-2 py-0.5 bg-gray-100 border border-gray-200 text-gray-600 rounded text-xs font-mono"
                        >
                          {file}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getOverallStatusBadge(app.name)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => handleOpenStatusModal(app.name)}
                      disabled={isAppDisabled(app.name)}
                      className={`inline-flex items-center mr-4 ${
                        isAppDisabled(app.name)
                          ? "text-gray-300 cursor-not-allowed"
                          : "text-[#004170] hover:text-[#002f54]"
                      }`}
                      title="Manage Status"
                    >
                      <DocumentMagnifyingGlassIcon className="h-5 w-5 mr-1" />
                      Manage
                    </button>
                    {isAppDisabled(app.name) ? (
                      <button
                        onClick={() => handleToggleDisableApp(app.name, true)}
                        className="text-green-600 hover:text-green-900 inline-flex items-center mr-4"
                        title="Enable Application"
                      >
                        <CheckCircleIcon className="h-4 w-4 mr-1" />
                        Enable
                      </button>
                    ) : (
                      <button
                        onClick={() => handleToggleDisableApp(app.name, false)}
                        className="text-orange-600 hover:text-orange-900 inline-flex items-center mr-4"
                        title="Disable Application"
                      >
                        <XMarkIcon className="h-4 w-4 mr-1" />
                        Disable
                      </button>
                    )}
                    <button
                      onClick={() => handleOpenEditModal(app.name)}
                      className="text-indigo-600 hover:text-indigo-900 inline-flex items-center mr-4"
                      title="Edit YAML config"
                    >
                      <PencilIcon className="h-4 w-4 mr-1" />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteApp(app.name)}
                      className="text-red-600 hover:text-red-900 inline-flex items-center"
                      title="Delete Application"
                    >
                      <TrashIcon className="h-4 w-4 mr-1" />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 1. Modal: Create / Edit Application */}
      {showFormModal && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto"
          aria-labelledby="modal-title"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
              onClick={() => setShowFormModal(false)}
            ></div>
            <span
              className="hidden sm:inline-block sm:align-middle sm:h-screen"
              aria-hidden="true"
            >
              &#8203;
            </span>
            <div className="inline-block align-middle bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-4xl sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4 border-b border-gray-200">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg leading-6 font-bold text-gray-900 flex items-center">
                    <CpuChipIcon className="h-6 w-6 mr-2 text-[#004170]" />
                    {isEditing
                      ? `Edit Application: ${selectedAppName}`
                      : "Deploy New Application"}
                  </h3>
                  <button
                    onClick={() => setShowFormModal(false)}
                    className="text-gray-400 hover:text-gray-500"
                  >
                    <XMarkIcon className="h-6 w-6" />
                  </button>
                </div>
              </div>

              <form onSubmit={handleSaveApplication}>
                <div className="bg-white px-6 py-4">
                  {/* Mode Selector */}
                  {(!isEditing || isParseable) && (
                    <div className="flex justify-between items-center mb-6 border-b border-gray-100 pb-4">
                      <span className="text-sm font-semibold text-gray-700">
                        {isEditing ? "Configuration Mode:" : "Creation Method:"}
                      </span>
                      <div className="relative z-0 inline-flex shadow-sm rounded-md">
                        <button
                          type="button"
                          onClick={() => {
                            setExpertMode(false);
                          }}
                          className={`relative inline-flex items-center px-4 py-2 rounded-l-md border text-sm font-medium ${
                            !expertMode
                              ? "bg-indigo-50 border-indigo-500 text-indigo-700 z-10"
                              : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          Guided Form
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setExpertMode(true);
                            syncFormToYaml();
                          }}
                          className={`relative inline-flex items-center px-4 py-2 rounded-r-md border border-l-0 text-sm font-medium ${
                            expertMode
                              ? "bg-indigo-50 border-indigo-500 text-indigo-700 z-10"
                              : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          Expert Mode (YAML)
                        </button>
                      </div>
                    </div>
                  )}

                  {!expertMode ? (
                    /* GUIDED FORM MODE */
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-y-4 gap-x-4 sm:grid-cols-6">
                        <div className="sm:col-span-3">
                          <label className="block text-sm font-medium text-gray-700">
                            Application Name
                          </label>
                          <input
                            type="text"
                            required
                            disabled={isEditing}
                            value={formName}
                            onChange={(e) =>
                              setFormName(
                                e.target.value
                                  .toLowerCase()
                                  .replace(/[^a-z0-9-]/g, "")
                              )
                            }
                            placeholder="e.g. data-analyzer"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                          />
                        </div>

                        <div className="sm:col-span-3">
                          <label className="block text-sm font-medium text-gray-700">
                            Docker Image
                          </label>
                          <input
                            type="text"
                            required
                            value={formImage}
                            onChange={(e) => setFormImage(e.target.value)}
                            placeholder="e.g. ghcr.io/org/image:v1.0.0"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                          />
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-sm font-medium text-gray-700">
                            Container Port
                          </label>
                          <input
                            type="number"
                            required
                            value={formPort}
                            onChange={(e) =>
                              setFormPort(Number(e.target.value))
                            }
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                          />
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-sm font-medium text-gray-700">
                            CPU Limit
                          </label>
                          <input
                            type="text"
                            required
                            value={formCpuLimit}
                            onChange={(e) => setFormCpuLimit(e.target.value)}
                            placeholder="e.g. 1"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                          />
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-sm font-medium text-gray-700">
                            Memory Limit
                          </label>
                          <input
                            type="text"
                            required
                            value={formMemLimit}
                            onChange={(e) => setFormMemLimit(e.target.value)}
                            placeholder="e.g. 2Gi"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                          />
                        </div>
                      </div>

                      {/* EOXHub Integrations */}
                      <div className="border-t border-gray-100 pt-4 mt-4">
                        <h4 className="text-sm font-bold text-gray-800 mb-3">
                          EOXHub Portal Configuration
                        </h4>
                        <div className="grid grid-cols-1 gap-y-4 gap-x-4 sm:grid-cols-6">
                          <div className="sm:col-span-6">
                            <label className="block text-sm font-medium text-gray-700">
                              Human Readable Service Name
                            </label>
                            <input
                              type="text"
                              value={annServiceName}
                              onChange={(e) =>
                                setAnnServiceName(e.target.value)
                              }
                              placeholder="e.g. Science Dashboard Tool"
                              className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                            />
                          </div>

                          <div className="sm:col-span-3 flex items-center">
                            <input
                              id="annAllowAnon"
                              type="checkbox"
                              checked={annAllowAnon}
                              onChange={(e) =>
                                setAnnAllowAnon(e.target.checked)
                              }
                              className="h-4 w-4 text-[#004170] focus:ring-[#004170] border-gray-300 rounded"
                            />
                            <label
                              htmlFor="annAllowAnon"
                              className="ml-2 block text-sm font-medium text-gray-700"
                            >
                              Allow Anonymous Access (Public API)
                            </label>
                          </div>

                          <div className="sm:col-span-3 flex items-center">
                            <input
                              id="annStopUnused"
                              type="checkbox"
                              checked={annStopUnused}
                              onChange={(e) =>
                                setAnnStopUnused(e.target.checked)
                              }
                              className="h-4 w-4 text-[#004170] focus:ring-[#004170] border-gray-300 rounded"
                            />
                            <label
                              htmlFor="annStopUnused"
                              className="ml-2 block text-sm font-medium text-gray-700"
                            >
                              Auto-Stop when unused (Gateway scale-to-zero)
                            </label>
                          </div>
                        </div>
                      </div>

                      {/* Ingress Toggle */}
                      {config?.allowPublicIngress && (
                        <div className="border-t border-gray-100 pt-4 mt-4">
                          <div className="flex items-center">
                            <input
                              id="formIsPublic"
                              type="checkbox"
                              checked={formIsPublic}
                              onChange={(e) =>
                                setFormIsPublic(e.target.checked)
                              }
                              className="h-4 w-4 text-[#004170] focus:ring-[#004170] border-gray-300 rounded"
                            />
                            <label
                              htmlFor="formIsPublic"
                              className="ml-2 block text-sm font-medium text-gray-700"
                            >
                              Expose Publicly via Ingress (Creates ingress.yaml)
                            </label>
                          </div>
                        </div>
                      )}

                      {/* Environment Variables */}
                      <div className="border-t border-gray-100 pt-4 mt-4">
                        <div className="flex justify-between items-center mb-2">
                          <label className="block text-sm font-medium text-gray-700">
                            Environment Variables
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setFormEnv([...formEnv, { key: "", value: "" }])
                            }
                            className="inline-flex items-center px-2 py-1 border border-gray-300 shadow-sm text-xs font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none"
                          >
                            <PlusIcon className="h-3 w-3 mr-1 text-gray-500" />
                            Add
                          </button>
                        </div>
                        {formEnv.length === 0 ? (
                          <p className="text-xs text-gray-400 italic">
                            No environment variables defined.
                          </p>
                        ) : (
                          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                            {formEnv.map((env, idx) => (
                              <div
                                key={idx}
                                className="flex items-center space-x-2"
                              >
                                <input
                                  type="text"
                                  value={env.key}
                                  onChange={(e) => {
                                    const updated = [...formEnv];
                                    updated[idx].key = e.target.value
                                      .toUpperCase()
                                      .replace(/[^A-Z0-9_]/g, "");
                                    setFormEnv(updated);
                                  }}
                                  placeholder="KEY"
                                  className="block w-1/2 border border-gray-300 rounded-md shadow-sm py-1.5 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                                />
                                <input
                                  type="text"
                                  value={env.value}
                                  onChange={(e) => {
                                    const updated = [...formEnv];
                                    updated[idx].value = e.target.value;
                                    setFormEnv(updated);
                                  }}
                                  placeholder="Value"
                                  className="block w-1/2 border border-gray-300 rounded-md shadow-sm py-1.5 px-3 focus:outline-none focus:ring-[#004170] focus:border-[#004170] sm:text-sm"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setFormEnv(
                                      formEnv.filter((_, i) => i !== idx)
                                    )
                                  }
                                  className="text-red-500 hover:text-red-700 p-1"
                                >
                                  <TrashIcon className="h-4 w-4" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Command / Arguments */}
                      <div className="border-t border-gray-100 pt-4 mt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Container Start Command
                        </label>
                        <div
                          className="border border-gray-300 rounded-md overflow-hidden"
                          style={{ height: "120px" }}
                        >
                          <Editor
                            height="100%"
                            language="shell"
                            theme="vs-light"
                            value={formCommand}
                            onChange={(val) => setFormCommand(val || "")}
                            options={{
                              minimap: { enabled: false },
                              lineNumbers: "off",
                              glyphMargin: false,
                              folding: false,
                              lineDecorationsWidth: 0,
                              lineNumbersMinChars: 0,
                              fontSize: 13,
                              wordWrap: "on"
                            }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-gray-400">
                          Enter any startup command. Multi-line commands will
                          run as a shell script using `/bin/sh -c`.
                        </p>
                      </div>
                    </div>
                  ) : (
                    /* EXPERT MODE (YAML EDITOR) */
                    <div>
                      {/* Tabs */}
                      <div className="flex border-b border-gray-200 mb-4">
                        <button
                          type="button"
                          onClick={() => setActiveYamlTab("deployment")}
                          className={`py-2 px-4 border-b-2 font-medium text-sm transition-colors ${
                            activeYamlTab === "deployment"
                              ? "border-indigo-500 text-indigo-600"
                              : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                          }`}
                        >
                          deployment.yaml
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveYamlTab("service")}
                          className={`py-2 px-4 border-b-2 font-medium text-sm transition-colors ${
                            activeYamlTab === "service"
                              ? "border-indigo-500 text-indigo-600"
                              : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                          }`}
                        >
                          service.yaml
                        </button>
                        {config?.allowPublicIngress && (
                          <button
                            type="button"
                            onClick={() => setActiveYamlTab("ingress")}
                            className={`py-2 px-4 border-b-2 font-medium text-sm transition-colors ${
                              activeYamlTab === "ingress"
                                ? "border-indigo-500 text-indigo-600"
                                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                            }`}
                          >
                            ingress.yaml
                          </button>
                        )}
                      </div>

                      {/* Code Editors */}
                      <div
                        className="border border-gray-300 rounded-md overflow-hidden"
                        style={{ height: "400px" }}
                      >
                        {activeYamlTab === "deployment" && (
                          <Editor
                            height="100%"
                            language="yaml"
                            theme="vs-light"
                            value={yamlDeployment}
                            onChange={(val) => setYamlDeployment(val || "")}
                            options={{
                              minimap: { enabled: false },
                              fontSize: 13
                            }}
                          />
                        )}
                        {activeYamlTab === "service" && (
                          <Editor
                            height="100%"
                            language="yaml"
                            theme="vs-light"
                            value={yamlService}
                            onChange={(val) => setYamlService(val || "")}
                            options={{
                              minimap: { enabled: false },
                              fontSize: 13
                            }}
                          />
                        )}
                        {activeYamlTab === "ingress" && (
                          <Editor
                            height="100%"
                            language="yaml"
                            theme="vs-light"
                            value={yamlIngress}
                            onChange={(val) => setYamlIngress(val || "")}
                            options={{
                              minimap: { enabled: false },
                              fontSize: 13
                            }}
                          />
                        )}
                      </div>
                      <p className="mt-2 text-xs text-gray-400">
                        * Note: Metadata namespace, app labeling, and
                        matchSelectors are strictly validated and injected on
                        the server side to ensure safety and isolation in{" "}
                        {config?.defaults.namespace || "the workspace"}.
                      </p>
                    </div>
                  )}
                </div>

                <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse border-t border-gray-200">
                  <button
                    type="submit"
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-[#004170] text-base font-medium text-white hover:bg-[#002f54] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#004170] sm:ml-3 sm:w-auto sm:text-sm"
                  >
                    Save & Deploy (Commit)
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowFormModal(false)}
                    className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* 2. Modal: Status & Pod Management */}
      {showStatusModal && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto"
          aria-labelledby="modal-title"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
              onClick={() => setShowStatusModal(false)}
            ></div>
            <span
              className="hidden sm:inline-block sm:align-middle sm:h-screen"
              aria-hidden="true"
            >
              &#8203;
            </span>
            <div className="inline-block align-middle bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-3xl sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4 border-b border-gray-200">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg leading-6 font-bold text-gray-900 flex items-center">
                    <DocumentMagnifyingGlassIcon className="h-6 w-6 mr-2 text-[#004170]" />
                    Application Status: {selectedAppName}
                  </h3>
                  <button
                    onClick={() => setShowStatusModal(false)}
                    className="text-gray-400 hover:text-gray-500"
                  >
                    <XMarkIcon className="h-6 w-6" />
                  </button>
                </div>
              </div>

              <div className="bg-white px-6 py-4 space-y-6">
                {/* 1. K8s Controller Sync Check */}
                <div>
                  <h4 className="text-sm font-bold text-gray-800 border-b border-gray-100 pb-2 mb-3">
                    Reconciliation Status
                  </h4>
                  {statuses[selectedAppName] ? (
                    statuses[selectedAppName].deployed ? (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-md flex items-start">
                        <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2 flex-shrink-0 mt-0.5" />
                        <div>
                          <div className="text-sm font-semibold text-green-800">
                            Deployment Active
                          </div>
                          <div className="text-xs text-green-600 mt-0.5">
                            Kubernetes resources successfully created. Ready
                            replicas:{" "}
                            {statuses[selectedAppName].deployment
                              ?.readyReplicas || 0}{" "}
                            /{" "}
                            {statuses[selectedAppName].deployment?.replicas ||
                              0}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md flex items-start">
                        <ExclamationTriangleIcon className="h-5 w-5 text-yellow-500 mr-2 flex-shrink-0 mt-0.5" />
                        <div>
                          <div className="text-sm font-semibold text-yellow-800">
                            Synchronizing...
                          </div>
                          <div className="text-xs text-yellow-600 mt-0.5">
                            Git changes pushed. Waiting for the cluster GitOps
                            operator (Argo CD or flux) to synchronize files.
                          </div>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="p-3 bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-500">
                      Loading synchronization status...
                    </div>
                  )}
                </div>

                {/* 2. Reconciliation Issues / Deployment Conditions */}
                {statuses[selectedAppName]?.deployment?.conditions &&
                  statuses[selectedAppName].deployment!.conditions.length >
                    0 && (
                    <div>
                      <h4 className="text-sm font-bold text-gray-800 border-b border-gray-100 pb-2 mb-3">
                        System Warnings / Conditions
                      </h4>
                      <div className="space-y-1.5">
                        {statuses[selectedAppName].deployment!.conditions.map(
                          (cond, idx) => {
                            const isIssue =
                              cond.status === "False" ||
                              cond.type === "ReplicaFailure";
                            return (
                              <div
                                key={idx}
                                className={`p-2.5 rounded text-xs border ${
                                  isIssue
                                    ? "bg-red-50 border-red-200 text-red-700"
                                    : "bg-gray-50 border-gray-200 text-gray-600"
                                }`}
                              >
                                <span className="font-semibold">
                                  {cond.type}
                                </span>{" "}
                                ({cond.status}): {cond.message}
                              </div>
                            );
                          }
                        )}
                      </div>
                    </div>
                  )}

                {/* 3. Pods List */}
                <div>
                  <h4 className="text-sm font-bold text-gray-800 border-b border-gray-100 pb-2 mb-3">
                    Active Pods & Logs
                  </h4>
                  {statuses[selectedAppName]?.pods &&
                  statuses[selectedAppName].pods.length > 0 ? (
                    <div className="space-y-3">
                      {statuses[selectedAppName].pods.map((pod) => (
                        <div
                          key={pod.name}
                          className="p-3 border border-gray-200 rounded-md flex items-center justify-between hover:bg-gray-50 transition-colors"
                        >
                          <div>
                            <div className="text-sm font-semibold text-gray-900 font-mono">
                              {pod.name}
                            </div>
                            <div className="flex items-center space-x-3 mt-1.5 text-xs text-gray-500">
                              <span>
                                Phase:{" "}
                                <span
                                  className={`font-semibold ${pod.phase === "Running" ? "text-green-600" : "text-yellow-600"}`}
                                >
                                  {pod.phase}
                                </span>
                              </span>
                              <span>&bull;</span>
                              <span>
                                Restarts:{" "}
                                <span className="font-semibold text-gray-700">
                                  {pod.restarts}
                                </span>
                              </span>
                              <span>&bull;</span>
                              <span>
                                Age:{" "}
                                {pod.age
                                  ? new Date(pod.age).toLocaleString()
                                  : "Unknown"}
                              </span>
                            </div>
                          </div>
                          <div className="flex space-x-2">
                            <button
                              onClick={() => handleViewLogs(pod.name)}
                              className="inline-flex items-center px-2.5 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 focus:outline-none"
                            >
                              <EyeIcon className="h-4 w-4 mr-1 text-gray-500" />
                              View Logs
                            </button>
                            <button
                              onClick={() => handlePodRestart(pod.name)}
                              className="inline-flex items-center px-2.5 py-1.5 border border-red-300 text-xs font-medium rounded text-red-700 bg-white hover:bg-red-50 focus:outline-none"
                            >
                              <ArrowPathIcon className="h-4 w-4 mr-1 text-red-500" />
                              Restart
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center p-6 border border-dashed border-gray-300 rounded-md text-sm text-gray-500">
                      No active pods found. The service might be shut down or
                      syncing.
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setShowStatusModal(false)}
                  className="w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:w-auto sm:text-sm"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. Modal: Logs Viewer */}
      {showLogModal && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto"
          aria-labelledby="modal-title"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
              onClick={() => setShowLogModal(false)}
            ></div>
            <span
              className="hidden sm:inline-block sm:align-middle sm:h-screen"
              aria-hidden="true"
            >
              &#8203;
            </span>
            <div className="inline-block align-middle bg-gray-900 rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-5xl sm:w-full">
              <div className="bg-gray-800 px-4 py-3 border-b border-gray-700 flex justify-between items-center">
                <div className="flex items-center text-gray-200">
                  <ArrowPathIcon
                    className={`h-5 w-5 mr-2 text-indigo-400 ${logsLoading ? "animate-spin" : ""}`}
                  />
                  <span className="text-sm font-semibold">
                    Pod Logs:{" "}
                    <span className="font-mono text-xs">{logPodName}</span>
                  </span>
                </div>
                <div className="flex items-center space-x-3">
                  <button
                    onClick={() => handleViewLogs(logPodName)}
                    className="p-1 text-gray-400 hover:text-white"
                    title="Refresh logs"
                  >
                    <ArrowPathIcon className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => setShowLogModal(false)}
                    className="text-gray-400 hover:text-white"
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="p-4 bg-gray-950" style={{ height: "450px" }}>
                <pre className="h-full overflow-y-auto text-xs text-green-400 font-mono p-3 bg-gray-950 rounded whitespace-pre-wrap select-text">
                  {logsText}
                </pre>
              </div>

              <div className="bg-gray-800 px-4 py-3 sm:flex sm:flex-row-reverse border-t border-gray-700">
                <button
                  type="button"
                  onClick={() => setShowLogModal(false)}
                  className="w-full inline-flex justify-center rounded-md border border-gray-700 shadow-sm px-4 py-2 bg-gray-700 text-xs font-medium text-gray-200 hover:bg-gray-600 sm:w-auto"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApplicationsView;
