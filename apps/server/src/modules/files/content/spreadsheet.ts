import type { OfficeContentNode } from 'officeparser';
import {
  FileContentError,
  type FileContentParameters,
  type FileContentSheet,
} from './types.js';

function columnName(index: number): string {
  let label = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}

function parseRange(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new FileContentError(
      'INVALID_FILE_PARAMETERS',
      'excel_range 应为 A1:B20 格式。',
    );
  const match =
    /^\$?([A-Z]+)\$?([1-9]\d*)(?::\$?([A-Z]+)\$?([1-9]\d*))?$/i.exec(value);
  if (!match)
    throw new FileContentError(
      'INVALID_FILE_PARAMETERS',
      'excel_range 应为 A1:B20 格式。',
    );
  const column = (text: string) =>
    [...text.toUpperCase()].reduce(
      (sum, char) => sum * 26 + char.charCodeAt(0) - 64,
      0,
    ) - 1;
  const result = {
    firstRow: Number(match[2]) - 1,
    lastRow: Number(match[4] ?? match[2]) - 1,
    firstCol: column(match[1]!),
    lastCol: column(match[3] ?? match[1]!),
  };
  if (
    !Object.values(result).every(Number.isSafeInteger) ||
    result.lastRow < result.firstRow ||
    result.lastCol < result.firstCol
  )
    throw new FileContentError(
      'INVALID_FILE_PARAMETERS',
      'excel_range 的结束位置应在开始位置之后。',
    );
  return result;
}

const escapeCell = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');

/** Explicit worksheet samples, with source coordinates. Pass excel_rows="all" for ingestion/extraction. */
export function spreadsheetContent(
  nodes: OfficeContentNode[],
  parameters: FileContentParameters,
) {
  const selected = parameters.excel_sheet;
  if (
    selected !== undefined &&
    !(
      typeof selected === 'string' ||
      (typeof selected === 'number' &&
        Number.isInteger(selected) &&
        selected > 0)
    )
  )
    throw new FileContentError(
      'INVALID_FILE_PARAMETERS',
      'excel_sheet 应为工作表名称或从 1 开始的序号。',
    );
  const rowLimit = parameters.excel_rows ?? 20;
  if (
    rowLimit !== 'all' &&
    !(
      typeof rowLimit === 'number' &&
      Number.isInteger(rowLimit) &&
      rowLimit > 0
    )
  )
    throw new FileContentError(
      'INVALID_FILE_PARAMETERS',
      'excel_rows 应为正整数，或使用 all 读取完整数据。',
    );
  const range = parseRange(parameters.excel_range);
  const sheets: FileContentSheet[] = [];
  const output: string[] = [];
  for (const [index, sheet] of nodes
    .filter((node) => node.type === 'sheet')
    .entries()) {
    const name = sheet.metadata?.sheetName ?? `Sheet ${index + 1}`;
    if (selected !== undefined && selected !== name && selected !== index + 1)
      continue;
    const rows = (sheet.children ?? [])
      .filter((node) => node.type === 'row')
      .map((node, row) => ({
        row,
        cells: (node.children ?? [])
          .filter((cell) => cell.type === 'cell')
          .map((cell, col) => ({
            row: cell.metadata?.row ?? row,
            col: cell.metadata?.col ?? col,
            text: cell.text ?? '',
            rowSpan: cell.metadata?.rowSpan ?? 1,
            colSpan: cell.metadata?.colSpan ?? 1,
          })),
      }));
    let totalRows = 0,
      totalColumns = 0;
    for (const row of rows)
      for (const cell of row.cells) {
        totalRows = Math.max(totalRows, cell.row + cell.rowSpan);
        totalColumns = Math.max(totalColumns, cell.col + cell.colSpan);
      }
    const eligible = rows
      .map((row) => ({
        ...row,
        cells: row.cells.filter(
          (cell) =>
            !range ||
            (cell.row >= range.firstRow &&
              cell.row <= range.lastRow &&
              cell.col >= range.firstCol &&
              cell.col <= range.lastCol),
        ),
      }))
      .filter((row) => row.cells.some((cell) => cell.text.trim()));
    const sample = rowLimit === 'all' ? eligible : eligible.slice(0, rowLimit);
    const columns = [
      ...new Set(sample.flatMap((row) => row.cells.map((cell) => cell.col))),
    ].sort((a, b) => a - b);
    if (sample.length * columns.length > 1_000_000)
      throw new FileContentError(
        'FILE_PARSE_INCOMPLETE',
        '工作表范围展开后过大，请指定 excel_sheet、excel_range 或 excel_rows。',
      );
    const info: FileContentSheet = {
      name,
      index: index + 1,
      totalRows,
      totalColumns,
      selectedRows: sample.map((row) => (row.cells[0]?.row ?? row.row) + 1),
      sampled: sample.length < eligible.length,
      ...(typeof parameters.excel_range === 'string'
        ? { range: parameters.excel_range }
        : {}),
    };
    sheets.push(info);
    const lines = [
      `## Sheet: ${escapeCell(name)}`,
      `Rows: ${totalRows}; columns: ${totalColumns}. ${info.sampled ? `Sample of ${sample.length} non-empty rows; use excel_rows="all" for the complete selection.` : `All ${sample.length} non-empty rows in the selection.`}${info.range ? ` Range: ${info.range}.` : ''}`,
    ];
    if (columns.length) {
      lines.push(
        `| Row | ${columns.map(columnName).join(' | ')} |`,
        `| --- | ${columns.map(() => '---').join(' | ')} |`,
      );
      for (const row of sample) {
        const values = new Map(
          row.cells.map((cell) => [
            cell.col,
            `${escapeCell(cell.text)}${cell.colSpan > 1 || cell.rowSpan > 1 ? ` [merge ${columnName(cell.col)}${cell.row + 1}:${columnName(cell.col + cell.colSpan - 1)}${cell.row + cell.rowSpan}]` : ''}`,
          ]),
        );
        lines.push(
          `| ${(row.cells[0]?.row ?? row.row) + 1} | ${columns.map((col) => values.get(col) ?? '').join(' | ')} |`,
        );
      }
    }
    output.push(lines.join('\n'));
  }
  if (selected !== undefined && !sheets.length)
    throw new FileContentError(
      'SHEET_NOT_FOUND',
      '未找到指定工作表，请检查 excel_sheet。',
    );
  return { text: output.join('\n\n'), sheets };
}
