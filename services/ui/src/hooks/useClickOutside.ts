import { useEffect, RefObject } from "react";

export const useClickOutside = <T extends HTMLElement = HTMLElement>(
  ref: RefObject<T>,
  onClickOutside: (event: MouseEvent | TouchEvent) => void
): void => {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) {
        return;
      }
      onClickOutside(event);
    };

    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);

    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [ref, onClickOutside]);
};

export default useClickOutside;
