import React, { useState, useEffect } from "react";
import Modal from "./Modal";
import {
  getWorkspaceFiles,
  getWorkspaceFileDownloadUrl,
  WorkspaceFileItem
} from "../utils/api";
import {
  FolderIcon,
  DocumentIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowDownTrayIcon
} from "@heroicons/react/24/outline";

interface WorkspaceBrowserProps {
  onClose: () => void;
  initialPath?: string;
  rootPath?: string;
}

export const WorkspaceBrowser: React.FC<WorkspaceBrowserProps> = ({
  onClose,
  initialPath = "application_packages_executions",
  rootPath
}) => {
  const effectiveRoot = rootPath ?? initialPath;
  const [currentPath, setCurrentPath] = useState<string>(initialPath);
  const [files, setFiles] = useState<WorkspaceFileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean>(true);

  const fetchFiles = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getWorkspaceFiles(path);
      setFiles(data.files);
      setExists(data.exists);
      setCurrentPath(data.currentPath);
    } catch (err: any) {
      setError(err.message || "Failed to load files.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles(currentPath);
  }, [currentPath]);

  const handleNavigate = (folderName: string) => {
    const newPath = currentPath
      ? `${currentPath.replace(/\/$/, "")}/${folderName}`
      : folderName;
    setCurrentPath(newPath);
  };

  const normalizedCurrent = (currentPath || "").replace(/\/$/, "");
  const normalizedRoot = (effectiveRoot || "").replace(/\/$/, "");
  const isAtRoot =
    normalizedCurrent === normalizedRoot ||
    normalizedCurrent.length <= normalizedRoot.length;

  const handleGoBack = () => {
    if (isAtRoot) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = parts.join("/");
    if (parentPath.length >= normalizedRoot.length) {
      setCurrentPath(parentPath);
    } else {
      setCurrentPath(normalizedRoot);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "-";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  return (
    <Modal title="Execution Results Browser" onHide={onClose}>
      <div className="p-4 flex flex-col space-y-4 max-w-4xl w-full flex-1 min-h-0 overflow-hidden dark:bg-gray-900 dark:text-gray-100">
        {/* Navigation Bar */}
        <div className="flex items-center justify-between border-b pb-3 dark:border-gray-700">
          <div className="flex items-center space-x-2">
            <button
              onClick={handleGoBack}
              disabled={isAtRoot}
              className={`p-1.5 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 ${
                isAtRoot ? "opacity-40 cursor-not-allowed" : ""
              }`}
              title="Go Back"
            >
              <ArrowLeftIcon className="w-5 h-5" />
            </button>
            <span className="font-mono text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded">
              /workspace/{currentPath || ""}
            </span>
          </div>

          <button
            onClick={() => fetchFiles(currentPath)}
            className="p-1.5 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Refresh"
          >
            <ArrowPathIcon className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Content Area */}
        {loading ? (
          <div className="flex-1 flex justify-center items-center py-12">
            <span className="text-gray-500">Loading directory...</span>
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 text-red-600 rounded dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        ) : !exists ? (
          <div className="flex-1 flex flex-col items-center justify-center py-12 text-gray-500">
            <p>Directory does not exist yet or no outputs have been saved.</p>
            <p className="text-xs text-gray-400 mt-1">
              Path: /workspace/{currentPath}
            </p>
          </div>
        ) : files.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-12 text-gray-500">
            This directory is empty.
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto rounded border border-gray-200 dark:border-gray-700 max-h-[60vh]">
            <table className="w-full text-left text-sm text-gray-600 dark:text-gray-300">
              <thead className="sticky top-0 z-10 text-xs text-gray-700 uppercase bg-gray-100 dark:bg-gray-800 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700 shadow-sm">
                <tr>
                  <th className="px-4 py-2.5 bg-gray-100 dark:bg-gray-800">Name</th>
                  <th className="px-4 py-2.5 bg-gray-100 dark:bg-gray-800">Size</th>
                  <th className="px-4 py-2.5 bg-gray-100 dark:bg-gray-800">Modified</th>
                  <th className="px-4 py-2.5 bg-gray-100 dark:bg-gray-800 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                {files.map((file) => {
                  const filePath = currentPath
                    ? `${currentPath.replace(/\/$/, "")}/${file.name}`
                    : file.name;

                  return (
                    <tr
                      key={file.name}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <td className="px-4 py-3 font-medium flex items-center space-x-2">
                        {file.isDirectory ? (
                          <FolderIcon className="w-5 h-5 text-amber-500 flex-shrink-0" />
                        ) : (
                          <DocumentIcon className="w-5 h-5 text-blue-500 flex-shrink-0" />
                        )}
                        {file.isDirectory ? (
                          <button
                            onClick={() => handleNavigate(file.name)}
                            className="text-blue-600 dark:text-blue-400 hover:underline font-semibold"
                          >
                            {file.name}
                          </button>
                        ) : (
                          <span>{file.name}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{formatSize(file.size)}</td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {file.mtime
                          ? new Date(file.mtime).toLocaleString()
                          : "-"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!file.isDirectory && (
                          <a
                            href={getWorkspaceFileDownloadUrl(filePath)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center space-x-1 text-xs text-blue-600 dark:text-blue-400 hover:underline font-semibold"
                            title="Download / View"
                          >
                            <ArrowDownTrayIcon className="w-4 h-4" />
                            <span>Download</span>
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
};
