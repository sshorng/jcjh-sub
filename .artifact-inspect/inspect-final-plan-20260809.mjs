import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from 'file:///C:/tmp/school-substitution-sys-artifact-inspect/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';

const inputPath = 'C:/tmp/school-substitution-sys-exceljs-verify/accounting-export-plan.xlsx';
const outputDir = 'C:/tmp/school-substitution-sys-artifact-inspect/final-plan-20260809';
await fs.mkdir(outputDir, { recursive: true });
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheetInfo = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 6000 });
const sheetText = sheetInfo?.ndjson ?? String(sheetInfo);
const sheets = sheetText.split(/\r?\n/).filter(Boolean).flatMap(line => {
  try { const item = JSON.parse(line); return item.name ? [item.name] : []; } catch { return []; }
});
const selected = sheets.filter(name => name.includes('超鐘點'));
const regions = {};
for (const sheetName of selected) {
  const region = await workbook.inspect({ kind: 'region', sheetId: sheetName, range: 'A1:O32', include: 'values,formulas', maxChars: 30000, tableMaxRows: 40, tableMaxCols: 15 });
  regions[sheetName] = region?.ndjson ?? String(region);
  const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1.5, format: 'png' });
  const safeName = sheetName.replace(/[<>:"/\\|?*]/g, '_');
  await fs.writeFile(`${outputDir}/${safeName}.png`, new Uint8Array(await preview.arrayBuffer()));
}
await fs.writeFile(`${outputDir}/sheet-info.ndjson`, sheetText, 'utf8');
await fs.writeFile(`${outputDir}/regions.json`, JSON.stringify(regions, null, 2), 'utf8');
console.log(JSON.stringify({ outputDir, sheets, selected, regions }, null, 2));
