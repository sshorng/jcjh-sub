# 部署與驗收清單（空堂事件＋活動互代）

> 今日大更新後 **必做**：重新部署 `code.gs`，再 Ctrl+F5 前端。

## 一、部署 code.gs

1. 開啟 Apps Script 專案，貼上／推送最新 `code.gs`
2. **新部署** 或「管理部署→編輯→新版本」（勿只存檔不部署）
3. 部署後用管理員帳號重新登入系統

預期後端能力：

- [ ] 自動建立工作表「班級空堂事件」
- [ ] `saveClassAwayEvent` / `deleteClassAwayEvent`
- [ ] 班級清單強制文字（防 901→數字、000）
- [ ] 扣額度撤銷／拒絕／撤回時還額 +1
- [ ] `getInitialData` 含 `classAwayEvents`

## 二、資料清理（一次）

1. 後台→系統設定→班級空堂事件
2. 每個舊事件：**編輯→確認班級無 000→儲存**
3. 教師名單確認「互代額度」欄存在

## 三、功能驗收（約 15 分）

### 空堂事件

- [ ] 新增「畢旅」keep、2 天、3 班、可進互代 → 列表班級正確
- [ ] 主畫面該班課格**淡化**（仍看得到班）
- [ ] 智慧媒合：有該班課的老師該節視為**可代／釋出**
- [ ] 模擬對照：該節**留白**
- [ ] 全校課表匯出：該節**留白＋灰底**

### 活動互代進度（五詞）

- [ ] 未勾帶隊：只見「請勾帶隊」；**釋出**可有數字，**需求**不算
- [ ] 勾 1 位帶隊：出現 **需求／已送出／暫定／尚缺／釋出**
- [ ] 已送出只含該帶隊，不含全校其他互代
- [ ] 送 3 節後再補排：需求不變大、尚缺＝需求−已送出−暫定（勿需求 1／已送出 3）

### 經費文案

- [ ] UI 無「互代不結」新建選項（顯示為扣額度）
- [ ] 歷史編輯無「學校移撥」新建（舊單仍可顯示）

### 額度

- [ ] 扣額度送出 −1；撤銷／撤回／拒絕 +1

### 管理員課表

- [ ] 預設「我的課表」；「全部教師」可看全校

## 四、回歸測試頁

本機開啟：

`http://127.0.0.1:8000/tests/domain-tests.html`

- [ ] 標題 PASS，全部通過

## 四之一、效能（2026-07-17 P0/P1）

部署時請一併更新 **code.gs**（教師共用快取、`requestsOnly`、`pendingOnly`、**增量 delta**、淺拷貝個人化）。

| 項 | 行為 |
|:---|:---|
| 分頁 | 主分頁改 `v-if`，切走即卸載 DOM |
| softRefresh | pending → **requestsDelta** →（幽靈／失敗）requestsOnly → 全量；核准走 delta→全窗 |
| 申請增量 | 表頭「更新時間」；`getInitialData` + `requestsDelta` + `updatedSince` |
| 淺拷貝 | `personalizeSharedPayload_`：不 deep clone 課表／教師 |
| SWR 分鍵 | meta／structure／requests；申請寫入只清 requests |
| saveRows | 連續列合併 setValues |
| 批次核准／駁回 | `adminApproveBatch`／`adminRejectBatch` 一次寫入 |
| 教師課表 | 只回自己＋自己班；`scheduleScope=teacher_self_and_class` |
| 代課媒合 | `getMatchCandidates` 後端算；前端失敗回本地 |
| 媒合快取 | 45s；申請寫入時代次戳失效 |
| pending 佔位 | 進行中單之雙方該節不進空堂候選 |
| 後端 | admin 120s 全量快取；教師共用底包 60s；`getPendingOnly` 45s |
| 延後腳本 | `print-helper`／`export-school-timetable` idle 預抓；`xlsx` 匯入／匯出才載 |
| 媒合 | 先只查目標節再掃負荷；同班／同課單次掃表 |
| 班級課表 | 只建目前選取班 |
| 月報 | 僅後台「經費」分頁時重算 |
| pending 索引 | `buildPendingIndex`：課表格不再每格掃 pending 列表 |
| 歷史列表 | req／peer 一次建表 |
| 空堂事件 | 後端 `jcjh_away_*` 快取；申請快取格式 `{rows}` 相容 |
| 課表／教師 payload | 後端瘦欄（去掉學期代號冗餘）；快取存瘦身列 |
| 教師查詢 | 前端 `teachersByEmail` Map |
| 模擬身份 | 開下拉才掛 DOM＋搜尋 |
| 後台子分頁 | `v-if` 卸載非目前分頁 |
| 快速待辦 | `hasQuickTodo`／`quickTodoSentOpen` computed |
| 綁課查詢 | `findBaseScheduleSlot` 走 scheduleIndex |
| loading 層級 | overlay 10100 ＞ modal 10050；confirm 10200；toast 10300 |

## 五、已知刻意行為

| 項目 | 行為 |
|:---|:---|
| 空堂事件班 | 畫面淡化、邏輯空堂 |
| 讀取舊「互代不結」 | 當扣額度 |
| 讀取舊「學校移撥」 | 月報仍當公費；新單不寫 |
| 事件不自動帶隊 | 須手動勾帶隊老師 |
