import React from "react";
import { Tooltip, IconButton } from "@mui/material";
import { InformationCircleIcon } from "@heroicons/react/24/outline";

interface InfoButtonProps {
  text: string;
}

export const InfoButton: React.FC<InfoButtonProps> = ({ text }) => {
  return (
    <Tooltip
      title={<span className="text-xs">{text}</span>}
      arrow
      placement="top"
      enterTouchDelay={0}
    >
      <IconButton
        size="small"
        className="ml-1 p-0.5 text-gray-400 hover:text-gray-600 focus:outline-none"
        sx={{
          padding: "2px",
          "&:hover": {
            backgroundColor: "transparent",
            color: "#4b5563"
          }
        }}
      >
        <InformationCircleIcon className="w-4 h-4" />
      </IconButton>
    </Tooltip>
  );
};
