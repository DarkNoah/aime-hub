type SkillRequest = {
  skillName?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
};

// Mastra returns plain text, including not-found errors and binary/range notices.
export function parseSkillOutput(output: unknown, request: SkillRequest) {
  if (typeof output !== 'string') return null;
  const { skillName, path, startLine, endLine } = request;
  const isError =
    (skillName !== undefined &&
      output.startsWith(
        `Skill "${skillName}" not found. Available skills: `,
      )) ||
    (skillName !== undefined &&
      path !== undefined &&
      (output === `File "${path}" not found in skill "${skillName}".` ||
        output.startsWith(
          `File "${path}" not found in skill "${skillName}".\nAvailable files: `,
        )));
  const notice =
    path !== undefined &&
    (/^Binary file: [\s\S]+ \(\d+ bytes\)$/.test(output) ||
      (output.startsWith(`File "${path}" has `) &&
        /lines \(valid range 1-\d+\)\. Requested (?:startLine|range) /.test(
          output,
        )));
  const newline = output.indexOf('\n');
  const header = output.slice(0, newline).replace(/\r$/, '');
  const range =
    path !== undefined &&
    (startLine !== undefined || endLine !== undefined) &&
    newline !== -1 &&
    header.startsWith(`${path} `)
      ? header.slice(path.length + 1).match(/^\(lines (\d+)-(\d+) of (\d+)\)$/)
      : null;

  return {
    content: range ? output.slice(newline + 1) : output,
    isError,
    notice,
    range: range
      ? {
          start: Number(range[1]),
          end: Number(range[2]),
          total: Number(range[3]),
        }
      : undefined,
  };
}
