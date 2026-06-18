import React, { useEffect, useState, useMemo } from "react";
import { useLocation } from "react-router-dom";
import {
  getExecutions,
  WorkflowExecution,
  getLogs,
  deleteExecution
} from "../utils/api";
import Spinner from "../components/global/Spinner";
import {
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
  CommandLineIcon,
  ChevronRightIcon,
  TrashIcon,
  DocumentIcon,
  PhotoIcon,
  DocumentTextIcon,
  ArrowDownTrayIcon
} from "@heroicons/react/24/outline";

const ExecutionsView: React.FC = () => {
  const location = useLocation();
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedExe, setSelectedExe] = useState<WorkflowExecution | null>(
    null
  );
  const [logs, setLogs] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<{
    nodeId: string;
    name: string;
    workflowName: string;
    fileNameForDetection?: string;
    type?: string;
  } | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);

  const queryParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search]
  );
  const cronFilter = queryParams.get("cron");
  const workflowFilter = queryParams.get("workflow");
  const runFilter = queryParams.get("run");

  const [uiWorkflowFilter, setUiWorkflowFilter] = useState<string>("");
  const [uiPhaseFilter, setUiPhaseFilter] = useState<string>("");

  const getArtifactUrl = (
    workflowName: string,
    nodeId: string,
    artifactName: string
  ) => {
    const isDev = process.env.NODE_ENV === "development";
    const basePath = (window as any).BASE_PATH || "";
    const apiBase = isDev ? "http://localhost:3000/api" : `${basePath}/api`;
    return `${apiBase}/artifacts/${workflowName}/${nodeId}/${artifactName}`;
  };

  const handleArtifactClick = async (
    workflowName: string,
    nodeId: string,
    artifactName: string,
    fileNameForDetection: string
  ) => {
    // Determine if it's likely a text file to preview using the underlying file path/key
    const isText = /\.(txt|log|json|yaml|yml|csv|md)$/i.test(
      fileNameForDetection
    );
    const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(
      fileNameForDetection
    );

    // If it's not a known text or image format, trigger a direct download
    if (!isText && !isImage) {
      const url = getArtifactUrl(workflowName, nodeId, artifactName);
      // Create a temporary anchor to force download
      const a = document.createElement("a");
      a.href = url;
      a.download = artifactName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // We don't update selectedArtifact so the preview panel doesn't open
      return;
    }

    setSelectedArtifact({
      workflowName,
      nodeId,
      name: artifactName,
      fileNameForDetection
    });
    setSelectedNodeId(null);
    setLogs("");

    if (isText) {
      setArtifactLoading(true);
      setArtifactContent(null);
      try {
        const url = getArtifactUrl(workflowName, nodeId, artifactName);
        const response = await fetch(url);
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.message || "Failed to fetch artifact");
        }

        // For text files, we want to prevent massive files from crashing the browser tab.
        // We'll grab the response as a blob first to check size.
        const blob = await response.blob();

        // 5MB limit for inline text preview
        if (blob.size > 5 * 1024 * 1024) {
          setArtifactContent(
            `File is too large (${(blob.size / 1024 / 1024).toFixed(2)} MB) to preview inline.\nPlease use the download button.`
          );
          return;
        }

        const text = await blob.text();
        setArtifactContent(text);
      } catch (err: any) {
        setArtifactContent(`Error: ${err.message}`);
      } finally {
        setArtifactLoading(false);
      }
    } else if (isImage) {
      setArtifactContent(null); // Will use <img> tag with URL
    }
  };

  const handleDelete = async (name: string) => {
    if (
      !window.confirm(`Are you sure you want to delete workflow run ${name}?`)
    )
      return;
    setIsDeleting(true);
    try {
      await deleteExecution(name);
      if (selectedExe?.metadata.name === name) {
        setSelectedExe(null);
      }
      await fetchExecutions();
    } catch (err: any) {
      alert(`Failed to delete: ${err.message || "Unknown error"}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const fetchExecutions = async () => {
    try {
      if (!selectedExe) setLoading(true);
      const data = await getExecutions();

      // Defensive check: ensure data is an array
      if (!Array.isArray(data)) {
        console.error("Expected array from getExecutions, got:", data);
        setExecutions([]);
        return;
      }

      setExecutions(data);

      // If we have a selected execution, update it from the fresh data
      if (selectedExe) {
        const updated = data.find(
          (e) => e.metadata.name === selectedExe.metadata.name
        );
        if (updated) setSelectedExe(updated);
      } else if (runFilter) {
        // If runFilter is present in URL and we don't have a selected exe, select it
        const target = data.find((e) => e.metadata.name === runFilter);
        if (target) setSelectedExe(target);
      }
    } catch (err: any) {
      setError(err.message || "Failed to fetch executions");
    } finally {
      setLoading(false);
    }
  };

  const filteredExecutions = useMemo(() => {
    let result = executions;
    if (cronFilter) {
      result = result.filter(
        (exe) =>
          exe.metadata.labels &&
          exe.metadata.labels["workflows.argoproj.io/cron-workflow"] ===
            cronFilter
      );
    }
    if (workflowFilter) {
      result = result.filter(
        (exe) =>
          (exe.metadata.labels &&
            exe.metadata.labels["workflows.argoproj.io/workflow-template"] ===
              workflowFilter) ||
          exe.metadata.name.startsWith(`${workflowFilter}-`)
      );
    }
    if (uiWorkflowFilter) {
      result = result.filter((exe) => {
        const templateName =
          exe.metadata.labels?.["workflows.argoproj.io/workflow-template"];
        if (templateName === uiWorkflowFilter) return true;
        // Fallback for names if labels missing
        return exe.metadata.name.startsWith(`${uiWorkflowFilter}-`);
      });
    }
    if (uiPhaseFilter) {
      result = result.filter(
        (exe) => (exe.status?.phase || "Pending") === uiPhaseFilter
      );
    }

    // Sort by creationTimestamp descending (newest first)
    return [...result].sort((a, b) => {
      return (
        new Date(b.metadata.creationTimestamp).getTime() -
        new Date(a.metadata.creationTimestamp).getTime()
      );
    });
  }, [executions, cronFilter, workflowFilter, uiWorkflowFilter, uiPhaseFilter]);

  const uniqueWorkflowNames = useMemo(() => {
    const names = new Set<string>();
    executions.forEach((exe) => {
      const templateName =
        exe.metadata.labels?.["workflows.argoproj.io/workflow-template"];
      if (templateName) {
        names.add(templateName);
      } else {
        // Guess template name by removing random suffix
        const parts = exe.metadata.name.split("-");
        if (parts.length > 1) {
          parts.pop();
          names.add(parts.join("-"));
        } else {
          names.add(exe.metadata.name);
        }
      }
    });
    return Array.from(names).sort();
  }, [executions]);

  useEffect(() => {
    fetchExecutions();
    const interval = setInterval(fetchExecutions, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [selectedExe?.metadata.name, runFilter]);

  const [logQuery, setLogQuery] = useState("");

  const fetchLogs = async (
    id: string,
    type: "pod" | "workflow" | "overview" = "pod",
    query?: string,
    isPolling = false
  ) => {
    try {
      if (!isPolling) {
        setLogsLoading(true);
        setLogs("");
        setSelectedArtifact(null);
        setArtifactContent(null);
      }
      setSelectedNodeId(id);

      if (type === "overview") {
        if (selectedExe) {
          const overview = [];
          overview.push(`Workflow: ${selectedExe.metadata.name}`);
          overview.push(`Phase: ${selectedExe.status?.phase}`);
          if (selectedExe.status?.message) {
            overview.push(`Message: ${selectedExe.status.message}`);
          }
          if (selectedExe.status?.startedAt) {
            overview.push(
              `Started: ${new Date(selectedExe.status.startedAt).toLocaleString()}`
            );
          }
          if (selectedExe.status?.finishedAt) {
            overview.push(
              `Finished: ${new Date(selectedExe.status.finishedAt).toLocaleString()}`
            );
          }

          if (selectedExe.status?.conditions) {
            overview.push("\nConditions:");
            selectedExe.status.conditions.forEach((c: any) => {
              overview.push(`- ${c.type}=${c.status}: ${c.message || ""}`);
            });
          }

          // Check for common errors in nodes if workflow failed
          if (
            selectedExe.status?.phase === "Failed" ||
            selectedExe.status?.phase === "Error"
          ) {
            const nodesWithErrors = Object.values(
              selectedExe.status?.nodes || {}
            ).filter((n: any) => n.phase === "Failed" || n.phase === "Error");
            if (nodesWithErrors.length > 0) {
              overview.push("\nNode Errors:");
              nodesWithErrors.forEach((n: any) => {
                overview.push(`- ${n.name}: ${n.message || "Unknown error"}`);
              });
            }
          }

          setLogs(overview.join("\n"));
        }
        return;
      }

      let startTime: string | undefined;
      let endTime: string | undefined;

      if (selectedExe) {
        startTime = selectedExe.status?.startedAt;
        if (type === "pod" && selectedExe.status?.nodes?.[id]) {
          const node = selectedExe.status.nodes[id];
          if (node.startedAt) startTime = node.startedAt;
          if (node.finishedAt) endTime = node.finishedAt;
        }
      }

      // Buffer start time by 1 hour to account for clock skew and DAGs
      if (startTime) {
        const dt = new Date(startTime);
        dt.setHours(dt.getHours() - 1);
        startTime = dt.toISOString();
      }

      // Buffer end time by 1 hour if it exists
      if (endTime) {
        const dt = new Date(endTime);
        dt.setHours(dt.getHours() + 1);
        endTime = dt.toISOString();
      }

      const workflowName = selectedExe?.metadata.name;
      const data = await getLogs(
        id,
        type,
        query,
        startTime,
        endTime,
        workflowName
      );
      setLogs(data);
    } catch (err: any) {
      if (!isPolling) setLogs("Failed to fetch logs: " + err.message);
    } finally {
      if (!isPolling) setLogsLoading(false);
    }
  };

  // Poll for logs if the selected node is currently running
  useEffect(() => {
    if (!selectedExe || !selectedNodeId) return;

    const node = selectedExe.status?.nodes?.[selectedNodeId];
    if (node && node.phase === "Running" && node.type === "Pod") {
      const interval = setInterval(() => {
        fetchLogs(selectedNodeId, "pod", logQuery, true);
      }, 5000); // Poll every 5 seconds
      return () => clearInterval(interval);
    }
  }, [selectedExe, selectedNodeId, logQuery]);

  const handleLogSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedExe) {
      // If we have a selected node that is a Pod, use its ID, otherwise use the workflow ID
      const activePod = Object.values(selectedExe.status?.nodes || {}).find(
        (n: any) =>
          n.phase === "Running" ||
          n.phase === "Succeeded" ||
          n.phase === "Failed"
      );
      const id = activePod ? (activePod as any).id : selectedExe.metadata.name;
      const type = activePod ? "pod" : "workflow";
      fetchLogs(id, type as any, logQuery);
    }
  };

  const getStatusIcon = (phase: string, size = "h-6 w-6") => {
    switch (phase) {
      case "Succeeded":
        return <CheckCircleIcon className={`${size} text-green-500`} />;
      case "Failed":
      case "Error":
        return <XCircleIcon className={`${size} text-red-500`} />;
      case "Running":
        return (
          <ArrowPathIcon className={`${size} text-blue-500 animate-spin`} />
        );
      case "Unknown (Loki Only)":
      case "Unknown (Loki)":
        return <CommandLineIcon className={`${size} text-indigo-400`} />;
      default:
        return <ClockIcon className={`${size} text-gray-400`} />;
    }
  };

  if (loading && executions.length === 0)
    return (
      <div className="flex justify-center p-12">
        <Spinner className="w-8 h-8 text-[#004170]" />
      </div>
    );
  if (error) return <div className="p-8 text-red-500 text-center">{error}</div>;

  return (
    <div className="p-8 max-w-7xl mx-auto h-[calc(100vh-4rem)] flex flex-col overflow-hidden">
      <div className="flex justify-between items-center mb-6 flex-shrink-0">
        <h1 className="text-2xl font-bold text-[#004170]">
          {selectedExe
            ? selectedExe.metadata.name
            : cronFilter
              ? `Executions for ${cronFilter}`
              : "Workflow Executions"}
        </h1>
        <div className="flex space-x-2">
          {selectedExe && (
            <button
              onClick={() => {
                setSelectedExe(null);
                setLogs("");
                setSelectedNodeId(null);
              }}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
            >
              Back to List
            </button>
          )}
          {selectedExe && selectedExe.status?.phase.includes("Loki") && (
            <button
              onClick={() => fetchLogs(selectedExe.metadata.name, "workflow")}
              className="px-4 py-2 text-sm font-medium text-indigo-600 bg-white border border-indigo-300 rounded hover:bg-indigo-50 transition-colors flex items-center"
            >
              <CommandLineIcon className="h-4 w-4 mr-2" />
              Refresh All Logs
            </button>
          )}
          <button
            onClick={fetchExecutions}
            className="p-2 rounded-full hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <ArrowPathIcon className="h-5 w-5 text-gray-600" />
          </button>
        </div>
      </div>

      {!selectedExe && (
        <div className="flex space-x-4 mb-4 flex-shrink-0 bg-gray-50 p-4 rounded-md border border-gray-200">
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 font-medium mb-1">
              Source Workflow
            </label>
            <select
              value={uiWorkflowFilter}
              onChange={(e) => setUiWorkflowFilter(e.target.value)}
              className="border border-gray-300 text-sm rounded px-3 py-1.5 focus:outline-none focus:border-[#004170] bg-white min-w-[200px]"
            >
              <option value="">All Workflows</option>
              {uniqueWorkflowNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 font-medium mb-1">
              Status
            </label>
            <select
              value={uiPhaseFilter}
              onChange={(e) => setUiPhaseFilter(e.target.value)}
              className="border border-gray-300 text-sm rounded px-3 py-1.5 focus:outline-none focus:border-[#004170] bg-white min-w-[150px]"
            >
              <option value="">All Statuses</option>
              <option value="Succeeded">Succeeded</option>
              <option value="Running">Running</option>
              <option value="Failed">Failed</option>
              <option value="Error">Error</option>
              <option value="Pending">Pending</option>
            </select>
          </div>
        </div>
      )}

      {!selectedExe ? (
        <div className="bg-white shadow overflow-y-auto sm:rounded-md border border-gray-200 flex-1">
          <ul className="divide-y divide-gray-200">
            {filteredExecutions.map((exe) => (
              <li key={exe.metadata.name} onClick={() => setSelectedExe(exe)}>
                <div className="px-4 py-4 sm:px-6 hover:bg-gray-50 cursor-pointer">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      {getStatusIcon(exe.status?.phase || "Pending")}
                      <p className="text-sm font-medium text-[#004170] truncate">
                        {exe.metadata.name}
                      </p>
                    </div>
                    <div className="ml-2 flex-shrink-0 flex items-center space-x-2">
                      <p
                        className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          exe.status?.phase === "Succeeded"
                            ? "bg-green-100 text-green-800"
                            : exe.status?.phase === "Running"
                              ? "bg-blue-100 text-blue-800"
                              : exe.status?.phase === "Failed"
                                ? "bg-red-100 text-red-800"
                                : "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {exe.status?.phase || "Pending"}
                      </p>
                      <ChevronRightIcon className="h-5 w-5 text-gray-400" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between sm:mt-0">
                    <p className="flex items-center text-sm text-gray-500">
                      <ClockIcon className="flex-shrink-0 mr-1.5 h-5 w-5 text-gray-400" />
                      Created{" "}
                      {new Date(
                        exe.metadata.creationTimestamp
                      ).toLocaleString()}
                    </p>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(exe.metadata.name);
                      }}
                      disabled={isDeleting}
                      className="ml-4 inline-flex items-center px-3 py-1.5 border border-red-300 shadow-sm text-xs font-medium rounded text-red-700 bg-white hover:bg-red-50 transition-colors z-10"
                      title="Delete Execution"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>{" "}
                </div>
              </li>
            ))}
            {filteredExecutions.length === 0 && (
              <li className="px-4 py-8 text-center text-gray-500">
                No executions found.
              </li>
            )}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col flex-1 space-y-6 overflow-hidden min-h-0 pb-4">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm flex-shrink-0">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-sm text-gray-500">
                  Status:{" "}
                  <span className="font-semibold text-gray-900">
                    {selectedExe.status?.phase}
                  </span>
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Namespace: {selectedExe.metadata.namespace}
                </p>
              </div>
              <div className="text-right text-xs text-gray-400">
                <p>
                  Started:{" "}
                  {new Date(
                    selectedExe.status?.startedAt || ""
                  ).toLocaleString()}
                </p>
                {selectedExe.status?.finishedAt && (
                  <p>
                    Finished:{" "}
                    {new Date(selectedExe.status.finishedAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden min-h-0 space-x-6 pb-2">
            {/* Steps List */}
            <div className="w-1/3 bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col shadow-sm min-h-0">
              <div className="p-4 bg-gray-50 border-b border-gray-200 font-medium text-gray-700 flex-shrink-0">
                Nodes / Steps
              </div>
              <div className="flex-1 overflow-y-auto">
                <ul className="divide-y divide-gray-100">
                  <li
                    className={`p-3 hover:bg-gray-50 transition-colors cursor-pointer ${selectedNodeId === "workflow-overview" ? "bg-blue-50" : ""}`}
                    onClick={() => fetchLogs("workflow-overview", "overview")}
                  >
                    <div className="flex items-center space-x-2">
                      <CommandLineIcon className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-bold text-gray-700">
                        Workflow Overview
                      </span>
                    </div>
                  </li>
                  {(() => {
                    const nodes = selectedExe.status?.nodes || {};
                    const rootNode = Object.values(nodes).find(
                      (n: any) => n.name === selectedExe.metadata.name
                    );
                    if (!rootNode) return null;

                    const orderedNodes: any[] = [];
                    const seen = new Set();

                    const traverse = (id: string, depth: number) => {
                      if (seen.has(id)) return;
                      seen.add(id);
                      const node = nodes[id];
                      if (!node) return;
                      orderedNodes.push({ ...node, depth });
                      if (node.children) {
                        node.children.forEach((childId: string) =>
                          traverse(childId, depth + 1)
                        );
                      }
                    };

                    traverse((rootNode as any).id, 0);

                    return orderedNodes.map((node: any) => {
                      const cleanName = node.name.startsWith(
                        selectedExe.metadata.name
                      )
                        ? node.name === selectedExe.metadata.name
                          ? "Workflow Root"
                          : node.name
                              .substring(selectedExe.metadata.name.length)
                              .replace(/^[.-]/, "")
                        : node.name;

                      const artifacts = [
                        ...(node.inputs?.artifacts || []).map((a: any) => ({
                          ...a,
                          _type: "input"
                        })),
                        ...(node.outputs?.artifacts || []).map((a: any) => ({
                          ...a,
                          _type: "output"
                        }))
                      ];

                      return (
                        <React.Fragment key={node.id}>
                          <li
                            className={`p-3 hover:bg-gray-50 transition-colors cursor-pointer ${selectedNodeId === node.id ? "bg-blue-50" : ""}`}
                            style={{
                              paddingLeft: `${node.depth * 1.5 + 0.75}rem`
                            }}
                            onClick={() =>
                              node.type === "Pod" && fetchLogs(node.id)
                            }
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center space-x-2">
                                {getStatusIcon(node.phase, "h-4 w-4")}
                                <span className="text-sm font-medium text-gray-700 truncate max-w-[200px]">
                                  {cleanName}
                                </span>
                                <span className="text-[10px] text-gray-400 font-mono">
                                  ({node.type})
                                </span>
                              </div>
                              {node.type === "Pod" && (
                                <div className="flex space-x-1">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      fetchLogs(node.id);
                                    }}
                                    className="p-1 rounded hover:bg-gray-200 text-gray-500 transition-colors"
                                    title="View Logs"
                                  >
                                    <CommandLineIcon className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                            </div>
                          </li>
                          {artifacts.map((art: any, idx: number) => {
                            const fileNameForDetection =
                              art.path ||
                              (art.s3 && art.s3.key) ||
                              (art.gcs && art.gcs.key) ||
                              art.name;

                            const isImage =
                              /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(
                                fileNameForDetection
                              );
                            const isText =
                              /\.(txt|log|json|yaml|yml|csv|md)$/i.test(
                                fileNameForDetection
                              );

                            return (
                              <li
                                key={`${node.id}-art-${idx}`}
                                className={`p-2 hover:bg-gray-50 transition-colors cursor-pointer border-l-2 border-transparent`}
                                style={{
                                  paddingLeft: `${(node.depth + 1) * 1.5 + 0.75}rem`
                                }}
                                onClick={() =>
                                  handleArtifactClick(
                                    selectedExe.metadata.name,
                                    node.id,
                                    art.name,
                                    fileNameForDetection
                                  )
                                }
                              >
                                <div className="flex items-center justify-between group">
                                  <div className="flex items-center space-x-2">
                                    {isImage ? (
                                      <PhotoIcon className="h-3.5 w-3.5 text-purple-500" />
                                    ) : isText ? (
                                      <DocumentTextIcon className="h-3.5 w-3.5 text-blue-500" />
                                    ) : (
                                      <DocumentIcon className="h-3.5 w-3.5 text-gray-400" />
                                    )}
                                    <div className="flex flex-col">
                                      <span
                                        className="text-xs text-gray-600 truncate max-w-[150px]"
                                        title={art.name}
                                      >
                                        {art.name}
                                      </span>
                                      {fileNameForDetection !== art.name && (
                                        <span
                                          className="text-[9px] text-gray-400 truncate max-w-[150px]"
                                          title={fileNameForDetection}
                                        >
                                          {fileNameForDetection
                                            .split("/")
                                            .pop()}
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-[9px] px-1 bg-gray-100 text-gray-500 rounded uppercase">
                                      {art._type}
                                    </span>
                                  </div>
                                  <a
                                    href={getArtifactUrl(
                                      selectedExe.metadata.name,
                                      node.id,
                                      art.name
                                    )}
                                    download={art.name}
                                    onClick={(e) => e.stopPropagation()}
                                    className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100 transition-all"
                                    title="Download"
                                  >
                                    <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                                  </a>
                                </div>
                              </li>
                            );
                          })}
                        </React.Fragment>
                      );
                    });
                  })()}
                </ul>
              </div>
            </div>

            {/* Logs / Artifact Panel */}
            <div className="w-2/3 bg-[#1e1e1e] rounded-lg overflow-hidden flex flex-col shadow-lg border border-gray-800 min-h-0">
              <div className="p-4 bg-gray-900 border-b border-gray-800 font-medium text-gray-300 flex justify-between items-center flex-shrink-0">
                <div className="flex items-center space-x-2">
                  {selectedArtifact ? (
                    <>
                      <DocumentIcon className="h-4 w-4 text-indigo-400" />
                      <span>Artifact Preview: {selectedArtifact.name}</span>
                    </>
                  ) : (
                    <>
                      <CommandLineIcon className="h-4 w-4" />
                      <span>Logs</span>
                    </>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  {!selectedArtifact && (
                    <form onSubmit={handleLogSearch} className="relative">
                      <input
                        type="text"
                        value={logQuery}
                        onChange={(e) => setLogQuery(e.target.value)}
                        placeholder="Filter logs..."
                        className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-500 w-32 md:w-48"
                      />
                      <button type="submit" className="hidden"></button>
                    </form>
                  )}
                  {selectedArtifact && (
                    <a
                      href={getArtifactUrl(
                        selectedArtifact.workflowName,
                        selectedArtifact.nodeId,
                        selectedArtifact.name
                      )}
                      download={selectedArtifact.name}
                      className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded border border-gray-700 flex items-center transition-colors"
                    >
                      <ArrowDownTrayIcon className="h-3 w-3 mr-1" />
                      Download
                    </a>
                  )}
                  {(logsLoading || artifactLoading) && (
                    <Spinner className="w-4 h-4 text-blue-500" />
                  )}
                </div>
              </div>
              <div className="flex-1 p-4 font-mono text-xs overflow-y-auto min-h-0">
                {selectedArtifact ? (
                  artifactLoading ? (
                    <div className="flex items-center space-x-2 text-gray-500">
                      <Spinner className="w-3 h-3" />
                      <span>Loading artifact...</span>
                    </div>
                  ) : artifactContent ? (
                    <div className="bg-[#111] p-4 rounded border border-gray-800 text-gray-300 overflow-x-auto whitespace-pre">
                      {artifactContent}
                    </div>
                  ) : /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(
                      selectedArtifact.fileNameForDetection || ""
                    ) ? (
                    <div className="flex flex-col items-center justify-center h-full bg-[#111] rounded border border-gray-800 p-4">
                      <div
                        className="relative border border-gray-600 bg-white"
                        style={{
                          backgroundImage:
                            "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)",
                          backgroundSize: "20px 20px",
                          backgroundPosition:
                            "0 0, 0 10px, 10px -10px, -10px 0px"
                        }}
                      >
                        <img
                          src={getArtifactUrl(
                            selectedArtifact.workflowName,
                            selectedArtifact.nodeId,
                            selectedArtifact.name
                          )}
                          alt={selectedArtifact.name}
                          className="max-w-full max-h-full object-contain shadow-2xl min-w-[50px] min-h-[50px]"
                        />
                      </div>
                      <p className="mt-4 text-gray-500 text-[10px]">
                        {selectedArtifact.name}
                      </p>
                    </div>
                  ) : (
                    <div className="text-gray-500 italic p-4 text-center">
                      Preview not available for this file type.
                      <br />
                      <a
                        href={getArtifactUrl(
                          selectedArtifact.workflowName,
                          selectedArtifact.nodeId,
                          selectedArtifact.name
                        )}
                        download={selectedArtifact.name}
                        className="text-blue-400 hover:underline mt-2 inline-block"
                      >
                        Download {selectedArtifact.name}
                      </a>
                    </div>
                  )
                ) : logsLoading ? (
                  <div className="flex items-center space-x-2 text-gray-500">
                    <Spinner className="w-3 h-3" />
                    <span>Fetching logs...</span>
                  </div>
                ) : logs ? (
                  <div className="flex flex-col whitespace-pre-wrap">
                    {logs.split("\n").map((line, idx) => {
                      const isSystem = [
                        "Starting Workflow Executor",
                        "Using executor retry strategy",
                        "Start loading input artifacts",
                        "No Script output reference",
                        "Capturing script output ignored",
                        "No output parameters",
                        "No output artifacts",
                        "stopping progress monitor",
                        "Deadline monitor stopped",
                        "Starting deadline monitor",
                        "Main container completed",
                        "sub-process exited",
                        "Alloc=",
                        "Executor initialized"
                      ].some((phrase) => line.includes(phrase));

                      return (
                        <span
                          key={idx}
                          className={
                            isSystem ? "text-gray-500" : "text-green-400"
                          }
                        >
                          {line}
                        </span>
                      );
                    })}
                  </div>
                ) : selectedNodeId ? (
                  <div className="text-gray-500 italic">
                    No logs found for this node. They may have been rotated or
                    expired.
                  </div>
                ) : (
                  <div className="text-gray-500">
                    Select a pod node to view logs.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExecutionsView;
