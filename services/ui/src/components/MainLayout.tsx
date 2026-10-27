import React, { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ClipboardDocumentListIcon,
  PlayIcon,
  ChartBarIcon
} from "@heroicons/react/24/outline";
import { getConfig, AppConfig } from "../utils/api";

const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [version, setVersion] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const location = useLocation();

  const isExecutions = location.pathname.startsWith("/executions");
  const isResources = location.pathname.startsWith("/resources");
  const isPackages = location.pathname.startsWith("/packages");
  const isApplications = location.pathname.startsWith("/applications");

  const isApplicationsDeployment =
    window.BASE_PATH?.includes("gitargo-applications") ||
    window.location.pathname.includes("gitargo-applications") ||
    window.location.pathname.includes("-applications");

  const isPackagesDeployment =
    window.BASE_PATH?.includes("gitargo-packages") ||
    window.location.pathname.includes("gitargo-packages") ||
    window.location.pathname.includes("-packages");

  const enableApplications =
    config?.enableApplications ?? isApplicationsDeployment;
  const enableOgcPackages = config?.enableOgcPackages ?? isPackagesDeployment;
  const enableWorkflows =
    config?.enableWorkflows ??
    (!isApplicationsDeployment && !isPackagesDeployment);

  // Hide top header when in standalone deployment or when navigating standalone views
  const hideHeader =
    isApplications ||
    isPackages ||
    isApplicationsDeployment ||
    isPackagesDeployment ||
    (!enableWorkflows && !enableOgcPackages && !enableApplications);

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setConfig(cfg);
        if (cfg?.version) setVersion(cfg.version);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col min-h-screen relative pb-6">
      {!hideHeader && (
        <nav className="bg-white border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16">
              <div className="flex">
                <div className="hidden sm:-my-px sm:flex sm:space-x-8">
                  {enableWorkflows && (
                    <Link
                      to="/"
                      className={`${
                        !isExecutions &&
                        !isResources &&
                        !isPackages &&
                        !isApplications
                          ? "border-[#004170] text-gray-900"
                          : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                      } inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-all`}
                    >
                      <ClipboardDocumentListIcon className="h-5 w-5 mr-2" />
                      Workflow Definitions
                    </Link>
                  )}
                  {enableWorkflows && (
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
                  )}
                  {enableWorkflows && (
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
                  )}
                </div>
              </div>
            </div>
          </div>
        </nav>
      )}
      <div className="flex-1 bg-gray-50">{children}</div>
      <div className="fixed bottom-1 right-2 text-[10px] font-mono text-gray-400 opacity-60 hover:opacity-100 transition-opacity select-none pointer-events-none z-50">
        v{version || "0.4.1"}
      </div>
    </div>
  );
};

export default MainLayout;
