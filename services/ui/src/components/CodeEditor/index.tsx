import React, { useEffect } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";

// The window.MonacoEnvironment needs to be set up to tell Monaco where to find the workers.
// The workers must be served from the public directory (static/js).
window.MonacoEnvironment = {
  getWorkerUrl: function (_moduleId: any, label: string) {
    const base = window.BASE_PATH || "";
    const workerPath = (path: string) => {
      // Ensure we don't have double slashes and it's absolute from the root
      const p = `${base}/static/js/${path}`.replace(/\/+/g, "/");
      return p;
    };

    if (label === "yaml") {
      return workerPath("yaml.worker.js");
    }
    if (label === "json") {
      return workerPath("json.worker.js");
    }
    return workerPath("editor.worker.js");
  }
};

interface ICodeEditorProps {
  data: string;
  language: string;
  onChange: (value: string) => void;
  disabled: boolean;
  lineWrapping: boolean;
  height: string | number;
}

const CodeEditor = (props: ICodeEditorProps) => {
  const { data, language, onChange, disabled, lineWrapping, height } = props;
  const monaco = useMonaco();

  useEffect(() => {
    if (monaco && language === "yaml") {
      import("monaco-yaml")
        .then(({ configureMonacoYaml }) => {
          configureMonacoYaml(monaco, {
            enableSchemaRequest: true,
            hover: true,
            completion: true,
            validate: true,
            format: true,
            schemas: [
              {
                uri: "https://raw.githubusercontent.com/argoproj/argo-workflows/master/api/jsonschema/schema.json",
                fileMatch: ["*"]
              }
            ]
          });
        })
        .catch(console.error);
    }
  }, [monaco, language]);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      onChange(value);
    }
  };

  return (
    <div className="w-full h-full" style={{ height }}>
      <Editor
        height={typeof height === "number" ? `${height}px` : height}
        language={language}
        theme="vs-light"
        value={data}
        onChange={handleEditorChange}
        options={{
          readOnly: disabled,
          wordWrap: lineWrapping ? "on" : "off",
          minimap: { enabled: false },
          formatOnPaste: true,
          formatOnType: true,
          automaticLayout: true,
          scrollBeyondLastLine: true,
          fontSize: 14,
          tabSize: 2,
          wordBasedSuggestions: "currentDocument",
          acceptSuggestionOnEnter: "on",
          suggestOnTriggerCharacters: true,
          quickSuggestions: {
            other: true,
            comments: false,
            strings: true
          }
        }}
      />
    </div>
  );
};

export default CodeEditor;
