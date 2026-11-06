export const commentOutYaml = (yaml: string): string => {
  if (!yaml) return "";
  return yaml
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("#")) return line;
      return `# ${line}`;
    })
    .join("\n");
};

export const uncommentYaml = (yaml: string): string => {
  if (!yaml) return "";
  return yaml
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return line.slice(2);
      if (line.startsWith("#")) return line.slice(1);
      return line;
    })
    .join("\n");
};

export const isYamlDisabled = (yaml: string): boolean => {
  if (!yaml) return false;
  const lines = yaml.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => line.trim().startsWith("#"));
};
