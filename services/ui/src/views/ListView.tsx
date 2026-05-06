import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkflows, WorkflowFile } from "../utils/api";
import {
  PlusIcon,
  DocumentIcon,
  ClockIcon,
  CodeBracketIcon,
  Squares2X2Icon
} from "@heroicons/react/24/outline";
import Spinner from "../components/global/Spinner";

const ListView: React.FC = () => {
  const [workflows, setWorkflows] = useState<WorkflowFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchWorkflows = async () => {
      try {
        const data = await getWorkflows();
        setWorkflows(data);
      } catch (err: any) {
        setError(err.message || "Failed to fetch workflows");
      } finally {
        setLoading(false);
      }
    };

    fetchWorkflows();
  }, []);

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
        ) : workflows.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg border-2 border-dashed border-gray-300">
            <DocumentIcon className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">
              No workflows found
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Get started by creating a new workflow.
            </p>
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
          </div>
        ) : (
          <div className="bg-white shadow overflow-hidden rounded-md border border-gray-200">
            <ul className="divide-y divide-gray-200">
              {workflows.map((workflow) => (
                <li key={workflow.id}>
                  <div className="px-6 py-4 flex items-center justify-between hover:bg-[#f8fbfc] transition-colors">
                    <div className="flex items-center min-w-0 flex-1">
                      <div className="flex-shrink-0">
                        <DocumentIcon className="h-8 w-8 text-[#004170]" />
                      </div>
                      <div className="ml-4 flex-1">
                        <p className="text-sm font-medium text-[#004170] truncate">
                          {workflow.name}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {workflow.path}
                        </p>
                      </div>
                    </div>
                    <div className="ml-4 flex-shrink-0 flex items-center space-x-2">
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
                      >
                        <ClockIcon className="-ml-0.5 mr-1 h-4 w-4 text-gray-500" />
                        History
                      </Link>
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
