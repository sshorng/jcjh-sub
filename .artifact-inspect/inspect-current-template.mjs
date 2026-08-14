import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "file:///C:/tmp/school-substitution-sys-artifact-inspect/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const inputPath = process.argv[2];
const outputDir = process.argv[3];
if (!inputPath || !outputDir) throw new Error("usage: inspect-current-template.mjs <xlsx> <output-dir>");

await fs.mkdir(outputDir, { recursive: true });
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 20000,
  tableMaxRows: 20,
  tableMaxCols: 30,
  tableMaxCellChars: 160,
});
const sheetInfo = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 8000 });
const summaryText = summary?.ndjson ?? String(summary);
const sheetInfoText = sheetInfo?.ndjson ?? String(sheetInfo);
await fs.writeFile(`${outputDir}/summary.ndjson`, summaryText, "utf8");
await fs.writeFile(`${outputDir}/sheet-info.ndjson`, sheetInfoText, "utf8");

const sheets = [];
for (const line of sheetInfoText.split(/\r?\n/).filter(Boolean)) {
  try {
    const record = JSON.parse(line);
    if (record.name) sheets.push(record.name);
  } catch {}
}

const direct = [];
for (const sheetName of sheets) {
  const sheet = workbook.worksheets.getItem(sheetName);
  const range = sheet.getRange("A1:Z100");
  direct.push({ sheetName, values: range.values, formulas: range.formulas });
}
await fs.writeFile(`${outputDir}/direct.json`, JSON.stringify(direct, null, 2), "utf8");const regions = [];
for (const sheetName of sheets) {
  const region = await workbook.inspect({
    kind: "region",
    sheetId: sheetName,
    range: "A1:Z100",
    include: "values,formulas",
    maxChars: 30000,
    tableMaxRows: 100,
    tableMaxCols: 26,
  });
  regions.push({ sheetName, region: region?.ndjson ?? String(region) });
  const safeName = sheetName.replace(/[<>:"/\\|?*]/g, "_");
  const preview = await workbook.render({ sheetName, autoCrop: "all", scale: 1.5, format: "png" });
  await fs.writeFile(`${outputDir}/${safeName}.png`, new Uint8Array(await preview.arrayBuffer()));
}
await fs.writeFile(`${outputDir}/regions.json`, JSON.stringify(regions, null, 2), "utf8");
console.log(JSON.stringify({ outputDir, sheets, summary: summaryText, sheetInfo: sheetInfoText }, null, 2));
