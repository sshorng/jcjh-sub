import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = String.raw`C:\Users\sshor\OneDrive\桌面\格式.xlsx`;
const outputDir = String.raw`C:\tmp\school-substitution-sys-artifact-inspect`;

await fs.mkdir(outputDir, { recursive: true });

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 12000,
  tableMaxRows: 12,
  tableMaxCols: 16,
  tableMaxCellChars: 120,
});

const sheetInfo = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 6000,
});

const summaryText = summary?.ndjson ?? String(summary);
const sheetInfoText = sheetInfo?.ndjson ?? String(sheetInfo);
await fs.writeFile(`${outputDir}/summary.ndjson`, summaryText, "utf8");
await fs.writeFile(`${outputDir}/sheet-info.ndjson`, sheetInfoText, "utf8");

const sheets = [];
for (const line of sheetInfoText.split(/\r?\n/).filter(Boolean)) {
  try {
    const record = JSON.parse(line);
    if (record.name) sheets.push(record.name);
  } catch {
    // Ignore non-JSON diagnostic lines.
  }
}

const regions = [];
for (const sheetName of sheets) {
  const region = await workbook.inspect({
    kind: "region",
    sheetId: sheetName,
    range: "A1:Z100",
    include: "values,formulas",
    maxChars: 18000,
    tableMaxRows: 100,
    tableMaxCols: 26,
  });
  const regionText = region?.ndjson ?? String(region);
  regions.push({ sheetName, region: regionText });

  const safeName = sheetName.replace(/[<>:"/\\|?*]/g, "_");
  const preview = await workbook.render({
    sheetName,
    autoCrop: "all",
    scale: 1.5,
    format: "png",
  });
  await fs.writeFile(`${outputDir}/${safeName}.png`, new Uint8Array(await preview.arrayBuffer()));
}

await fs.writeFile(`${outputDir}/regions.json`, JSON.stringify(regions, null, 2), "utf8");
console.log(JSON.stringify({ outputDir, sheets, summary: summaryText, sheetInfo: sheetInfoText }, null, 2));
