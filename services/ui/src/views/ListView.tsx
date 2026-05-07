import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import YAML from "yaml";
import {
  getWorkflows,
  getWorkflow,
  WorkflowFile,
  deleteWorkflow,
  restoreWorkflow
} from "../utils/api";
import {
  DocumentIcon,
  ClockIcon,
  CodeBracketIcon,
  Squares2X2Icon,
  TrashIcon,
  ArrowUturnLeftIcon
} from "@heroicons/react/24/outline";
import toast from "react-hot-toast";
import Spinner from "../components/global/Spinner";

interface WorkflowMetadata {
  kind?: string;
  schedule?: string;
  entrypoint?: string;
  isParsing?: boolean;
}

const ListView: React.FC = () => {
  const [workflows, setWorkflows] = useState<WorkflowFile[]>([]);
  const [metadata, setMetadata] = useState<Record<string, WorkflowMetadata>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<"active" | "deleted">("active");

  const fetchWorkflows = async () => {
    try {
      setLoading(true);
      const data = await getWorkflows();
      setWorkflows(data);

      data.forEach(async (wf) => {
        setMetadata((prev) => ({ ...prev, [wf.id]: { isParsing: true } }));
        try {
          const content = await getWorkflow(wf.path);
          const parsed = YAML.parse(content);
          const kind: string = parsed?.kind || "Unknown";
          let schedule: string | null = null;
          let entrypoint: string | null = null;

          if (kind === "CronWorkflow") {
            schedule = parsed?.spec?.schedule;
            entrypoint = parsed?.spec?.workflowSpec?.entrypoint;
          } else if (
            kind === "WorkflowTemplate" ||
            kind === "ClusterWorkflowTemplate"
          ) {
            entrypoint = parsed?.spec?.templates?.[0]?.name;
          } else {
            entrypoint = parsed?.spec?.entrypoint;
          }

          setMetadata((prev) => ({
            ...prev,
            [wf.id]: {
              kind,
              schedule: schedule || undefined,
              entrypoint: entrypoint || undefined,
              isParsing: false
            }
          }));
        } catch (e) {
          setMetadata((prev) => ({
            ...prev,
            [wf.id]: { kind: "Error", isParsing: false }
          }));
        }
      });
    } catch (err: any) {
      setError(err.message || "Failed to fetch workflows");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const handleDelete = async (path: string) => {
    if (!window.confirm(`Are you sure you want to delete ${path}?`)) return;
    const toastId = toast.loading("Deleting workflow...");
    try {
      await deleteWorkflow(path);
      toast.success("Workflow deleted successfully", { id: toastId });
      fetchWorkflows();
    } catch (err: any) {
      toast.error(`Failed to delete: ${err.message}`, { id: toastId });
    }
  };

  const handleRestore = async (path: string) => {
    const toastId = toast.loading("Restoring workflow...");
    try {
      await restoreWorkflow(path);
      toast.success("Workflow restored successfully", { id: toastId });
      fetchWorkflows();
    } catch (err: any) {
      toast.error(`Failed to restore: ${err.message}`, { id: toastId });
    }
  };

  const activeWorkflows = useMemo(
    () => workflows.filter((w) => !w.name.endsWith(".deleted")),
    [workflows]
  );
  const deletedWorkflows = useMemo(
    () => workflows.filter((w) => w.name.endsWith(".deleted")),
    [workflows]
  );

  const displayedWorkflows =
    viewTab === "active" ? activeWorkflows : deletedWorkflows;

  return (
    <div className="flex flex-col flex-1 min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex justify-between items-center sticky top-0 z-10 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-[#004170]">Workflows</h1>
          <p className="text-sm text-gray-500">Manage your Argo Workflows</p>
        </div>
        <div className="flex space-x-2">
          <Link
            to="/new/code"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded shadow-sm text-white bg-[#004170] hover:bg-[#002f52] focus:outline-none transition-colors"
          >
            <CodeBracketIcon
              className="-ml-1 mr-2 h-5 w-5"
              aria-hidden="true"
            />
            New (Code)
          </Link>
          <Link
            to="/new/canvas"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded shadow-sm text-white bg-[#0078b4] hover:bg-[#005f8f] focus:outline-none transition-colors"
          >
            <Squares2X2Icon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
            New (Canvas)
          </Link>
        </div>
      </header>

      <main className="p-8 max-w-7xl mx-auto w-full">
        <div className="mb-6 border-b border-gray-200">
          <nav className="-mb-px flex space-x-8" aria-label="Tabs">
            <button
              onClick={() => setViewTab("active")}
              className={`${
                viewTab === "active"
                  ? "border-[#004170] text-[#004170]"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
            >
              Active Workflows ({activeWorkflows.length})
            </button>
            <button
              onClick={() => setViewTab("deleted")}
              className={`${
                viewTab === "deleted"
                  ? "border-red-600 text-red-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
            >
              Deleted ({deletedWorkflows.length})
            </button>
          </nav>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <Spinner className="text-[#004170]" />
          </div>
        ) : error ? (
          <div className="bg-red-50 border-l-4 border-red-400 p-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg
                  className="h-5 w-5 text-red-400"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <div className="ml-3">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            </div>
          </div>
        ) : displayedWorkflows.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg border-2 border-dashed border-gray-300">
            <DocumentIcon className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              No {viewTab} workflows found
            </h3>
            {viewTab === "active" && (
              <div className="mt-6 flex justify-center space-x-3">
                <Link
                  to="/new/code"
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded text-white bg-[#004170] hover:bg-[#002f52]"
                >
                  <CodeBracketIcon
                    className="-ml-1 mr-2 h-5 w-5"
                    aria-hidden="true"
                  />
                  Code Mode
                </Link>
                <Link
                  to="/new/canvas"
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded text-white bg-[#0078b4] hover:bg-[#005f8f]"
                >
                  <Squares2X2Icon
                    className="-ml-1 mr-2 h-5 w-5"
                    aria-hidden="true"
                  />
                  Canvas Mode
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white shadow overflow-hidden rounded-md border border-gray-200">
            <ul className="divide-y divide-gray-200">
              {displayedWorkflows.map((workflow) => (
                <li key={workflow.id}>
                  <div
                    className={`px-6 py-4 flex items-center justify-between hover:bg-[#f8fbfc] transition-colors ${viewTab === "deleted" ? "opacity-70" : ""}`}
                  >
                    <div className="flex items-center min-w-0 flex-1">
                      <div className="flex-shrink-0">
                        <DocumentIcon className="h-8 w-8 text-[#004170]" />
                      </div>
                      <div className="ml-4 flex-1">
                        <div className="flex items-center space-x-2">
                          <p
                            className={`text-sm font-medium truncate ${viewTab === "deleted" ? "text-gray-500 line-through" : "text-[#004170]"}`}
                          >
                            {workflow.name.replace(/\.deleted$/, "")}
                          </p>
                          {metadata[workflow.id]?.isParsing && (
                            <Spinner className="w-3 h-3 text-gray-400" />
                          )}
                          {!metadata[workflow.id]?.isParsing &&
                            metadata[workflow.id]?.kind && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-800 border border-blue-200">
                                {metadata[workflow.id].kind}
                              </span>
                            )}
                          {!metadata[workflow.id]?.isParsing &&
                            metadata[workflow.id]?.schedule && (
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800 border border-green-200"
                                title="Cron Schedule"
                              >
                                <ClockIcon className="w-3 h-3 mr-1" />
                                {metadata[workflow.id].schedule}
                              </span>
                            )}
                        </div>
                        <p className="text-xs text-gray-500 truncate mt-1">
                          {workflow.path.replace(/\.deleted$/, "")}
                          {!metadata[workflow.id]?.isParsing &&
                            metadata[workflow.id]?.entrypoint && (
                              <>
                                <span className="mx-2 text-gray-300">|</span>
                                <span title="Entrypoint">
                                  Entrypoint:{" "}
                                  <span className="font-mono text-[10px] bg-gray-100 px-1 py-0.5 rounded border border-gray-200">
                                    {metadata[workflow.id].entrypoint}
                                  </span>
                                </span>
                              </>
                            )}
                        </p>
                      </div>
                    </div>
                    <div className="ml-4 flex-shrink-0 flex items-center space-x-2">
                      {viewTab === "active" ? (
                        <>
                          <div className="flex border border-gray-300 rounded overflow-hidden shadow-sm">
                            <Link
                              to={`/edit/code/${encodeURIComponent(workflow.path)}`}
                              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 border-r border-gray-300 transition-colors"
                              title="Edit in Code Mode"
                            >
                              <CodeBracketIcon className="mr-1.5 h-4 w-4 text-[#004170]" />
                              Code
                            </Link>
                            <Link
                              to={`/edit/canvas/${encodeURIComponent(workflow.path)}`}
                              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                              title="Edit in Canvas Mode"
                            >
                              <Squares2X2Icon className="mr-1.5 h-4 w-4 text-[#0078b4]" />
                              Canvas
                            </Link>
                          </div>
                          <Link
                            to={`/history/${encodeURIComponent(workflow.path)}`}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                            title="History"
                          >
                            <ClockIcon className="h-4 w-4 text-gray-500" />
                          </Link>
                          <button
                            onClick={() => handleDelete(workflow.path)}
                            className="inline-flex items-center px-3 py-1.5 border border-red-300 shadow-sm text-xs font-medium rounded text-red-700 bg-white hover:bg-red-50 transition-colors"
                            title="Delete"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <Link
                            to={`/history/${encodeURIComponent(workflow.path)}`}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                            title="History"
                          >
                            <ClockIcon className="-ml-0.5 mr-1 h-4 w-4 text-gray-500" />
                            History
                          </Link>
                          <button
                            onClick={() => handleRestore(workflow.path)}
                            className="inline-flex items-center px-3 py-1.5 border border-green-300 shadow-sm text-xs font-medium rounded text-green-700 bg-white hover:bg-green-50 transition-colors"
                            title="Restore"
                          >
                            <ArrowUturnLeftIcon className="-ml-0.5 mr-1 h-4 w-4" />
                            Restore
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
};

export default ListView;
