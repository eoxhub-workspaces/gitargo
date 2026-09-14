import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import toast from "react-hot-toast";
import { validateK8sYaml } from "../../utils/k8sValidation";
import {
  CloudArrowUpIcon,
  ClockIcon,
  PlayIcon,
  ServerStackIcon,
  Cog8ToothIcon
} from "@heroicons/react/20/solid";
import YAML from "yaml";

import * as api from "../../utils/api";
import { useTitle } from "../../hooks";
import Header from "../global/Header";
import CodeEditor from "../CodeEditor";
import { SubmitWorkflowModal } from "../modals/SubmitWorkflowModal";
import {
  ResourcePlacementForm,
  IResourcePlacementState
} from "../global/ResourcePlacementForm";

const extractResourcesAndScheduling = (
  parsed: any
): IResourcePlacementState => {
  if (!parsed) {
    return {
      namespace: "",
      serviceAccount: "",
      cpuRequest: "",
      cpuLimit: "",
      memoryRequest: "",
      memoryLimit: "",
      gpuLimit: "",
      tolerations: [],
      nodeSelector: {}
    };
  }

  const isCron = parsed.kind === "CronWorkflow";
  const spec = isCron ? parsed.spec?.workflowSpec : parsed.spec;

  const state: IResourcePlacementState = {
    namespace: parsed.metadata?.namespace || "",
    serviceAccount: spec?.serviceAccountName || spec?.serviceAccount || "",
    cpuRequest: "",
    cpuLimit: "",
    memoryRequest: "",
    memoryLimit: "",
    gpuLimit: "",
    tolerations: spec?.tolerations || [],
    nodeSelector: spec?.nodeSelector || {}
  };

  if (spec) {
    const entrypointName = spec.entrypoint;
    if (entrypointName && spec.templates) {
      const entryTemplate = spec.templates.find(
        (t: any) => t.name === entrypointName
      );
      if (entryTemplate) {
        const containerKey = entryTemplate.container
          ? "container"
          : entryTemplate.script
            ? "script"
            : null;
        if (containerKey) {
          const target = entryTemplate[containerKey];
          const resources = target?.resources || {};

          state.cpuRequest = resources.requests?.cpu || "";
          state.cpuLimit = resources.limits?.cpu || "";
          state.memoryRequest = resources.requests?.memory || "";
          state.memoryLimit = resources.limits?.memory || "";
          state.gpuLimit = resources.limits?.["nvidia.com/gpu"] || "";
        }
      }
    }
  }
  return state;
};

