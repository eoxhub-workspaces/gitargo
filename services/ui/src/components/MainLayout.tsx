import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ClipboardDocumentListIcon,
  PlayIcon,
  ChartBarIcon,
  CpuChipIcon
} from "@heroicons/react/24/outline";
import { getConfig, AppConfig } from "../utils/api";

const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const isExecutions = location.pathname.startsWith("/executions");
  const isResources = location.pathname.startsWith("/resources");
  const isApplications = location.pathname.startsWith("/applications");

  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err) =>
        console.error("Failed to load config in MainLayout", err)
      );
  }, []);

  return (
    <div className="flex flex-col min-h-screen">
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="hidden sm:-my-px sm:flex sm:space-x-8">
                <Link
                  to="/"
                  className={`${
                    !isExecutions && !isResources && !isApplications
                      ? "border-[#004170] text-gray-900"
                      : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                  } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-all`}
                >
                  <ClipboardDocumentListIcon className="h-5 w-5 mr-2" />
                  Workflow Definitions
                </Link>
                <Link
                  to="/executions"
                  className={`${
                    isExecutions
                      ? "border-[#004170] text-gray-900"
                      : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                  } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-all`}
                >
                  <PlayIcon className="h-5 w-5 mr-2" />
                  Workflow Executions
                </Link>
                <Link
                  to="/resources"
                  className={`${
                    isResources
                      ? "border-[#004170] text-gray-900"
                      : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                  } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-all`}
                >
                  <ChartBarIcon className="h-5 w-5 mr-2" />
                  Resources Dashboard
                </Link>
                {config?.enableApplications && (
                  <Link
                    to="/applications"
                    className={`${
                      isApplications
                        ? "border-[#004170] text-gray-900"
                        : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                    } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-all`}
                  >
                    <CpuChipIcon className="h-5 w-5 mr-2" />
                    Applications
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>
      <div className="flex-1 bg-gray-50">{children}</div>
    </div>
  );
};

export default MainLayout;
