import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "file:///C:/tmp/school-substitution-sys-artifact-inspect/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const inputPath = process.argv[2];
const outputDir = process.argv[3];
if (!inputPath || !outputDir) throw new Error("usage: probe-mentor-layout-j.mjs <xlsx> <output-dir>");
await fs.mkdir(outputDir, { recursive: true });
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheet = workbook.worksheets.getItem("代導鐘點");
const note = sheet.getRange("J3:J4");
note.values = [["教學組指定代導教師\n1、8/4代張老師1節"], ["教學組指定代導教師\n2、8/5代張老師1節"]];
note.format.wrapText = true;
sheet.getRange("J3:J4").format.rowHeight = 64;
const render = await workbook.render({ sheetName: "代導鐘點", range: "A1:J8", scale: 1.5, format: "png" });
await fs.writeFile(`${outputDir}/mentor-layout-j.png`, new Uint8Array(await render.arrayBuffer()));
await (await SpreadsheetFile.exportXlsx(workbook)).save(`${outputDir}/mentor-layout-j.xlsx`);
console.log(JSON.stringify({ outputDir, sheet: "代導鐘點", noteRange: "J3:J4", preview: `${outputDir}/mentor-layout-j.png` }));
