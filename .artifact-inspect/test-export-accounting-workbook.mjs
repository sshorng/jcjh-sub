import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = process.cwd();
const sourcePath = path.join(root, "export-accounting.js");
const templatePath = path.join(root, "templates", "accounting-template.xlsx");
const outputPath = "C:/tmp/school-substitution-sys-artifact-inspect/accounting-export-regression-20260809.xlsx";
const source = await fs.readFile(sourcePath, "utf8");
const context = { window: {}, console, Date, Array, Object, Number, String, Math, RegExp, JSON, parseInt, parseFloat, isFinite, setTimeout, clearTimeout };
vm.runInNewContext(source, context, { filename: sourcePath });

const teachers = [
  { email: "leave@example.com", name: "王老師", jobTitle: "導師" },
  { email: "cover@example.com", name: "張老師", jobTitle: "專任教師" }
];
const period = { start: "2026-08-01", end: "2026-08-31" };
const opts = {
  reportMonth: "2026-08",
  reportWeeksCount: 5,
  periods: { overtime: period, adjunct: period, publicSub: period, selfSub: period, mentor: period },
  teachers,
  monthlyReportRows: teachers.map(t => ({ email: t.email, name: t.name, weeklyOvertime: 0, selfSubDetail: "" })),
  substitutionRecords: [],
  homeroomRecords: [
    { date: "2026-08-05", periodCount: 1, feeAmount: 455, actualTeacherEmail: "cover@example.com", actualTeacherName: "張老師", className: "703", leaveTime: "08:00~16:00", status: "assigned", enabled: true, reason: "代導公付", note: "教學組指定代導教師" },
    { date: "2026-08-04", periodCount: 1, feeAmount: 455, actualTeacherEmail: "cover@example.com", actualTeacherName: "張老師", className: "701", leaveTime: "08:00~16:00", status: "assigned", enabled: true, reason: "代導公付", note: "教學組指定代導教師" }
  ],
  allSchedules: [],
  getTeacherNameByEmail: email => (teachers.find(t => t.email === email) || {}).name || ""
};

const require = createRequire(import.meta.url);
const ExcelJS = require(path.join(root, "node_modules", "exceljs"));
const templateBuffer = await fs.readFile(templatePath);
const result = await context.window.ExportAccounting.exportWorkbook({ ...opts, ExcelJS, templateBuffer });
await fs.writeFile(outputPath, Buffer.from(result.buffer));

const check = new ExcelJS.Workbook();
await check.xlsx.load(result.buffer);
const mentor = check.worksheets[4];
const noteValues = [mentor.getCell("J3").value, mentor.getCell("J4").value];
const noteHeights = [mentor.getRow(3).height, mentor.getRow(4).height];
console.log(JSON.stringify({
  mentorSheet: mentor.name,
  mentorRows: result.summary.find(x => x.key === "mentor"),
  mentorNotes: noteValues,
  mentorRowHeights: noteHeights,
  formulas: { count: mentor.getCell("F11").value, amount: mentor.getCell("H11").value },
  warnings: result.warnings,
  outputPath
}, null, 2));