const injectResourcesAndScheduling = (
  parsed: any,
  state: IResourcePlacementState
) => {
  if (!parsed) return parsed;
  const isCron = parsed.kind === "CronWorkflow";

  // Inject Namespace
  if (!parsed.metadata) parsed.metadata = {};
  if (state.namespace) {
    parsed.metadata.namespace = state.namespace;
  } else {
    delete parsed.metadata.namespace;
  }

  if (!parsed.spec) parsed.spec = {};

  if (isCron && !parsed.spec.workflowSpec) {
    parsed.spec.workflowSpec = {};
  }
  const spec = isCron ? parsed.spec.workflowSpec : parsed.spec;

  // 0. Inject ServiceAccountName and clean up deprecated serviceAccount
  if (state.serviceAccount) {
    spec.serviceAccountName = state.serviceAccount;
    delete spec.serviceAccount;
  } else {
    delete spec.serviceAccountName;
    delete spec.serviceAccount;
  }

  // 1. Inject global Tolerations
  if (state.tolerations.length > 0) {
    spec.tolerations = state.tolerations;
  } else {
    delete spec.tolerations;
  }

  // 2. Inject global NodeSelector
  if (Object.keys(state.nodeSelector).length > 0) {
    spec.nodeSelector = state.nodeSelector;
  } else {
    delete spec.nodeSelector;
  }

  // 3. Inject Resources into Entrypoint Template
  const entrypointName = spec.entrypoint;
  if (entrypointName && spec.templates) {
    let entryTemplate = spec.templates.find(
      (t: any) => t.name === entrypointName
    );
    if (!entryTemplate) {
      // If template not found, create a placeholder main template
      entryTemplate = {
        name: entrypointName,
        container: {
          image: "alpine:latest",
          command: ["sh", "-c"],
          args: ["echo Hello World"]
        }
      };
      spec.templates.push(entryTemplate);
    }

    const containerKey = entryTemplate.container
      ? "container"
      : entryTemplate.script
        ? "script"
        : "container";
    if (!entryTemplate[containerKey]) {
      entryTemplate[containerKey] = {};
    }
    const target = entryTemplate[containerKey];
    if (!target.resources) target.resources = {};
    if (!target.resources.requests) target.resources.requests = {};
    if (!target.resources.limits) target.resources.limits = {};

    // CPU
    if (state.cpuRequest) target.resources.requests.cpu = state.cpuRequest;
    else delete target.resources.requests.cpu;

    if (state.cpuLimit) target.resources.limits.cpu = state.cpuLimit;
    else delete target.resources.limits.cpu;

    // Memory
    if (state.memoryRequest)
      target.resources.requests.memory = state.memoryRequest;
    else delete target.resources.requests.memory;

    if (state.memoryLimit) target.resources.limits.memory = state.memoryLimit;
    else delete target.resources.limits.memory;

    // GPU
    if (state.gpuLimit) {
      target.resources.limits["nvidia.com/gpu"] = state.gpuLimit;
    } else {
      delete target.resources.limits["nvidia.com/gpu"];
    }

    // Clean up empty objects
    if (Object.keys(target.resources.requests).length === 0)
      delete target.resources.requests;
    if (Object.keys(target.resources.limits).length === 0)
      delete target.resources.limits;
    if (Object.keys(target.resources).length === 0) delete target.resources;
  }
  return parsed;
};

