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
  TrashIcon
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

  const queryParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search]
  );
  const cronFilter = queryParams.get("cron");
  const workflowFilter = queryParams.get("workflow");

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
    // Sort by creationTimestamp descending (newest first)
    return [...result].sort((a, b) => {
      return (
        new Date(b.metadata.creationTimestamp).getTime() -
        new Date(a.metadata.creationTimestamp).getTime()
      );
    });
  }, [executions, cronFilter, workflowFilter]);

  useEffect(() => {
    fetchExecutions();
    const interval = setInterval(fetchExecutions, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [selectedExe?.metadata.name]);

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
    <div className="p-8 max-w-7xl mx-auto h-screen flex flex-col overflow-hidden">
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
        <div className="flex flex-col flex-1 space-y-6 overflow-hidden min-h-0">
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-0">
            {/* Steps List */}
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col shadow-sm min-h-0">
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

                      return (
                        <li
                          key={node.id}
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
                            )}
                          </div>
                        </li>
                      );
                    });
                  })()}
                </ul>
              </div>
            </div>

            {/* Logs Panel */}
            <div className="bg-[#1e1e1e] rounded-lg overflow-hidden flex flex-col shadow-lg border border-gray-800 min-h-0">
              <div className="p-4 bg-gray-900 border-b border-gray-800 font-medium text-gray-300 flex justify-between items-center flex-shrink-0">
                <div className="flex items-center space-x-2">
                  <CommandLineIcon className="h-4 w-4" />
                  <span>Logs</span>
                </div>
                <div className="flex items-center space-x-2">
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
                  {logsLoading && <Spinner className="w-4 h-4 text-blue-500" />}
                </div>
              </div>
              <div className="flex-1 p-4 font-mono text-xs overflow-y-auto whitespace-pre-wrap min-h-0">
                {logsLoading ? (
                  <div className="flex items-center space-x-2 text-gray-500">
                    <Spinner className="w-3 h-3" />
                    <span>Fetching logs...</span>
                  </div>
                ) : logs ? (
                  <div className="flex flex-col">
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
