import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getWorkflows, WorkflowFile } from '../utils/api';
import { PlusIcon, DocumentIcon, ClockIcon, PencilIcon } from '@heroicons/react/24/outline';
import Spinner from '../components/global/Spinner';

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
        setError(err.message || 'Failed to fetch workflows');
      } finally {
        setLoading(false);
      }
    };

    fetchWorkflows();
  }, []);

  return (
    <div className="md:pl-16 flex flex-col flex-1 min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex justify-between items-center sticky top-0 z-10">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Workflows</h1>
          <p className="text-sm text-gray-500">Manage your Argo Workflows from GitLab</p>
        </div>
        <Link
          to="/new"
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none"
        >
          <PlusIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
          Create New
        </Link>
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
                <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
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
            <h3 className="mt-2 text-sm font-medium text-gray-900">No workflows found</h3>
            <p className="mt-1 text-sm text-gray-500">Get started by creating a new workflow.</p>
            <div className="mt-6">
              <Link
                to="/new"
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                <PlusIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
                New Workflow
              </Link>
            </div>
          </div>
        ) : (
          <div className="bg-white shadow overflow-hidden sm:rounded-md">
            <ul className="divide-y divide-gray-200">
              {workflows.map((workflow) => (
                <li key={workflow.id}>
                  <div className="px-6 py-4 flex items-center justify-between hover:bg-gray-50">
                    <div className="flex items-center min-w-0 flex-1">
                      <div className="flex-shrink-0">
                        <DocumentIcon className="h-8 w-8 text-blue-500" />
                      </div>
                      <div className="ml-4 flex-1">
                        <p className="text-sm font-medium text-blue-600 truncate">{workflow.name}</p>
                        <p className="text-sm text-gray-500 truncate">{workflow.path}</p>
                      </div>
                    </div>
                    <div className="ml-4 flex-shrink-0 flex space-x-2">
                      <Link
                        to={`/edit/${encodeURIComponent(workflow.path)}`}
                        className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50"
                      >
                        <PencilIcon className="-ml-0.5 mr-1 h-4 w-4" />
                        Edit
                      </Link>
                      <Link
                        to={`/history/${encodeURIComponent(workflow.path)}`}
                        className="inline-flex items-center px-3 py-1.5 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50"
                      >
                        <ClockIcon className="-ml-0.5 mr-1 h-4 w-4" />
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
