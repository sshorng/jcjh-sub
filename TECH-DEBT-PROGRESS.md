# 技術債進度（方案甲 → 殼瘦身 v2）

## 2026-07-17 媒合快取 + pending 佔位

| 項 | 內容 |
|:---|:---|
| 媒合快取 | `getMatchCandidates` 結果 Cache 45s；key 含 gen 代次戳 |
| 失效 | `invalidateRequestCaches_` 更新 `jcjh_match_gen_*` |
| pending 佔位 | 進行中申請的申請人／受邀人該節不列入空堂候選 |

### 你必須手動

- [ ] 部署 `code.gs`
- [ ] 兩人同時開同節媒合：第二次應更快（快取）
- [ ] 有 pending 代課的人，該節不應再出現在他人媒合名單

---

## 2026-07-17 效能 B（媒合 API + 教師瘦課表）

| 項 | 內容 |
|:---|:---|
| B 教師 payload | `personalizeSharedPayload_`：`slimSchedulesForTeacher_`（自己＋自己班全校列） |
| B 媒合 API | `getMatchCandidates`：後端空堂排序，含核准異動近似 |
| B 前端 | `fetchMatchCandidates`；課表不全或人多時走 API，失敗回本地 |
| gas-api | APP_VERSION `2026-07-17-api5` |

### 你必須手動（B）

- [ ] 部署 `code.gs`
- [ ] Ctrl+F5
- [ ] 教師帳：登入 payload 應明顯變小；點格代課媒合應出現名單
- [ ] 調課：同班候選仍可用（同班列仍在）
- [ ] 管理員：仍為全校課表

---

## 2026-07-17 效能 A（SWR 分鍵 + 寫入批次）

| 項 | 內容 |
|:---|:---|
| A1 SWR 分鍵 | `meta`／`structure`／`requests`；申請寫入只清 requests；structure 可留 5 分 |
| A1 gas-api | APP_VERSION `2026-07-17-api4`；`writeSWRPart`；`adminApproveBatch`／`adminRejectBatch` 列入 WRITE |
| A2 saveRows | 更新列依 row 排序，連續區段一次 `setValues` |
| A2 批次核准 | 後端 `adminApproveBatch`／`adminRejectBatch` 一次讀寫；前端失敗回退逐筆 |

### 你必須手動（A）

- [ ] 部署最新 `code.gs`
- [ ] Ctrl+F5（`gas-api.js`／`app.js`／`ui-approval.js`）
- [ ] 回歸：批次核准／駁回（應一次 API，非 N 次）

---

## 2026-07-17 效能 P0/P1（本輪）

### 已完成（程式）

| 項 | 內容 |
|:---|:---|
| P1 淺拷貝 | 後端 `personalizeSharedPayload_`：不再 `JSON.parse(JSON.stringify(fullShared))` |
| P1 增量 | 申請單欄「更新時間」；寫入時刷新；`requestsDelta` + `updatedSince` |
| P1 softRefresh | 前端水位線 + `softSyncRequestsDelta`：pending → delta →（必要時）requestsOnly → 全量 |
| P1 FieldMap | `mapRequest.updatedAt` |
| P1 gas-api | `fetchRequestsDelta`；APP_VERSION `2026-07-17-api3`→`api4` |

### softRefresh 階梯

```
force        → 全量 loadWeeklyData
requestsOnly → delta（有變更）→ 否則 requestsOnly 全窗 → 全量
預設         → pendingOnly → delta
               · delta 有變更 → 結束
               · pending 失敗／幽靈結案／delta 失敗 → requestsOnly → 全量
               · 無幽靈且 delta empty → 結束（省全窗）
```

### 你必須手動

- [ ] **部署最新 `code.gs`**（否則增量／淺拷貝不生效）
- [ ] Ctrl+F5 前端（`gas-api.js`／`app.js`／`field-map.js`）
- [ ] 回歸：登入、同意、核准、撤回、批次；觀察 Network 是否出現 `requestsDelta`
- [ ] 舊申請列尚無「更新時間」時，核准後仍會回落 `requestsOnly`（正常）；新寫入列起有水位

### 暫緩（P1 教師瘦課表）

一般教師仍回全校課表（媒合／點格需要）。待媒合改「後端篩選」再砍 payload。

### 建議基線量測（部署後）

| 動作 | 看什麼 |
|:---|:---|
| 登入 | `getInitialData` 耗時、JSON KB |
| 同意後 3s | 是否 `getPendingOnly` + 可能 `requestsDelta`（payload 應很小） |
| 核准後 | `requestsDelta` 有列 或 回落 `requestsOnly` |
| 多人同時讀 | GAS 執行時間（淺拷貝應降 CPU） |

---

## 2026-07-17 現況（模組化）

- 模組化 A／B／C 已接線；效能 P0–P5 先前已做
- `app.js` 仍偏厚（含 softRefresh 邏輯）
- 語法：`node --check` 通過（app／gas-api／field-map／code.gs 轉 .js 檢查）

## 架構

| 檔案 | 職責 |
|:---|:---|
| `domain-*.js` | 純邏輯 |
| **`ui-activity.js`** | 空堂 + 互代 + 批次送出 |
| **`ui-request.js`** | 單節申請 |
| **`ui-timetable.js`** | 課表／點格／媒合 |
| **`ui-approval.js`** | 簽核／行政核准／撤回撤銷 |
| **`ui-admin.js`** | 匯入／教師 CRUD／課表格編輯／歷史編輯 |
| `app.js` | 殼 + 批次選節 UI + 組裝 + softRefresh |

## 可選下輪

1. **D**：LINE／日曆／詳情字串併 print-helper；app ≤2200
2. 冷啟動預熱 cron；前端 pager／billing 更惰性
3. 媒合 API 納入進行中 pending 佔位；調課候選可選後端化

## 經費別名政策（凍結）

| 值 | 寫入新單 | 讀取舊資料 |
|:---|:---|:---|
| 扣額度 | ✅ | ✅ |
| 互代不結 | ❌ | ✅ 當扣額度 |
| 學校移撥 | ❌ | ✅ 月報當公費 |
