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
  ChevronRightIcon
} from "@heroicons/react/24/outline";

const ExecutionsView: React.FC = () => {
  const location = useLocation();
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedExe, setSelectedExe] = useState<WorkflowExecution | null>(
    null
  );
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const queryParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search]
  );
  const cronFilter = queryParams.get("cron");

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
    if (!cronFilter) return executions;
    return executions.filter(
      (exe) =>
        exe.metadata.labels?.["workflows.argoproj.io/cron-workflow"] ===
        cronFilter
    );
  }, [executions, cronFilter]);

  useEffect(() => {
    fetchExecutions();
    const interval = setInterval(fetchExecutions, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [selectedExe?.metadata.name]);

  const fetchLogs = async (id: string, type: "pod" | "workflow" = "pod") => {
    try {
      setLogsLoading(true);
      setLogs(null);
      const data = await getLogs(id, type);
      setLogs(data);
    } catch (err: any) {
      setLogs("Failed to fetch logs: " + err.message);
    } finally {
      setLogsLoading(false);
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
    <div className="p-8 max-w-7xl mx-auto min-h-screen flex flex-col">
      <div className="flex justify-between items-center mb-6">
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
                setLogs(null);
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
        <div className="bg-white shadow overflow-hidden sm:rounded-md border border-gray-200">
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
                      className="ml-4 text-red-500 hover:text-red-700 text-xs px-2 py-1 border border-transparent rounded hover:border-red-200 bg-white shadow-sm z-10"
                    >
                      Delete
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
        <div className="flex flex-col flex-1 space-y-6 overflow-hidden">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
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
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col shadow-sm">
              <div className="p-4 bg-gray-50 border-b border-gray-200 font-medium text-gray-700">
                Nodes / Steps
              </div>
              <div className="flex-1 overflow-y-auto">
                <ul className="divide-y divide-gray-100">
                  {Object.values(selectedExe.status?.nodes || {}).map(
                    (node: any) => (
                      <li
                        key={node.id}
                        className="p-3 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            {getStatusIcon(node.phase, "h-4 w-4")}
                            <span className="text-sm font-medium text-gray-700 truncate max-w-[200px]">
                              {node.name}
                            </span>
                            <span className="text-[10px] text-gray-400 font-mono">
                              ({node.type})
                            </span>
                          </div>
                          {node.type === "Pod" && (
                            <button
                              onClick={() => fetchLogs(node.id)}
                              className="p-1 rounded hover:bg-gray-200 text-gray-500 transition-colors"
                              title="View Logs"
                            >
                              <CommandLineIcon className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  )}
                </ul>
              </div>
            </div>

            {/* Logs Panel */}
            <div className="bg-[#1e1e1e] rounded-lg overflow-hidden flex flex-col shadow-lg border border-gray-800">
              <div className="p-4 bg-gray-900 border-b border-gray-800 font-medium text-gray-300 flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <CommandLineIcon className="h-4 w-4" />
                  <span>Logs</span>
                </div>
                {logsLoading && <Spinner className="w-4 h-4 text-blue-500" />}
              </div>
              <div className="flex-1 p-4 font-mono text-xs text-green-400 overflow-y-auto whitespace-pre-wrap">
                {logs ||
                  (logsLoading
                    ? "Fetching logs..."
                    : "Select a pod node to view logs.")}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExecutionsView;
