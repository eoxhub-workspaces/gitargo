import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getWorkflowHistory, CommitHistory } from "../utils/api";
import {
  ChevronLeftIcon,
  UserIcon,
  CalendarIcon,
  ChatBubbleLeftEllipsisIcon
} from "@heroicons/react/24/outline";
import Spinner from "../components/global/Spinner";

const HistoryView: React.FC = () => {
  const { filename } = useParams<{ filename: string }>();
  const [history, setHistory] = useState<CommitHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="md:pl-16 flex flex-col flex-1 min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex items-center sticky top-0 z-10">
        <Link
          to="/"
          className="mr-4 p-2 rounded-full hover:bg-gray-100 transition-colors"
        >
          <ChevronLeftIcon className="h-6 w-6 text-gray-600" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-800">History</h1>
          <p className="text-sm text-gray-500 truncate max-w-2xl">
            {filename ? decodeURIComponent(filename) : ""}
          </p>
        </div>
      </header>

      <main className="p-8">
        {loading ? (
          <div className="flex justify-center items-center h-64">
            <Spinner className="text-blue-500" />
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
                              {new Date(commit.committed_date).toLocaleString()}
                            </span>
                          </div>
                          {commit.message !== commit.title && (
                            <p className="mt-2 text-sm text-gray-600 whitespace-pre-wrap">
                              {commit.message}
                            </p>
                          )}
                        </div>
                        <div className="text-right text-xs whitespace-nowrap text-gray-500">
                          <code className="bg-gray-100 px-1 py-0.5 rounded">
                            {commit.short_id}
                          </code>
                        </div>
                      </div>
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

export default HistoryView;
