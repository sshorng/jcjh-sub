import fs from "node:fs/promises";
import vm from "node:vm";

const sourcePath = `${process.cwd()}/export-accounting.js`;
const source = await fs.readFile(sourcePath, "utf8");
const storage = new Map();
const localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); }
};
const context = {
  window: { localStorage },
  console, Date, Array, Object, Number, String, Math, RegExp, JSON,
  parseInt, parseFloat, isFinite, setTimeout, clearTimeout
};
vm.runInNewContext(source, context, { filename: sourcePath });

storage.set("school-substitution-accounting-periods-v1", JSON.stringify({
  "2026-08": {
    overtime: { start: "2026-08-04", end: "2026-08-05" },
    mentor: { start: "2026-08-01", end: "2026-08-31" }
  }
}));
const migrated = context.window.ExportAccounting.loadPeriodSettings("2026-08");
context.window.ExportAccounting.savePeriodSettings("2026-08", { start: "2026-08-04", end: "2026-08-05" });
const stored = JSON.parse(storage.get("school-substitution-accounting-periods-v1"));

const period = { start: "2026-08-04", end: "2026-08-05" };
const data = context.window.ExportAccounting.buildExportData({
  reportMonth: "2026-08",
  periods: period,
  reportWeeksCount: 1,
  teachers: [{ email: "cover@example.com", name: "張老師", jobTitle: "專任教師" }],
  monthlyReportRows: [{ email: "cover@example.com", name: "張老師", weeklyOvertime: 0 }],
  substitutionRecords: [
    { date: "2026-08-04", period: 1, originalTeacherEmail: "leave@example.com", actualTeacherEmail: "cover@example.com", actualTeacherName: "張老師", className: "701", subFee: "公費", status: "approved" },
    { date: "2026-08-06", period: 1, originalTeacherEmail: "leave@example.com", actualTeacherEmail: "cover@example.com", actualTeacherName: "張老師", className: "702", subFee: "公費", status: "approved" }
  ],
  homeroomRecords: [
    { date: "2026-08-05", periodCount: 1, feeAmount: 455, actualTeacherEmail: "cover@example.com", actualTeacherName: "張老師", className: "703", status: "assigned", enabled: true },
    { date: "2026-08-06", periodCount: 1, feeAmount: 455, actualTeacherEmail: "cover@example.com", actualTeacherName: "張老師", className: "704", status: "assigned", enabled: true }
  ],
  allSchedules: []
});

console.log(JSON.stringify({
  migrated,
  stored: stored["2026-08"],
  dataPeriod: data.periods,
  publicCount: data.sheets.publicSub.length,
  mentorCount: data.sheets.mentor.length,
  warnings: data.warnings
}, null, 2));
