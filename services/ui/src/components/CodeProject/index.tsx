import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import toast from "react-hot-toast";
import { validateK8sYaml } from "../../utils/k8sValidation";
import {
  CloudArrowUpIcon,
  Squares2X2Icon,
  ClockIcon,
  PlayIcon,
  ServerStackIcon
} from "@heroicons/react/20/solid";
import YAML from "yaml";

import * as api from "../../utils/api";
import { useTitle } from "../../hooks";
import Header from "../Project/Header";
import CodeEditor from "../CodeEditor";
import { DefaultIngestionModal } from "../modals/DefaultIngestionModal";

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
  const [loading, setLoading] = useState<boolean>(true);
  const [config, setConfig] = useState<api.AppConfig | null>(null);
  const [executions, setExecutions] = useState<api.WorkflowExecution[]>([]);
  const [history, setHistory] = useState<api.CommitHistory[]>([]);
  const [activePanel, setActivePanel] = useState<"runs" | "history" | null>(
    filename ? "runs" : null
  );
  const [showIngestionModal, setShowIngestionModal] = useState(false);

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

      const filtered = data.filter(
        (exe) =>
          (exe.metadata.labels &&
            exe.metadata.labels["workflows.argoproj.io/workflow-template"] ===
              logicalName) ||
          exe.metadata.name.startsWith(`${logicalName}-`)
      );

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
        } else if (initialName) {
          let baseYaml = `apiVersion: argoproj.io/v1alpha1
kind: ${initialKind}
metadata:
  name: ${initialName}
spec:
  entrypoint: main
  templates:
    - name: main
      steps: []
`;
          if (initialKind === "CronWorkflow") {
            baseYaml = `apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: ${initialName}
spec:
  schedule: "* * * * *"
  workflowSpec:
    entrypoint: main
    templates:
      - name: main
        steps: []
`;
          }

          setYamlContent(baseYaml);
        }
      } catch (err) {
        toast.error("Failed to load workflow or configuration");
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

  const handleSaveAndRunClick = () => {
    handleSaveClick(true);
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
      const isCron = parsed.kind === "CronWorkflow";
      const spec = isCron ? parsed.spec?.workflowSpec : parsed.spec;
      const annotations = parsed.metadata?.annotations || {};

      const ignoreDefaults =
        annotations["gitargo.eox.at/ignore-defaults"] === "true";
      const hasServiceAccount = !!spec?.serviceAccountName;
      const hasTolerations = spec?.tolerations && spec.tolerations.length > 0;

      if (!ignoreDefaults && (!hasServiceAccount || !hasTolerations)) {
        setRunAfterSaveAction(runAfterSave);
        setShowIngestionModal(true);
        return;
      }

      executeSave(false, yamlContent, runAfterSave);
    } catch (e) {
      executeSave(false, yamlContent, runAfterSave);
    }
  };

  const executeSave = async (
    applyDefaults: boolean,
    contentToSave: string,
    runAfterSave = false
  ) => {
    const name = currentFilename;
    if (!name) return;

    const saveToast = toast.loading("Saving workflow...");
    try {
      if (!isNewWorkflow) {
        await api.updateWorkflow(
          name,
          contentToSave,
          `Update ${name} via Code Editor`,
          applyDefaults
        );
      } else {
        await api.createWorkflow(
          name,
          contentToSave,
          `Create ${name} via Code Editor`,
          applyDefaults
        );
        setCurrentFilename(name);
        navigate(`/edit/code/${encodeURIComponent(name)}`, { replace: true });
      }

      toast.success("Workflow saved successfully!", { id: saveToast });
      setShowIngestionModal(false);

      if (runAfterSave) {
        try {
          const parsed = YAML.parse(contentToSave);
          await api.submitExecution(parsed);
          toast.success("Workflow executed successfully!");
          if (activePanel !== "runs") setActivePanel("runs");
          setTimeout(fetchExecutions, 1000);
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
      setShowIngestionModal(false);
    }
  };

  const handleIngestionConfirm = () => {
    executeSave(true, yamlContent, runAfterSaveAction);
  };

  const handleIngestionDecline = (rememberChoice: boolean) => {
    let finalContent = yamlContent;
    if (rememberChoice) {
      try {
        const parsed = YAML.parse(yamlContent);
        if (!parsed.metadata) parsed.metadata = {};
        if (!parsed.metadata.annotations) parsed.metadata.annotations = {};
        parsed.metadata.annotations["gitargo.eox.at/ignore-defaults"] = "true";
        finalContent = YAML.stringify(parsed);
        setYamlContent(finalContent); // Update editor
      } catch (e) {
        console.error("Failed to add annotation", e);
      }
    }
    executeSave(false, finalContent, runAfterSaveAction);
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
              Code Editor Only Mode
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
            {currentFilename && config?.experimentalCanvas && (
              <button
                className="flex space-x-1 items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                onClick={() =>
                  navigate(
                    `/edit/canvas/${encodeURIComponent(currentFilename)}`
                  )
                }
                title="Switch to Canvas Mode"
              >
                <Squares2X2Icon className="w-4 h-4 text-[#0078b4]" />
                <span>Switch to Canvas</span>
              </button>
            )}
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
                        navigate(
                          `/executions?workflow=${decodeURIComponent(
                            filename || ""
                          )
                            .split("/")
                            .pop()
                            ?.replace(/\.ya?ml$/i, "")}`
                        )
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
      {showIngestionModal && (
        <DefaultIngestionModal
          onConfirm={handleIngestionConfirm}
          onDecline={handleIngestionDecline}
        />
      )}
    </div>
  );
}
