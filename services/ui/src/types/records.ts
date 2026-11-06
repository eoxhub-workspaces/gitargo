import { ReactElement } from "react";

export interface IRecordsProps {
  collapsible?: boolean;
  defaultOpen?: boolean;
  title: string;
  name: string;
  fields: (index: number) => IFieldType[];
  newValue: any;
  renderLayout?: (elements: ReactElement[]) => ReactElement;
  renderField?: (element: ReactElement, field: IFieldType) => ReactElement;
  renderRemove?: (element: ReactElement) => ReactElement;
  renderBorder?: () => ReactElement;
}

export interface IFieldType {
  name: string;
  placeholder?: string;
  required?: boolean;
  type: "text" | "toggle" | "records";
  options?:
    | {
        text: string;
        value: string;
      }[]
    | IRecordsProps;
}

export interface IRecordProps {
  fields: IFieldType[];
  index: number;
  onRemove: (index: number) => void;
  name?: string;
  renderLayout?: (elements: ReactElement[]) => ReactElement;
  renderField?: (element: ReactElement, field: IFieldType) => ReactElement;
  renderRemove?: (element: ReactElement) => ReactElement;
}
