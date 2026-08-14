import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ExcelJS = require('C:/tmp/school-substitution-sys-exceljs-verify/node_modules/exceljs');

const source = fs.readFileSync('export-accounting.js', 'utf8');
const context = { window: {}, console, Date, Array, Object, Number, String, Math, RegExp, JSON, parseInt, parseFloat, isFinite, setTimeout, clearTimeout };
context.window.window = context.window;
vm.runInNewContext(source, context, { filename: 'export-accounting.js' });
const EA = context.window.ExportAccounting;
const overtimeAttr = '\u8d85\u9418\u9ede';
const normalAttr = '\u4e00\u822c';
const publicFee = '\u516c\u8cbb\u4ee3\u8ab2';
const selfFee = '\u81ea\u8cbb\u4ee3\u8ab2';
const opts = {
  reportMonth: '2026-08', reportWeeksCount: 4, overtimeRate: 455,
  teachers: [
    { email: 'a@example.com', name: 'A', jobTitle: '\u6559\u5e2b', weeklyOvertime: 4, expensePlan: '\u95b1\u8b80\u63a8\u52d5' },
    { email: 'c@example.com', name: 'C', jobTitle: '\u6559\u5e2b' },
    { email: 'd@example.com', name: 'D', jobTitle: '\u6559\u5e2b' }
  ],
  monthlyReportRows: [{ email: 'a@example.com', name: 'A', weeklyOvertime: 4, expensePlan: '\u95b1\u8b80\u63a8\u52d5' }],
  periods: { start: '2026-08-01', end: '2026-08-31' },
  allSchedules: [
    { teacherEmail: 'a@example.com', dayOfWeek: 1, period: 1, className: '701', attr: overtimeAttr },
    { teacherEmail: 'a@example.com', dayOfWeek: 2, period: 2, className: '702', attr: normalAttr }
  ],
  substitutionRecords: [
    { id: 'pub-overtime', date: '2026-08-03', period: 1, className: '701', originalTeacherEmail: 'a@example.com', originalTeacherName: 'A', actualTeacherEmail: 'c@example.com', actualTeacherName: 'C', subFee: publicFee, status: 'approved', periodCount: 1 },
    { id: 'pub-normal', date: '2026-08-04', period: 2, className: '702', originalTeacherEmail: 'a@example.com', originalTeacherName: 'A', actualTeacherEmail: 'd@example.com', actualTeacherName: 'D', subFee: publicFee, status: 'approved', periodCount: 1 },
    { id: 'self-overtime', date: '2026-08-05', period: 1, className: '701', originalTeacherEmail: 'a@example.com', originalTeacherName: 'A', actualTeacherEmail: 'c@example.com', actualTeacherName: 'C', subFee: selfFee, status: 'approved', periodCount: 1 }
  ],
  homeroomRecords: []
};

const templateBuffer = fs.readFileSync('templates/accounting-template.xlsx');
const result = await EA.exportWorkbook({ ...opts, ExcelJS, templateBuffer });
const outputPath = 'C:/tmp/school-substitution-sys-exceljs-verify/accounting-export-plan.xlsx';
fs.writeFileSync(outputPath, Buffer.from(result.buffer));
const check = new ExcelJS.Workbook();
await check.xlsx.load(result.buffer);
const sheets = check.worksheets.map(sheet => sheet.name);
const plan = check.worksheets.find(sheet => sheet.name.includes('\u95b1\u8b80\u63a8\u52d5'));
if (!plan) throw new Error('project worksheet missing: ' + sheets.join('|'));
const readTitle = sheet => { for (let c = 1; c <= 15; c += 1) { const value = sheet.getCell(1, c).value; if (value !== null && value !== undefined && String(value).trim()) return String(value); } return ''; };
const planTitle = readTitle(plan);
const planRows = [plan.getCell(3, 3).value, plan.getCell(4, 3).value, plan.getCell(5, 3).value];
const planSchedules = [plan.getCell(3, 5).value, plan.getCell(4, 5).value, plan.getCell(5, 5).value];
const planWeeks = [plan.getCell(3, 6).value, plan.getCell(4, 6).value, plan.getCell(5, 6).value];
const planNotes = [plan.getCell(3, 15).value, plan.getCell(4, 15).value, plan.getCell(5, 15).value];
const total = plan.getCell(28, 11).value;
const globalTitle = readTitle(check.worksheets[0]);
if (!planTitle.includes('\u95b1\u8b80\u63a8\u52d5') || planTitle.includes('[[\u8a08\u756b]]')) throw new Error('bad project title: ' + planTitle);
if (planRows[0] !== 'A' || planRows[1] !== 'C' || planRows[2] !== 'C') throw new Error('bad row order: ' + JSON.stringify(planRows));
if (planSchedules.some((value, index) => index > 0 && !String(value).includes('(\u4ee3)'))) throw new Error('missing substitute marker: ' + JSON.stringify(planSchedules));
if (planWeeks.slice(1).some(value => value !== null && value !== '')) throw new Error('substitute weeks not blank: ' + JSON.stringify(planWeeks));
if (!String(planNotes[1]).includes('\u95b1\u8b80\u63a8\u52d5') || !String(planNotes[1]).includes('701')) throw new Error('note not explicit: ' + planNotes[1]);
if (!String(total.formula || total).includes('K3:K5')) throw new Error('bad plan total formula: ' + JSON.stringify(total));
if (!globalTitle.includes('\u8d85\u9418\u9ede') || globalTitle.includes('[[\u8a08\u756b]]')) throw new Error('bad default title: ' + globalTitle);
console.log(JSON.stringify({ outputPath, sheets, planTitle, planRows, planSchedules, planWeeks, planNotes, planTotal: total, globalTitle, summary: result.summary }, null, 2));
