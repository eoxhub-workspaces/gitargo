import { ChevronLeftIcon, DocumentIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";

interface HeaderProps {
  name?: string;
}

const Header = ({ name }: HeaderProps) => {
  return (
    <>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center bg-white shadow-sm">
        <Link
          to="/"
          className="mr-4 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Back to Workflows"
        >
          <ChevronLeftIcon className="h-6 w-6 text-gray-600 dark:text-gray-300" />
        </Link>
        <div className="flex items-center space-x-2">
          <DocumentIcon className="h-5 w-5 text-[#004170]" />
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
            {name || "New Workflow"}
          </h2>
        </div>
      </div>
    </>
  );
};

export default Header;
