import React, { useState } from "react";
import Modal from "../Modal";

export interface IDefaultIngestionModalProps {
  onConfirm: () => void;
  onDecline: (rememberChoice: boolean) => void;
}

export const DefaultIngestionModal: React.FC<IDefaultIngestionModalProps> = ({
  onConfirm,
  onDecline
}) => {
  const [rememberChoice, setRememberChoice] = useState(false);

  return (
    <Modal onHide={() => onDecline(false)} title="Apply Environment Defaults">
      <div className="p-4 space-y-4 max-w-lg">
        <p className="text-sm text-gray-700">
          This workflow definition does not have global{" "}
          <strong>service account</strong> or <strong>tolerations</strong> set.
        </p>
        <p className="text-sm text-gray-700">
          These settings are important because:
        </p>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>
            <strong>Service Accounts</strong> provide the necessary permissions
            for the workflow to execute properly.
          </li>
          <li>
            <strong>Tolerations</strong> ensure that the workflow pods are
            scheduled on the correct nodes (e.g., worker nodes).
          </li>
        </ul>
        <p className="text-sm text-gray-700">
          Would you like to automatically inject the environment defaults into
          this workflow before saving?
        </p>

        <div className="mt-4 flex items-center bg-gray-50 p-3 rounded-md border border-gray-200">
          <input
            id="remember-choice"
            type="checkbox"
            checked={rememberChoice}
            onChange={(e) => setRememberChoice(e.target.checked)}
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded cursor-pointer"
          />
          <label
            htmlFor="remember-choice"
            className="ml-2 block text-sm text-gray-900 cursor-pointer select-none"
          >
            Do not ask again for this workflow
          </label>
        </div>

        <div className="flex justify-end space-x-3 mt-6 pt-4 border-t border-gray-200">
          <button
            type="button"
            className="px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none transition-colors"
            onClick={() => onDecline(rememberChoice)}
          >
            No, save as is
          </button>
          <button
            type="button"
            className="px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-[#004170] hover:bg-[#002f52] focus:outline-none transition-colors"
            onClick={onConfirm}
          >
            Yes, inject defaults
          </button>
        </div>
      </div>
    </Modal>
  );
};
