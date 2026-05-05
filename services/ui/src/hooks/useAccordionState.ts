import { useCallback, useState } from "react";

export interface IAccordionState {
  open: boolean;
  toggle: () => void;
}

export const useAccordionState = (
  id: string,
  defaultOpen: boolean
): IAccordionState => {
  const getInitialState = () => {
    const item = localStorage.getItem("accordions");
    const configuration: Record<string, boolean> = item ? JSON.parse(item) : {};
    return configuration[id] ?? defaultOpen;
  };
  const [open, setOpen] = useState(getInitialState);

  const handleToggle = useCallback(() => {
    setOpen((prevOpen) => {
      const newOpen = !prevOpen;
      const item = localStorage.getItem("accordions");
      const configuration: Record<string, boolean> = item
        ? JSON.parse(item)
        : {};
      configuration[id] = newOpen;
      localStorage.setItem(
        "accordions",
        JSON.stringify(configuration, null, 4)
      );
      return newOpen;
    });
  }, [id]);

  return {
    toggle: handleToggle,
    open
  };
};
