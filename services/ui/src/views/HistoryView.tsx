import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getWorkflowHistory, CommitHistory, getWorkflow } from "../utils/api";
import {
  ChevronLeftIcon,
  UserIcon,
  CalendarIcon,
  ChatBubbleLeftEllipsisIcon,
  DocumentTextIcon
} from "@heroicons/react/24/outline";
import Spinner from "../components/global/Spinner";
import CodeEditor from "../components/CodeEditor";
import toast from "react-hot-toast";

const HistoryView: React.FC = () => {
  const { filename } = useParams<{ filename: string }>();
  const [history, setHistory] = useState<CommitHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // State for viewing YAML content of a specific commit
  const [viewingCommit, setViewingCommit] = useState<string | null>(null);
  const [commitYaml, setCommitYaml] = useState<string>("");
  const [yamlLoading, setYamlLoading] = useState(false);

  useEffect(() => {
    const fetchHistory = async () => {
      if (!filename) return;
      try {
        const data = await getWorkflowHistory(decodeURIComponent(filename));
        setHistory(data);
      } catch (err: any) {
        setError(err.message || "Failed to fetch history");
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [filename]);

  const fetchYamlForCommit = async (commitId: string) => {
    if (!filename) return;
    setYamlLoading(true);
    setViewingCommit(commitId);
    try {
      const yamlContent = await getWorkflow(
        decodeURIComponent(filename),
        commitId
      );
      setCommitYaml(yamlContent);
    } catch (err: any) {
      toast.error("Failed to load YAML for this commit.");
      setCommitYaml("Error loading content.");
    } finally {
      setYamlLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex items-center sticky top-0 z-10 shadow-sm">
        <Link
          to="/"
          className="mr-4 p-2 rounded-full hover:bg-gray-100 transition-colors"
        >
          <ChevronLeftIcon className="h-6 w-6 text-[#004170]" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-[#004170]">History</h1>
          <p className="text-sm text-gray-500 truncate max-w-2xl">
            {filename ? decodeURIComponent(filename) : ""}
          </p>
        </div>
      </header>

      <main className="p-8 flex flex-col xl:flex-row gap-8 max-w-screen-2xl mx-auto w-full">
        <div className="flex-1">
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
          ) : history.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-lg border-2 border-dashed border-gray-300">
              <p className="text-sm text-gray-500">
                No history found for this workflow.
              </p>
            </div>
          ) : (
            <div className="flow-root">
              <ul className="-mb-8">
                {history.map((commit, commitIdx) => (
                  <li key={commit.id}>
                    <div className="relative pb-8">
                      {commitIdx !== history.length - 1 ? (
                        <span
                          className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-gray-200"
                          aria-hidden="true"
                        />
                      ) : null}
                      <div className="relative flex space-x-3">
                        <div>
                          <span className="h-8 w-8 rounded-full bg-blue-500 flex items-center justify-center ring-8 ring-white">
                            <ChatBubbleLeftEllipsisIcon
                              className="h-5 w-5 text-white"
                              aria-hidden="true"
                            />
                          </span>
                        </div>
                        <div className="min-w-0 flex-1 pt-1.5 flex justify-between space-x-4">
                          <div>
                            <p className="text-sm text-gray-900 font-semibold">
                              {commit.title}
                            </p>
                            <div className="mt-1 flex items-center space-x-4 text-xs text-gray-500">
                              <span className="flex items-center">
                                <UserIcon className="mr-1 h-3 w-3" />
                                {commit.author_name}
                              </span>
                              <span className="flex items-center">
                                <CalendarIcon className="mr-1 h-3 w-3" />
                                {new Date(
                                  commit.committed_date
                                ).toLocaleString()}
                              </span>
                            </div>
                            {commit.message !== commit.title && (
                              <p className="mt-2 text-sm text-gray-600 whitespace-pre-wrap">
                                {commit.message}
                              </p>
                            )}
                          </div>
                          <div className="text-right text-xs whitespace-nowrap text-gray-500 flex flex-col items-end space-y-2">
                            <code className="bg-gray-100 px-1 py-0.5 rounded">
                              {commit.short_id}
                            </code>
                            <button
                              onClick={() => fetchYamlForCommit(commit.id)}
                              className={`flex items-center space-x-1 px-2 py-1 rounded transition-colors border ${
                                viewingCommit === commit.id
                                  ? "bg-blue-50 border-blue-200 text-blue-700"
                                  : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"
                              }`}
                            >
                              <DocumentTextIcon className="w-3 h-3" />
                              <span>View YAML</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {viewingCommit && (
          <div
            className="flex-1 bg-white border border-gray-200 rounded shadow-sm overflow-hidden flex flex-col"
            style={{ minHeight: "600px" }}
          >
            <div className="bg-gray-100 px-4 py-2 border-b border-gray-200 flex justify-between items-center">
              <span className="text-sm font-semibold text-gray-700">
                YAML at commit {viewingCommit.substring(0, 8)}
              </span>
              <button
                onClick={() => setViewingCommit(null)}
                className="text-gray-500 hover:text-gray-700 text-xs font-semibold"
              >
                Close
              </button>
            </div>
            <div className="flex-1 relative">
              {yamlLoading ? (
                <div className="absolute inset-0 flex justify-center items-center bg-white bg-opacity-75 z-10">
                  <Spinner className="text-blue-500" />
                </div>
              ) : null}
              <CodeEditor
                data={commitYaml}
                language="yaml"
                onChange={() => {}}
                disabled={true}
                lineWrapping={false}
                height="100%"
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default HistoryView;
