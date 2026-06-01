import React, { useEffect, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import YAML from "yaml";
import {
  getWorkflows,
  getWorkflow,
  WorkflowFile,
  deleteWorkflow,
  restoreWorkflow,
  getPublishedWorkflows,
  publishWorkflow,
  unpublishWorkflow,
  getConfig,
  submitExecution,
  AppConfig
} from "../utils/api";
import {
  DocumentIcon,
  ClockIcon,
  CodeBracketIcon,
  Squares2X2Icon,
  TrashIcon,
  ArrowUturnLeftIcon,
  ArrowPathIcon,
  CloudArrowUpIcon,
  CloudArrowDownIcon,
  InformationCircleIcon,
  PlayIcon
} from "@heroicons/react/24/outline";
import toast from "react-hot-toast";
import Spinner from "../components/global/Spinner";
import { NewWorkflowModal } from "../components/modals/NewWorkflowModal";

interface WorkflowMetadata {
  kind?: string;
  schedule?: string;
  entrypoint?: string;
  isParsing?: boolean;
  hasExecute?: boolean;
}

const ListView: React.FC = () => {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<WorkflowFile[]>([]);
  const [metadata, setMetadata] = useState<Record<string, WorkflowMetadata>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<"active" | "deleted">("active");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [publishedWorkflows, setPublishedWorkflows] = useState<string[]>([]);
  const [publishing, setPublishing] = useState<Record<string, boolean>>({});

  const [newModalMode, setNewModalMode] = useState<"code" | "canvas" | null>(
    null
  );

  const handleCreateNew = (
    name: string,
    kind: string,
    options: { profile?: string; ephemeral?: boolean; ephemeralSize?: string }
  ) => {
    const params = new URLSearchParams({
      name,
      kind,
      profile: options.profile || "",
      ephemeral: options.ephemeral ? "true" : "false",
      ephemeralSize: options.ephemeralSize || "2Gi"
    });

    if (newModalMode === "code") {
      navigate(`/new/code?${params.toString()}`);
    } else if (newModalMode === "canvas") {
      navigate(`/new/canvas?${params.toString()}`);
    }
    setNewModalMode(null);
  };

  const handleExecute = async (path: string) => {
    const executeToast = toast.loading("Submitting workflow...");
    try {
      const content = await getWorkflow(path);
      const parsed = YAML.parse(content);
      await submitExecution(parsed);
      toast.success("Workflow submitted successfully!", { id: executeToast });
      navigate("/executions");
    } catch (err: any) {
      toast.error(`Failed to submit: ${err.message}`, { id: executeToast });
    }
  };

  const fetchWorkflows = async () => {
    try {
      setLoading(true);
      const [data, published, appConfig] = await Promise.all([
        getWorkflows(),
        getPublishedWorkflows(),
        getConfig()
      ]);
      setWorkflows(data);
      setPublishedWorkflows(published);
      setConfig(appConfig);

      data.forEach(async (wf) => {
        setMetadata((prev) => ({ ...prev, [wf.path]: { isParsing: true } }));
        try {
          const content = await getWorkflow(wf.path);
          const parsed = YAML.parse(content);
          const kind: string = parsed?.kind || "Unknown";
          let schedule: string | null = null;
          let entrypoint: string | null = null;
          let hasExecute = false;

          if (kind === "CronWorkflow") {
            schedule = parsed?.spec?.schedule;
            entrypoint = parsed?.spec?.workflowSpec?.entrypoint;
          } else if (kind === "WorkflowTemplate") {
            entrypoint = parsed?.spec?.templates?.[0]?.name;
            // Check for entrypoint named "execute" or a template named "execute"
            const specEntrypoint = parsed?.spec?.entrypoint;
            const templates = parsed?.spec?.templates || [];
            hasExecute =
              specEntrypoint === "execute" ||
              templates.some((t: any) => t.name === "execute");
          } else {
            entrypoint = parsed?.spec?.entrypoint;
          }

          setMetadata((prev) => ({
            ...prev,
            [wf.path]: {
              kind,
              schedule: schedule || undefined,
              entrypoint: entrypoint || undefined,
              isParsing: false,
              hasExecute
            }
          }));
        } catch (e) {
          setMetadata((prev) => ({
            ...prev,
            [wf.path]: { kind: "Error", isParsing: false }
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

  const handlePublish = async (path: string) => {
    const toastId = toast.loading("Publishing workflow...");
    setPublishing((prev) => ({ ...prev, [path]: true }));
    try {
      await publishWorkflow(path);
      toast.success("Workflow published successfully", { id: toastId });
      const published = await getPublishedWorkflows();
      setPublishedWorkflows(published);
    } catch (err: any) {
      toast.error(`Failed to publish: ${err.message}`, { id: toastId });
    } finally {
      setPublishing((prev) => ({ ...prev, [path]: false }));
    }
  };

  const handleUnpublish = async (path: string) => {
    const toastId = toast.loading("Unpublishing workflow...");
    setPublishing((prev) => ({ ...prev, [path]: true }));
    try {
      await unpublishWorkflow(path);
      toast.success("Workflow unpublished successfully", { id: toastId });
      const published = await getPublishedWorkflows();
      setPublishedWorkflows(published);
    } catch (err: any) {
      toast.error(`Failed to unpublish: ${err.message}`, { id: toastId });
    } finally {
      setPublishing((prev) => ({ ...prev, [path]: false }));
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
      {newModalMode && (
        <NewWorkflowModal
          onClose={() => setNewModalMode(null)}
          onSubmit={handleCreateNew}
        />
      )}
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex justify-between items-center sticky top-0 z-10 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-[#004170]">Workflows</h1>
          <p className="text-sm text-gray-500">Manage your Argo Workflows</p>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={() => setNewModalMode("code")}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded shadow-sm text-white bg-[#004170] hover:bg-[#002f52] focus:outline-none transition-colors"
          >
            <CodeBracketIcon
              className="-ml-1 mr-2 h-5 w-5"
              aria-hidden="true"
            />
            New (Code)
          </button>
          {config?.experimentalCanvas && (
            <button
              onClick={() => setNewModalMode("canvas")}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded shadow-sm text-white bg-[#0078b4] hover:bg-[#005f8f] focus:outline-none transition-colors"
            >
              <Squares2X2Icon
                className="-ml-1 mr-2 h-5 w-5"
                aria-hidden="true"
              />
              New (Canvas)
            </button>
          )}
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
                <button
                  onClick={() => setNewModalMode("code")}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded text-white bg-[#004170] hover:bg-[#002f52]"
                >
                  <CodeBracketIcon
                    className="-ml-1 mr-2 h-5 w-5"
                    aria-hidden="true"
                  />
                  Code Mode
                </button>
                {config?.experimentalCanvas && (
                  <button
                    onClick={() => setNewModalMode("canvas")}
                    className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded text-white bg-[#0078b4] hover:bg-[#005f8f]"
                  >
                    <Squares2X2Icon
                      className="-ml-1 mr-2 h-5 w-5"
                      aria-hidden="true"
                    />
                    Canvas Mode
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white shadow overflow-hidden rounded-md border border-gray-200">
            <ul className="divide-y divide-gray-200">
              {displayedWorkflows.map((workflow) => (
                <li key={workflow.path}>
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
                          {metadata[workflow.path]?.isParsing && (
                            <Spinner className="w-3 h-3 text-gray-400" />
                          )}
                          {!metadata[workflow.path]?.isParsing &&
                            metadata[workflow.path]?.kind && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-800 border border-blue-200">
                                {metadata[workflow.path].kind}
                              </span>
                            )}
                          {!metadata[workflow.path]?.isParsing &&
                            metadata[workflow.path]?.schedule && (
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800 border border-green-200"
                                title="Cron Schedule"
                              >
                                <ClockIcon className="w-3 h-3 mr-1" />
                                {metadata[workflow.path].schedule}
                              </span>
                            )}
                        </div>
                        <p className="text-xs text-gray-500 truncate mt-1">
                          {workflow.path.replace(/\.deleted$/, "")}
                          {!metadata[workflow.path]?.isParsing &&
                            metadata[workflow.path]?.entrypoint && (
                              <>
                                <span className="mx-2 text-gray-300">|</span>
                                <span title="Entrypoint">
                                  Entrypoint:{" "}
                                  <span className="font-mono text-[10px] bg-gray-100 px-1 py-0.5 rounded border border-gray-200">
                                    {metadata[workflow.path].entrypoint}
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
                          <button
                            onClick={() => handleExecute(workflow.path)}
                            className="inline-flex items-center px-3 py-1.5 border border-blue-300 shadow-sm text-xs font-medium rounded text-blue-700 bg-white hover:bg-blue-50 transition-colors"
                            title="Execute Workflow"
                          >
                            <PlayIcon className="h-4 w-4 mr-1.5" />
                            Execute
                          </button>
                          {metadata[workflow.path]?.kind === "CronWorkflow" && (
                            <Link
                              to={`/executions?cron=${workflow.path
                                .split("/")
                                .pop()
                                ?.replace(/\.ya?ml$/i, "")}`}
                              className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                              title="View Cron Executions"
                            >
                              <ClockIcon className="h-4 w-4 mr-1.5 text-gray-500" />
                              History
                            </Link>
                          )}
                          {config?.allowPublishing &&
                            metadata[workflow.path]?.kind ===
                              "WorkflowTemplate" && (
                              <div className="flex items-center space-x-1">
                                {!metadata[workflow.path]?.hasExecute && (
                                  <div
                                    className="group relative flex items-center"
                                    title="Templates must have an 'execute' entrypoint to be published."
                                  >
                                    <InformationCircleIcon className="h-5 w-5 text-gray-400 cursor-help" />
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2 bg-gray-900 text-white text-[10px] rounded shadow-lg z-50">
                                      Templates must have an 'execute'
                                      entrypoint to be published.
                                      <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-gray-900"></div>
                                    </div>
                                  </div>
                                )}
                                <button
                                  onClick={() => {
                                    const logicalName = workflow.path
                                      .split("/")
                                      .pop()
                                      ?.replace(/\.ya?ml$/i, "");
                                    if (
                                      publishedWorkflows.includes(
                                        logicalName || ""
                                      )
                                    ) {
                                      handleUnpublish(workflow.path);
                                    } else {
                                      const meta = metadata[workflow.path];
                                      if (!meta?.hasExecute) {
                                        return;
                                      }
                                      handlePublish(workflow.path);
                                    }
                                  }}
                                  disabled={
                                    publishing[workflow.path] ||
                                    (!metadata[workflow.path]?.hasExecute &&
                                      !publishedWorkflows.includes(
                                        workflow.path
                                          .split("/")
                                          .pop()
                                          ?.replace(/\.ya?ml$/i, "") || ""
                                      ))
                                  }
                                  className={`inline-flex items-center px-3 py-1.5 border shadow-sm text-xs font-medium rounded transition-colors ${
                                    publishedWorkflows.includes(
                                      workflow.path
                                        .split("/")
                                        .pop()
                                        ?.replace(/\.ya?ml$/i, "") || ""
                                    )
                                      ? "border-orange-300 text-orange-700 bg-white hover:bg-orange-50"
                                      : !metadata[workflow.path]?.hasExecute
                                        ? "border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed"
                                        : "border-green-300 text-green-700 bg-white hover:bg-green-50"
                                  }`}
                                  title={
                                    publishedWorkflows.includes(
                                      workflow.path
                                        .split("/")
                                        .pop()
                                        ?.replace(/\.ya?ml$/i, "") || ""
                                    )
                                      ? "Unpublish"
                                      : "Publish"
                                  }
                                >
                                  {publishing[workflow.path] ? (
                                    <ArrowPathIcon className="h-4 w-4 animate-spin" />
                                  ) : publishedWorkflows.includes(
                                      workflow.path
                                        .split("/")
                                        .pop()
                                        ?.replace(/\.ya?ml$/i, "") || ""
                                    ) ? (
                                    <>
                                      <CloudArrowDownIcon className="mr-1.5 h-4 w-4" />
                                      Unpublish
                                    </>
                                  ) : (
                                    <>
                                      <CloudArrowUpIcon className="mr-1.5 h-4 w-4" />
                                      Publish
                                    </>
                                  )}
                                </button>
                              </div>
                            )}
                          <div className="flex border border-gray-300 rounded overflow-hidden shadow-sm">
                            <Link
                              to={`/edit/code/${encodeURIComponent(workflow.path)}`}
                              className={`inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors ${config?.experimentalCanvas ? "border-r border-gray-300" : ""}`}
                              title="Edit in Code Mode"
                            >
                              <CodeBracketIcon className="mr-1.5 h-4 w-4 text-[#004170]" />
                              Code
                            </Link>
                            {config?.experimentalCanvas && (
                              <Link
                                to={`/edit/canvas/${encodeURIComponent(workflow.path)}`}
                                className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                                title="Edit in Canvas Mode"
                              >
                                <Squares2X2Icon className="mr-1.5 h-4 w-4 text-[#0078b4]" />
                                Canvas
                              </Link>
                            )}
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
