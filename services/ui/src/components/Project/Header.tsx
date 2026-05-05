import { ChevronLeftIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";

interface HeaderProps {
  name?: string;
}

const Header = ({ name }: HeaderProps) => {
  return (
    <>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center">
        <Link
          to="/"
          className="mr-4 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Back to Workflows"
        >
          <ChevronLeftIcon className="h-6 w-6 text-gray-600 dark:text-gray-300" />
        </Link>
        <form
          className="flex flex-col space-y-2 md:space-y-0 md:flex-row md:justify-between items-center w-full"
          autoComplete="off"
        >
          <input
            className={`
              bg-gray-100
              appearance-none
              w-full
              md:w-1/2
              lg:w-1/3
              block
              text-gray-700
              border
              border-gray-100
              dark:bg-gray-900
              dark:text-white
              dark:border-gray-900
              rounded
              py-2
              px-3
              leading-tight
              focus:outline-none
              focus:border-indigo-400
              focus:ring-0
            `}
            type="text"
            placeholder="Project name"
            autoComplete="off"
            id="name"
            name="name"
            readOnly
            value={name || "Untitled"}
          />
        </form>
      </div>
    </>
  );
};

export default Header;
