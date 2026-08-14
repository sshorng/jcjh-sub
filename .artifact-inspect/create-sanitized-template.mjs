import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = String.raw`C:\Users\sshor\OneDrive\桌面\格式.xlsx`;
const outputPath = String.raw`G:\我的雲端硬碟\AI_Agent\100_Todo\projects\vibe-coding\school-substitution-sys\templates\accounting-template.xlsx`;
const previewDir = String.raw`C:\tmp\school-substitution-sys-artifact-inspect\sanitized`;

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const cleanup = [
  { sheet: "115.6.1-7.3 超鐘點", data: "A3:P26", total: "A27:P27", note: "B28" },
  { sheet: "115.6.1-7.10  兼課", data: "A3:N9", total: "A10:N10", note: "B11" },
  { sheet: "115.6.1-6.30公假代課", data: "A3:O13", total: "A14:O14" },
  { sheet: "115.6.1-6.30  自付代課", data: "A3:J13", total: "A14:J14" },
  { sheet: "115.6.1-6.30代導鐘點", data: "A3:J10", total: "A11:J11" },
];

for (const item of cleanup) {
  const sheet = workbook.worksheets.getItem(item.sheet);
  sheet.getRange(item.data).clear({ applyTo: "contents" });
  sheet.getRange(item.total).clear({ applyTo: "contents" });
  if (item.note) sheet.getRange(item.note).clear({ applyTo: "contents" });
}

await fs.mkdir(previewDir, { recursive: true });
for (const item of cleanup) {
  const preview = await workbook.render({
    sheetName: item.sheet,
    autoCrop: "all",
    scale: 1.5,
    format: "png",
  });
  const safe = item.sheet.replace(/[<>:"/\\|?*]/g, "_");
  await fs.writeFile(`${previewDir}/${safe}.png`, new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, previewDir, sheets: cleanup.map((x) => x.sheet) }, null, 2));