export default function CodeProject() {
  const { filename } = useParams<{ filename?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const initialName = queryParams.get("name") || undefined;
  const initialKind = queryParams.get("kind") || "WorkflowTemplate";
  const initialProfile = queryParams.get("profile") || "";
  const initialEphemeral = queryParams.get("ephemeral") === "true";
  const initialEphemeralSize = queryParams.get("ephemeralSize") || "2Gi";

  const [currentFilename, setCurrentFilename] = useState(
    filename || initialName
  );
  const [yamlContent, setYamlContent] = useState<string>("");
  const [originalYaml, setOriginalYaml] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [config, setConfig] = useState<api.AppConfig | null>(null);
  const [executions, setExecutions] = useState<api.WorkflowExecution[]>([]);
  const [history, setHistory] = useState<api.CommitHistory[]>([]);
  const [activePanel, setActivePanel] = useState<"runs" | "history" | null>(
    filename ? "runs" : null
  );
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [ignoreWarningsChecked, setIgnoreWarningsChecked] = useState(false);
  const [executingWorkflow, setExecutingWorkflow] = useState<any | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [schedulingState, setSchedulingState] =
    useState<IResourcePlacementState>({
      namespace: "",
      serviceAccount: "",
      cpuRequest: "",
      cpuLimit: "",
      memoryRequest: "",
      memoryLimit: "",
      gpuLimit: "",
      tolerations: [],
      nodeSelector: {}
    });

  useEffect(() => {
    try {
      if (yamlContent) {
        const parsed = YAML.parse(yamlContent);
        const extracted = extractResourcesAndScheduling(parsed);
        setSchedulingState(extracted);
      }
    } catch (e) {
      // Ignore parse errors during active editing
    }
  }, [yamlContent]);

  const checkHasWarnings = (parsed: any) => {
    if (!parsed) return false;
    const isCron = parsed.kind === "CronWorkflow";
    const spec = isCron ? parsed.spec?.workflowSpec : parsed.spec;
    const defaultNamespace = config?.defaults?.namespace || "default";

    // 0. Namespace is missing or mismatched
    const namespace = parsed.metadata?.namespace || "";
    if (!namespace || namespace !== defaultNamespace) {
      return true;
    }

    const defaultServiceAccount = config?.defaults?.serviceAccount || "default";

    // 1. Service account is missing or mismatched
    const serviceAccount =
      spec?.serviceAccountName || spec?.serviceAccount || "";
    if (!serviceAccount || serviceAccount !== defaultServiceAccount) {
      return true;
    }

    // 2. Unsupported tolerations
    const tolerations = spec?.tolerations || [];
    const availableTols = config?.availableTolerations || [];
    const hasUnsupportedTols = tolerations.some(
      (t: any) => !availableTols.some((at) => at.key === t.key)
    );
    if (hasUnsupportedTols) return true;

    // 3. Unsupported node selectors
    const nodeSelector = spec?.nodeSelector || {};
    const availableSelectors = config?.availableNodeSelectors || [];
    const hasUnsupportedSelectors = Object.entries(nodeSelector).some(
      ([key, value]) =>
        !availableSelectors.some((as) => as.key === key && as.value === value)
    );
    if (hasUnsupportedSelectors) return true;

    return false;
  };

  const handleReviewClick = () => {
    try {
      const parsed = YAML.parse(yamlContent);
      const extracted = extractResourcesAndScheduling(parsed);
      setSchedulingState(extracted);
    } catch (e) {
      console.warn("Failed to parse latest YAML on review click", e);
    }
    setShowWarningModal(false);
    setShowSettingsModal(true); // Open the settings panel!
  };

  const handleOpenSettingsClick = () => {
    try {
      const parsed = YAML.parse(yamlContent);
      const extracted = extractResourcesAndScheduling(parsed);
      setSchedulingState(extracted);
    } catch (e: any) {
      toast.error(
        "Please resolve any YAML syntax errors before opening settings: " +
          e.message
      );
      return;
    }
    setShowSettingsModal(true);
  };

  const handleSaveAnywayClick = () => {
    let finalContent = yamlContent;
    if (ignoreWarningsChecked) {
      try {
        const parsed = YAML.parse(yamlContent);
        if (!parsed.metadata) parsed.metadata = {};
        if (!parsed.metadata.annotations) parsed.metadata.annotations = {};
        parsed.metadata.annotations["gitargo.eox.at/ignore-warnings"] = "true";
        finalContent = YAML.stringify(parsed);
        setYamlContent(finalContent);
      } catch (e) {
        console.error("Failed to add ignore warnings annotation", e);
      }
    }
    setShowWarningModal(false);
    executeSave(finalContent, runAfterSaveAction);
  };

  useTitle([currentFilename || "New workflow", "Code Mode"].join(" | "));

  const isNewWorkflow = !filename && !!initialName;

  const fetchExecutions = async () => {
    if (!filename) return;
    try {
      const data = await api.getExecutions();
      const logicalName = decodeURIComponent(filename)
        .split("/")
        .pop()
        ?.replace(/\.ya?ml$/i, "");

      const filtered = data.filter((exe) => {
        const tplLabel =
          exe.metadata.labels?.["workflows.argoproj.io/workflow-template"];
        const cronLabel =
          exe.metadata.labels?.["workflows.argoproj.io/cron-workflow"];

        return (
          tplLabel === logicalName ||
          cronLabel === logicalName ||
          exe.metadata.name.startsWith(`${logicalName}-`)
        );
      });

      // Sort newest first
      filtered.sort(
        (a, b) =>
          new Date(b.metadata.creationTimestamp).getTime() -
          new Date(a.metadata.creationTimestamp).getTime()
      );

      setExecutions(filtered);
    } catch (err: any) {
      console.error("Failed to fetch executions:", err);
    }
  };

  const fetchHistory = async () => {
    if (!filename) return;
    try {
      const data = await api.getWorkflowHistory(decodeURIComponent(filename));
      setHistory(data || []);
    } catch (err: any) {
      console.error("Failed to fetch history:", err);
    }
  };

  useEffect(() => {
    fetchExecutions();
    fetchHistory();
    const interval = setInterval(fetchExecutions, 10000);
    return () => clearInterval(interval);
  }, [filename]);

  useEffect(() => {
    const init = async () => {
      try {
        const appConfig = await api.getConfig();
        setConfig(appConfig);

        if (filename) {
          const content = await api.getWorkflow(decodeURIComponent(filename));
          setYamlContent(content);
          setOriginalYaml(content);
        } else if (initialName) {
          const logicalInitialName = initialName.replace(/\.ya?ml$/i, "");
          const isCron = initialKind === "CronWorkflow";

          const skeleton: any = {
            apiVersion: "argoproj.io/v1alpha1",
            kind: initialKind,
            metadata: {
              name: logicalInitialName
            },
            spec: isCron
              ? {
                  schedule: "0 0 * * *",
                  workflowSpec: {
                    entrypoint: "execute",
                    templates: []
                  }
                }
              : {
                  entrypoint: "execute",
                  templates: []
                }
          };

          const spec = isCron ? skeleton.spec.workflowSpec : skeleton.spec;

          // 1. Inject default Service Account
          if (appConfig.defaults?.serviceAccount) {
            spec.serviceAccountName = appConfig.defaults.serviceAccount;
          }

          // 2. Fetch selected profile resources & tolerations
          let selectedProfileData = null;
          if (initialProfile && appConfig.profiles?.[initialProfile]) {
            selectedProfileData = appConfig.profiles[initialProfile];
          }

          if (selectedProfileData) {
            // Tolerations
            if (selectedProfileData.tolerations) {
              spec.tolerations = selectedProfileData.tolerations;
            }
            // Node Selector
            if (selectedProfileData.nodeSelector) {
              spec.nodeSelector = selectedProfileData.nodeSelector;
            }
            // Affinity
            if (selectedProfileData.affinity) {
              spec.affinity = selectedProfileData.affinity;
            }
          }

          // 3. Create main template
          const mainTemplate: any = {
            name: "execute",
            container: {
              image: "alpine:latest",
              command: ["sh", "-c"],
              args: ["echo Hello World"]
            }
          };

          if (selectedProfileData?.resources) {
            mainTemplate.container.resources = selectedProfileData.resources;
          }

          // 4. Inject Ephemeral Volume Claim template
          if (initialEphemeral && appConfig.ephemeralVolume) {
            const vol = appConfig.ephemeralVolume;
            mainTemplate.container.volumeMounts = [
              {
                name: vol.name,
                mountPath: vol.mountPath
              }
            ];

            spec.volumeClaimTemplates = [
              {
                metadata: {
                  name: vol.name
                },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  resources: {
                    requests: {
                      storage: initialEphemeralSize || vol.storage
                    }
                  }
                }
              }
            ];
          }

          spec.templates = [mainTemplate];

          const baseYaml = YAML.stringify(skeleton);
          setYamlContent(baseYaml);
          setOriginalYaml(baseYaml);
        }
      } catch (err: any) {
        const msg =
          err.response?.data?.message ||
          err.message ||
          "Failed to load workflow or configuration";
        toast.error(msg, { duration: 6000 });
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [
    filename,
    initialKind,
    initialName,
    initialProfile,
    initialEphemeral,
    initialEphemeralSize
  ]);

  const [runAfterSaveAction, setRunAfterSaveAction] = useState(false);

  const hasChanges = isNewWorkflow || yamlContent !== originalYaml;

  const handleSaveSettings = () => {
    try {
      const parsed = YAML.parse(yamlContent);
      const updated = injectResourcesAndScheduling(parsed, schedulingState);
      setYamlContent(YAML.stringify(updated));
      setShowSettingsModal(false);
      toast.success("Workflow scheduling and resources updated!");
    } catch (e: any) {
      toast.error("Failed to parse and update YAML: " + e.message);
    }
  };

  const handleSaveAndRunClick = () => {
    handleSaveClick(true);
  };

  const handleRunOnlyClick = async () => {
    try {
      let parsed = YAML.parse(yamlContent);

      // If it's a CronWorkflow, we must extract the workflowSpec to run it immediately
      if (parsed.kind === "CronWorkflow") {
        parsed = {
          apiVersion: parsed.apiVersion || "argoproj.io/v1alpha1",
          kind: "Workflow",
          metadata: {
            generateName: (parsed.metadata.name || "cron") + "-",
            namespace: parsed.metadata.namespace,
            labels: {
              ...parsed.metadata.labels,
              "workflows.argoproj.io/cron-workflow": parsed.metadata.name,
              "workflows.argoproj.io/workflow-template": parsed.metadata.name
            }
          },
          spec: parsed.spec?.workflowSpec || {}
        };
      }

      const params = parsed?.spec?.arguments?.parameters || [];
      if (params.length > 0) {
        setExecutingWorkflow(parsed);
      } else {
        await finalizeSubmission(parsed);
      }
    } catch (err: any) {
      toast.error(`Execution failed: ${err.message || "Unknown error"}`);
    }
  };

  const handleSaveClick = async (runAfterSave = false) => {
    const name = currentFilename;
    if (!name) {
      toast.error("Filename is required.");
      return;
    }

    try {
      validateK8sYaml(yamlContent);
    } catch (e: any) {
      toast.error(`Validation Error: ${e.message}`, { duration: 5000 });
      return;
    }

    try {
      const parsed = YAML.parse(yamlContent);
      const annotations = parsed.metadata?.annotations || {};

      const ignoreWarnings =
        annotations["gitargo.eox.at/ignore-warnings"] === "true" ||
        annotations["gitargo.eox.at/ignore-defaults"] === "true"; // Maintain legacy support

      if (!ignoreWarnings && checkHasWarnings(parsed)) {
        setRunAfterSaveAction(runAfterSave);
        setShowWarningModal(true);
        return;
      }

      executeSave(yamlContent, runAfterSave);
    } catch (e) {
      executeSave(yamlContent, runAfterSave);
    }
  };

  const finalizeSubmission = async (workflow: any) => {
    const submitToast = toast.loading("Submitting execution...");
    try {
      await api.submitExecution(workflow);
      toast.success("Execution submitted successfully!", { id: submitToast });
      setExecutingWorkflow(null);
      if (activePanel !== "runs") setActivePanel("runs");
      setTimeout(fetchExecutions, 1000);
    } catch (error: any) {
      toast.error(`Submission failed: ${error.message || "Unknown error"}`, {
        id: submitToast
      });
    }
  };

  const executeSave = async (contentToSave: string, runAfterSave = false) => {
    const name = currentFilename;
    if (!name) return;

    const saveToast = toast.loading("Saving workflow...");
    const finalContent = contentToSave;

    try {
      if (!isNewWorkflow) {
        await api.updateWorkflow(
          name,
          contentToSave,
          `Update ${name} via Code Editor`,
          false
        );
      } else {
        await api.createWorkflow(
          name,
          contentToSave,
          `Create ${name} via Code Editor`,
          false
        );
        setCurrentFilename(name);
        navigate(`/edit/${encodeURIComponent(name)}`, { replace: true });
      }

      toast.success("Workflow saved successfully!", { id: saveToast });
      setShowWarningModal(false);

      fetchHistory();
      setOriginalYaml(finalContent);

      if (runAfterSave) {
        try {
          let parsed = YAML.parse(finalContent);

          // If it's a CronWorkflow, we must extract the workflowSpec to run it immediately
          if (parsed.kind === "CronWorkflow") {
            parsed = {
              apiVersion: parsed.apiVersion || "argoproj.io/v1alpha1",
              kind: "Workflow",
              metadata: {
                generateName: (parsed.metadata.name || "cron") + "-",
                namespace: parsed.metadata.namespace,
                labels: {
                  ...parsed.metadata.labels,
                  "workflows.argoproj.io/cron-workflow": parsed.metadata.name,
                  "workflows.argoproj.io/workflow-template":
                    parsed.metadata.name // Add this so it shows up in normal workflow lists too
                }
              },
              spec: parsed.spec?.workflowSpec || {}
            };
          }

          const params = parsed?.spec?.arguments?.parameters || [];
          if (params.length > 0) {
            setExecutingWorkflow(parsed);
          } else {
            await finalizeSubmission(parsed);
          }
        } catch (err: any) {
          toast.error(`Execution failed: ${err.message || "Unknown error"}`);
        }
      }
    } catch (error: any) {
      const msg =
        error.response?.data?.message ||
        error.message ||
        "Failed to save workflow";
      toast.error(`Save Failed: ${msg}`, { id: saveToast, duration: 5000 });
      console.error(error);
      setShowWarningModal(false);
    }
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="flex flex-col flex-1 h-screen bg-white">
      <Header name={currentFilename} />

      <div className="flex-1 relative flex flex-col">
        {/* Toolbar */}
        <div className="bg-gray-50 border-b border-gray-200 p-2 flex justify-between items-center z-10">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium text-gray-500 ml-2">
              Editor
            </span>
          </div>
          <div className="flex space-x-2">
            {!isNewWorkflow && (
              <>
                <button
                  className={`flex space-x-1 items-center px-3 py-1.5 border text-sm font-medium rounded-md transition-colors ${activePanel === "runs" ? "bg-gray-100 border-gray-300 text-gray-800" : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"}`}
                  onClick={() =>
                    setActivePanel(activePanel === "runs" ? null : "runs")
                  }
                  title="Toggle Runs"
                >
                  <ClockIcon className="w-4 h-4 text-gray-500" />
                  <span>Runs</span>
                </button>
                <button
                  className={`flex space-x-1 items-center px-3 py-1.5 border text-sm font-medium rounded-md transition-colors ${activePanel === "history" ? "bg-gray-100 border-gray-300 text-gray-800" : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"}`}
                  onClick={() =>
                    setActivePanel(activePanel === "history" ? null : "history")
                  }
                  title="Toggle History"
                >
                  <ServerStackIcon className="w-4 h-4 text-gray-500" />
                  <span>History</span>
                </button>
              </>
            )}
            <button
              className="flex space-x-1 items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 transition-colors"
              onClick={handleOpenSettingsClick}
              title="Configure Scheduling & Resources"
            >
              <Cog8ToothIcon className="w-4 h-4 text-gray-500" />
              <span>Scheduling & Resources</span>
            </button>
            {hasChanges ? (
              <>
                <button
                  className="flex space-x-1 items-center px-4 py-1.5 border border-transparent text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 border-gray-300 focus:outline-none transition-colors"
                  onClick={() => handleSaveClick()}
                >
                  <CloudArrowUpIcon className="w-4 h-4" />
                  <span>Save</span>
                </button>
                <button
                  className="flex space-x-1 items-center px-4 py-1.5 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-none transition-colors"
                  onClick={handleSaveAndRunClick}
                >
                  <PlayIcon className="w-4 h-4" />
                  <span>Save & Run</span>
                </button>
              </>
            ) : (
              <>
                <button
                  className="flex space-x-1 items-center px-4 py-1.5 border text-sm font-medium rounded-md text-gray-400 bg-gray-50 border-gray-200 cursor-not-allowed"
                  disabled={true}
                  title="No changes to save"
                >
                  <CloudArrowUpIcon className="w-4 h-4" />
                  <span>Save</span>
                </button>
                <button
                  className="flex space-x-1 items-center px-4 py-1.5 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none transition-colors"
                  onClick={handleRunOnlyClick}
                >
                  <PlayIcon className="w-4 h-4" />
                  <span>Run</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Editor Area */}
        <div className="flex-1 flex overflow-hidden">
          <div
            className={`relative ${activePanel ? "w-2/3 border-r border-gray-200" : "w-full"}`}
          >
            <div className="absolute inset-0 bg-white">
              <CodeEditor
                data={yamlContent}
                language="yaml"
                onChange={(val) => setYamlContent(val)}
                disabled={false}
                lineWrapping={true}
                height="100%"
              />
            </div>
          </div>
          {activePanel === "runs" && (
            <div className="w-1/3 bg-gray-50 overflow-y-auto flex flex-col">
              <div className="p-4 border-b border-gray-200 bg-white flex justify-between items-center sticky top-0 z-10">
                <h3 className="text-sm font-semibold text-gray-700">
                  Recent Runs
                </h3>
              </div>
              <ul className="divide-y divide-gray-200">
                {executions.length === 0 ? (
                  <li className="p-4 text-sm text-gray-500 text-center">
                    No runs available
                  </li>
                ) : (
                  executions.map((exe) => (
                    <li
                      key={exe.metadata.name}
                      className="p-4 hover:bg-gray-100 transition-colors cursor-pointer"
                      onClick={() =>
                        navigate(`/executions?run=${exe.metadata.name}`)
                      }
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {exe.metadata.name}
                        </span>
                        <span
                          className={`text-xs font-mono px-1.5 py-0.5 rounded ml-2 ${
                            exe.status?.phase === "Succeeded"
                              ? "bg-green-100 text-green-800"
                              : exe.status?.phase === "Failed" ||
                                  exe.status?.phase === "Error"
                                ? "bg-red-100 text-red-800"
                                : exe.status?.phase === "Running"
                                  ? "bg-blue-100 text-blue-800"
                                  : "bg-gray-200 text-gray-800"
                          }`}
                        >
                          {exe.status?.phase || "Pending"}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-xs text-gray-500 mt-2">
                        <span>
                          Started:{" "}
                          {exe.status?.startedAt
                            ? new Date(exe.status.startedAt).toLocaleString()
                            : "N/A"}
                        </span>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
          {activePanel === "history" && (
            <div className="w-1/3 bg-gray-50 overflow-y-auto flex flex-col">
              <div className="p-4 border-b border-gray-200 bg-white flex justify-between items-center sticky top-0 z-10">
                <h3 className="text-sm font-semibold text-gray-700">
                  Commit History
                </h3>
              </div>
              <ul className="divide-y divide-gray-200">
                {history.length === 0 ? (
                  <li className="p-4 text-sm text-gray-500 text-center">
                    No history available
                  </li>
                ) : (
                  history.map((commit) => (
                    <li
                      key={commit.id}
                      className="p-4 hover:bg-gray-100 transition-colors cursor-pointer"
                      onClick={() =>
                        navigate(
                          `/history/${encodeURIComponent(filename || "")}`
                        )
                      }
                    >
                      <div className="flex flex-col mb-1">
                        <span
                          className="text-sm font-medium text-gray-900 truncate"
                          title={commit.message}
                        >
                          {commit.title}
                        </span>
                        <span className="text-xs text-gray-500 mt-1">
                          {commit.author_name}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-xs text-gray-400 mt-2">
                        <span>
                          {new Date(commit.committed_date).toLocaleString()}
                        </span>
                        <span className="font-mono bg-gray-200 px-1 py-0.5 rounded">
                          {commit.short_id}
                        </span>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
        </div>
      </div>
      {showWarningModal && (
        <div className="fixed z-50 inset-0 overflow-y-auto">
          <div className="justify-center items-center flex overflow-x-hidden overflow-y-auto fixed inset-0 outline-none focus:outline-none px-4 py-6">
            <div
              onClick={() => setShowWarningModal(false)}
              className="opacity-40 fixed inset-0 z-40 bg-black backdrop-blur-sm"
            ></div>
            <div className="relative w-full max-w-md z-50">
              <div className="border-0 rounded-xl shadow-2xl relative flex flex-col w-full bg-white outline-none focus:outline-none overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 bg-yellow-50 border-b border-yellow-100">
                  <div className="flex items-center space-x-2">
                    <h3 className="text-base font-bold text-yellow-800 flex items-center">
                      ⚠️ Configuration Warnings Detected
                    </h3>
                  </div>
                </div>

                {/* Body */}
                <div className="px-6 py-6 bg-white space-y-4 text-sm text-gray-700">
                  <p className="leading-relaxed">
                    There are some missing or unsupported scheduling/resources
                    configurations found in this workflow template.
                  </p>
                  <p className="text-xs text-gray-500 leading-relaxed bg-gray-50 p-2.5 rounded border border-gray-100">
                    Specifically, the service account or node tolerations do not
                    match the recommended cluster settings.
                  </p>
                  <label className="flex items-start space-x-3 mt-4 p-2 bg-yellow-50/50 border border-yellow-100 rounded-lg cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ignoreWarningsChecked}
                      onChange={(e) =>
                        setIgnoreWarningsChecked(e.target.checked)
                      }
                      className="h-4 w-4 mt-0.5 text-yellow-600 focus:ring-yellow-500 border-gray-300 rounded"
                    />
                    <span className="text-xs text-gray-600 leading-normal">
                      Do not warn me again for this workflow. (This will write
                      an ignore annotation to the YAML).
                    </span>
                  </label>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end px-6 py-4 bg-gray-50 border-t border-gray-200 space-x-3">
                  <button
                    onClick={handleReviewClick}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors shadow-sm"
                  >
                    Review Configuration
                  </button>
                  <button
                    onClick={handleSaveAnywayClick}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    Save Anyway
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {executingWorkflow && (
        <SubmitWorkflowModal
          workflow={executingWorkflow}
          onClose={() => setExecutingWorkflow(null)}
          onSubmit={finalizeSubmission}
        />
      )}
      {showSettingsModal && (
        <div className="fixed z-50 inset-0 overflow-y-auto">
          <div className="justify-center items-center flex overflow-x-hidden overflow-y-auto fixed inset-0 outline-none focus:outline-none px-4 py-6">
            <div
              onClick={() => setShowSettingsModal(false)}
              className="opacity-40 fixed inset-0 z-40 bg-black backdrop-blur-sm"
            ></div>
            <div className="relative w-full max-w-lg z-50">
              <div className="border-0 rounded-xl shadow-2xl relative flex flex-col w-full bg-white outline-none focus:outline-none overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-b border-gray-200">
                  <div className="flex items-center space-x-2">
                    <div className="p-1.5 bg-blue-100 rounded-lg">
                      <Cog8ToothIcon className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-gray-900">
                        Workflow Scheduling & Resources
                      </h3>
                      <p className="text-xs text-gray-500 font-medium">
                        Configure resources and scheduling globally for this
                        workflow
                      </p>
                    </div>
                  </div>
                </div>

                {/* Body */}
                <div className="px-6 py-6 max-h-[60vh] overflow-y-auto bg-white">
                  <ResourcePlacementForm
                    state={schedulingState}
                    onChange={setSchedulingState}
                    config={config}
                  />
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end px-6 py-4 bg-gray-50 border-t border-gray-200 space-x-3">
                  <button
                    onClick={() => setShowSettingsModal(false)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveSettings}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors shadow-sm"
                  >
                    Apply & Update YAML
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
