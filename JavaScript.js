'use strict';

/* ============================ Configuration ============================ */
// PASTE your deployed Apps Script Web App URL here (Deploy -> Manage deployments -> Web app URL).
// It ends in /exec, e.g. "https://script.google.com/macros/s/AKfycb.../exec".
var API_BASE_URL = 'https://script.google.com/macros/s/AKfycbwpSw5gEuGJaN16iTKOWrXbEBdPmiH-SaVVUjjNeCUweiCxz_zdyjd2hkJZAh11-E33/exec';

/* ============================ API layer ============================ */
// fetch()-based replacement for the old google.script.run transport, per the
// GitHub-Pages-frontend architecture. Two deliberate rules, both there to
// avoid a CORS preflight (Apps Script has no documented way to answer one):
//   - GET is used for read actions: action/token/payload go in the query
//     string only, never in a custom header.
//   - POST is used for write actions (and any read whose payload has nested
//     objects/arrays, e.g. exportExcel): Content-Type is "text/plain" with
//     the JSON as the raw body text, NOT "application/json" — the backend's
//     doPost() already parses the raw body as JSON regardless of declared
//     content-type, so this needs no server-side change.
// See API_CONTRACT.md for the exact request/response shape of every action
// and for why GET query strings only carry flat string values (no booleans,
// arrays, or nested objects — use POST for those).
var STATE = {
  token: sessionStorage.getItem('arv_token') || null,
  user: JSON.parse(sessionStorage.getItem('arv_user') || 'null'),
  academicYear: sessionStorage.getItem('arv_year') || '2026/2027',
  view: sessionStorage.getItem('arv_view') || 'dashboard' // restored after a browser refresh (modals are never saved — only navigate() writes this)
};

// Actions safe to send as GET (flat, string-only payloads). Everything else
// — every write, plus exportExcel (nested "filters" object) — goes via POST.
var GET_ACTIONS = {
  ping: 1, listStudents: 1, getStudent: 1, getYearSettings: 1, getFeeSchedule: 1,
  listPayments: 1, getReceipt: 1, getPaymentMethods: 1, getFeeTypes: 1,
  getStudentStatement: 1, reportRevenue: 1, reportRemainingBalance: 1, reportStudentList: 1,
  getInstallments: 1, listAudit: 1, getStudentFilters: 1, searchReceipts: 1, getStageDepartmentMap: 1,
  getClassNames: 1, validateStudentStages: 1, getDashboardSummary: 1, getPaymentRules: 1,
  previewReceiptNumber: 1, reportAdjustedFees: 1
};

function buildQueryString_(params) {
  return Object.keys(params)
    .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
}

/** One raw HTTP call. Never retried itself — apiCall() below decides whether a retry is warranted. */
function rawApiRequest_(action, payload, useGet) {
  var request;
  if (useGet) {
    var qs = buildQueryString_(Object.assign({ action: action, token: STATE.token || '' }, payload || {}));
    request = fetch(API_BASE_URL + '?' + qs, { method: 'GET' });
  } else {
    request = fetch(API_BASE_URL, {
      method: 'POST',
      // text/plain (NOT application/json) keeps this a CORS-simple request — see comment above.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, token: STATE.token || '', payload: payload || {} })
    });
  }

  return request
    .then(function (res) { return res.text(); }) // read as text first — a misconfigured deployment can return an HTML error page instead of JSON
    .then(function (text) {
      var json;
      try { json = JSON.parse(text); }
      catch (e) {
        var err = new Error('BAD_JSON');
        err.code = 'BAD_JSON'; err.message = 'تعذر الاتصال بالخادم — يرجى المحاولة مرة أخرى.'; err.retryable = true;
        throw err;
      }
      if (!json.success) {
        if (json.error && json.error.code === 'SESSION_EXPIRED') doLogout(true);
        var appErr = new Error(json.error ? json.error.message : 'حدث خطأ غير متوقع');
        appErr.code = json.error ? json.error.code : 'ERROR';
        appErr.message = json.error ? json.error.message : 'حدث خطأ غير متوقع';
        appErr.retryable = false; // a clean, server-produced error — retrying won't change the outcome
        throw appErr;
      }
      return json.data;
    })
    .catch(function (err) {
      // A rejected fetch() (network down, DNS failure, or CORS actually blocked) has no .code yet — mark it retryable.
      if (!err.code) {
        err.code = 'NETWORK'; err.message = 'تعذر الاتصال بالخادم — يرجى المحاولة مرة أخرى.'; err.retryable = true;
      }
      throw err;
    });
}

/**
 * opts.retries === false forces exactly one attempt (used for login and every
 * write). Otherwise: reads default to up to 3 attempts, but ONLY for
 * retryable (network/parse) failures — a clean server error (FORBIDDEN,
 * OVERPAYMENT, DISCOUNT_ALREADY_APPLIED, ...) is never retried, since
 * retrying it can't change the outcome. Writes always effectively get 1
 * attempt by default — retrying a financial write blindly is exactly what
 * the idempotency key exists to make unnecessary, not something the
 * transport layer should paper over with automatic retries.
 */
function apiCall(action, payload, opts) {
  opts = opts || {};
  var useGet = !opts.forcePost && !!GET_ACTIONS[action];
  var maxAttempts = opts.retries === false ? 1 : (opts.retries || (useGet ? 3 : 1));
  var attempt = 0;

  function tryOnce(resolve, reject) {
    attempt++;
    rawApiRequest_(action, payload, useGet)
      .then(resolve)
      .catch(function (err) {
        if (err.retryable && attempt < maxAttempts) {
          setTimeout(function () { tryOnce(resolve, reject); }, 500 * attempt);
        } else {
          reject(err);
        }
      });
  }

  return new Promise(function (resolve, reject) { tryOnce(resolve, reject); });
}

/* ============================ Toasts ============================ */
function toast(message, type) {
  var wrap = document.getElementById('toastWrap');
  var el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(function () { el.remove(); }, 3500);
}

/* ============================ Auth ============================ */
function doLogin(username, password) {
  var btn = document.getElementById('loginBtn');
  var errBox = document.getElementById('loginError');
  errBox.textContent = '';
  btn.disabled = true; btn.textContent = 'جارٍ الدخول...';
  apiCall('login', { username: username, password: password }, { retries: false })
    .then(function (data) {
      STATE.token = data.token; STATE.user = data;
      sessionStorage.setItem('arv_token', data.token);
      sessionStorage.setItem('arv_user', JSON.stringify(data));
      renderApp();
    })
    .catch(function (err) { errBox.textContent = err.message; })
    .finally(function () { btn.disabled = false; btn.textContent = 'دخول'; });
}

function doLogout(silent) {
  if (STATE.token) apiCall('logout', {}, { retries: false }).catch(function () {});
  STATE.token = null; STATE.user = null;
  sessionStorage.removeItem('arv_token'); sessionStorage.removeItem('arv_user');
  if (!silent) toast('تم تسجيل الخروج', '');
  renderApp();
}

/* ============================ Root render ============================ */
function renderApp() {
  var root = document.getElementById('root');
  if (!STATE.token) { root.innerHTML = loginTemplate(); bindLogin(); return; }
  root.innerHTML = appShellTemplate();
  bindShell();
  // A restored module the current role cannot see (e.g. Settings for a non-admin) falls back to the home screen.
  var allowed = document.querySelector('.nav-item[data-view="' + STATE.view + '"]');
  navigate(allowed ? STATE.view : 'dashboard');
}

function loginTemplate() {
  return '' +
    '<div class="login-wrap"><div class="login-card">' +
    '<h2>الإيرادات الفعلية</h2>' +
    '<div class="field"><label>اسم المستخدم</label><input id="loginUser" autocomplete="username"></div>' +
    '<div class="field"><label>كلمة المرور</label><input id="loginPass" type="password" autocomplete="current-password"></div>' +
    '<div id="loginError" class="error-box" style="font-size:12.5px;margin-bottom:10px;"></div>' +
    '<button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;">دخول</button>' +
    '</div></div>';
}

function bindLogin() {
  var pass = document.getElementById('loginPass');
  document.getElementById('loginBtn').onclick = function () {
    doLogin(document.getElementById('loginUser').value.trim(), pass.value);
  };
  pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('loginBtn').click(); });
}

var NAV_ITEMS = [
  { id: 'dashboard', label: 'لوحة البيانات', icon: '&#128202;' },
  { id: 'students', label: 'الطلاب', icon: '&#128101;' },
  { id: 'collect', label: 'تحصيل دفعة', icon: '&#128176;' },
  { id: 'payments', label: 'سجل المدفوعات', icon: '&#128220;' },
  { id: 'report_revenue', label: 'تقرير الإيرادات', icon: '&#128200;' },
  { id: 'report_remaining', label: 'المتبقي على الطلاب', icon: '&#9878;' },
  { id: 'statement', label: 'كشف حساب طالب', icon: '&#128196;' },
  { id: 'report_adjusted', label: 'الطلاب ذوو الرسوم المعدَّلة', icon: '&#9998;', roles: ['Administrator', 'Reports User'] },
  { id: 'receipt_search', label: 'بحث عن إيصال', icon: '&#128269;' },
  { id: 'settings', label: 'الإعدادات', icon: '&#9881;', adminOnly: true },
  { id: 'users', label: 'المستخدمون', icon: '&#128100;', adminOnly: true }
];

function appShellTemplate() {
  var navHtml = NAV_ITEMS.filter(function (n) { return (!n.adminOnly || STATE.user.role === 'Administrator') && (!n.roles || n.roles.indexOf(STATE.user.role) !== -1); })
    .map(function (n) { return '<div class="nav-item" data-view="' + n.id + '"><span class="nav-icon">' + n.icon + '</span><span>' + n.label + '</span></div>'; })
    .join('');

  return '' +
    '<div class="sidebar" id="sidebar">' +
      '<div class="brand">الإيرادات الفعلية<small>نظام التحصيل</small></div>' +
      '<div class="nav-group-label">القوائم</div>' + navHtml +
    '</div>' +
    '<div class="main">' +
      '<div class="topbar">' +
        '<div class="title" id="pageTitle">لوحة البيانات</div>' +
        '<div class="right">' +
          '<span class="year-pill">' + STATE.academicYear + '</span>' +
          '<span class="user-chip">' + STATE.user.displayName + ' &middot; ' + STATE.user.role + '</span>' +
          '<button class="btn btn-secondary btn-sm" id="logoutBtn">خروج</button>' +
        '</div>' +
      '</div>' +
      '<div class="content" id="content"></div>' +
    '</div>' +
    '<div class="toast-wrap" id="toastWrap"></div>';
}

function bindShell() {
  document.getElementById('logoutBtn').onclick = function () { doLogout(); };
  document.querySelectorAll('.nav-item').forEach(function (el) {
    el.onclick = function () { navigate(el.getAttribute('data-view')); };
  });
}

function navigate(view) {
  STATE.view = view;
  sessionStorage.setItem('arv_view', view);
  document.querySelectorAll('.nav-item').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  });
  var titles = {}; NAV_ITEMS.forEach(function (n) { titles[n.id] = n.label; });
  document.getElementById('pageTitle').textContent = titles[view] || '';
  var content = document.getElementById('content');
  content.innerHTML = loadingBox();
  var renderers = {
    dashboard: renderDashboard, students: renderStudents, collect: renderCollect,
    payments: renderPayments, report_revenue: renderReportRevenue, report_remaining: renderReportRemaining,
    statement: renderStatement, report_adjusted: renderAdjustedFees, receipt_search: renderReceiptSearch, settings: renderSettings, users: renderUsers
  };
  (renderers[view] || renderDashboard)(content);
}

function loadingBox() {
  return '<div class="state-box"><div class="spinner"></div>جارٍ التحميل...</div>';
}
function errorBox(message, retryFn) {
  var id = 'retry_' + Math.random().toString(36).slice(2);
  setTimeout(function () {
    var b = document.getElementById(id);
    if (b) b.onclick = retryFn;
  }, 0);
  return '<div class="state-box error-box">' + escapeHtml(message) +
    '<div style="margin-top:10px;"><button class="btn btn-secondary btn-sm" id="' + id + '">إعادة المحاولة</button></div></div>';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtNum(n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
/** Like fmtNum, but null/undefined (no Official Fee Schedule entry) shows "—" instead of a misleading 0. */
function fmtAmt_(n) { return (n === null || n === undefined) ? '—' : fmtNum(n); }
/** Percentage is the primary user-facing value for an installment; falls back to the raw number/blank when no percentage was recorded (e.g. Deposit lines). */
function installmentDisplay_(row) { return row.InstallmentPercent ? (row.InstallmentPercent + '%') : (row.Installment || ''); }

/* ============================ Dashboard ============================ */
function renderDashboard(content) {
  apiCall('getDashboardSummary', { academicYear: STATE.academicYear })
    .then(function (s) {
      content.innerHTML =
        '<div class="panel"><div class="panel-header"><h3>لوحة التحكم</h3><div>' + exportToolbarHtml_('dash') + '</div></div>' +
        '<div class="panel-body"><div class="cards-row">' +
        statCard('إجمالي الإيرادات المحصلة', fmtNum(s.totalRevenue) + ' ج.م', 'accent-green') +
        statCard('عدد عمليات التحصيل', fmtNum(s.transactionCount), 'accent-blue') +
        statCard('إجمالي المتبقي على الطلاب', fmtNum(s.totalRemaining) + ' ج.م', 'accent-red') +
        statCard('عدد الطلاب', fmtNum(s.studentCount), '') +
        '</div></div></div>' +
        '<div class="panel"><div class="panel-header"><h3>روابط سريعة</h3></div><div class="panel-body" style="display:flex;gap:10px;flex-wrap:wrap;">' +
        '<button class="btn btn-primary" onclick="navigate(\'collect\')">+ تحصيل دفعة جديدة</button>' +
        '<button class="btn btn-secondary" onclick="navigate(\'report_revenue\')">تقرير الإيرادات</button>' +
        '<button class="btn btn-secondary" onclick="navigate(\'report_remaining\')">المتبقي على الطلاب</button>' +
        '</div></div>';
      // Dashboard print/PDF: ONLY the 4 summary cards — never the quick-links panel, no Excel (no tabular dataset).
      var dashBody = '<div class="cards-row">' +
        statCard('إجمالي الإيرادات المحصلة', fmtNum(s.totalRevenue) + ' ج.م', '') +
        statCard('عدد عمليات التحصيل', fmtNum(s.transactionCount), '') +
        statCard('إجمالي المتبقي على الطلاب', fmtNum(s.totalRemaining) + ' ج.م', '') +
        statCard('عدد الطلاب', fmtNum(s.studentCount), '') + '</div>';
      bindExportToolbar_('dash', 'لوحة التحكم', function () { return dashBody; });
    })
    .catch(function (err) { content.innerHTML = errorBox(err.message, function () { navigate('dashboard'); }); });
}
function statCard(label, value, accent) {
  return '<div class="stat-card ' + accent + '"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}

/* ============================ Students ============================ */
var studentsPage = 1;
var studentsSearchTimer_ = null;
var studentsFilterOptions_ = null; // {stages, classNames, departments} — fetched once per screen entry, not per keystroke

function renderStudents(content, page, preserveFocus) {
  studentsPage = page || 1;
  var searchInputEl = document.getElementById('stuSearch');
  var search = searchInputEl ? searchInputEl.value : '';
  var stageVal = (document.getElementById('stuStage') || {}).value || '';
  var classVal = (document.getElementById('stuClass') || {}).value || '';
  var deptVal = (document.getElementById('stuDept') || {}).value || '';
  var focusInfo = (preserveFocus && searchInputEl && document.activeElement === searchInputEl)
    ? { start: searchInputEl.selectionStart, end: searchInputEl.selectionEnd } : null;

  var listFilters = { academicYear: STATE.academicYear, search: search, stage: stageVal, className: classVal, department: deptVal, page: studentsPage, pageSize: 25 };
  var calls = [apiCall('listStudents', listFilters)];
  if (!studentsFilterOptions_) calls.push(apiCall('getStudentFilters', { academicYear: STATE.academicYear }));

  Promise.all(calls)
    .then(function (r) {
      var data = r[0];
      if (r[1]) studentsFilterOptions_ = r[1];
      var isAdmin = STATE.user.role === 'Administrator';
      var importBtnHtml = isAdmin ? '<button class="btn btn-secondary" id="stuImportBtn">&#128229; استيراد الطلاب</button>' : '';
      var opts = studentsFilterOptions_ || { stages: [], classNames: [], departments: [] };

      content.innerHTML =
        panelHeader('قائمة الطلاب', '<div class="filters-row">' +
          '<div class="field"><label>بحث</label><input id="stuSearch" class="search-box" placeholder="الكود أو الاسم" value="' + escapeHtml(search) + '" autocomplete="off"></div>' +
          field('المرحلة', selectHtmlWithSelected_('stuStage', opts.stages, stageVal)) +
          field('الفصل', selectHtmlWithSelected_('stuClass', opts.classNames, classVal)) +
          field('القسم', selectHtmlWithSelected_('stuDept', opts.departments, deptVal)) +
          '<button class="btn btn-secondary" id="stuSearchBtn">بحث</button>' +
          exportToolbarHtml_('stu') + '<button class="btn btn-secondary" id="stuExcelBtn">&#128202; Excel</button>' +
          importBtnHtml +
          '</div>') +
        '<div class="table-wrap"><table><thead><tr><th>الكود</th><th>الاسم</th><th>تعليم</th><th>نشاط</th><th>باص</th><th>المرحلة</th><th>الفصل</th><th>القسم</th></tr></thead><tbody id="stuTbody">' +
        data.items.map(function (s) { return studentRowHtml_(s, isAdmin); }).join('') +
        '</tbody></table></div>' + paginationBar(data, function (p) { renderStudents(content, p); }) +
        '</div>';

      var input = document.getElementById('stuSearch');
      function reload() { clearTimeout(studentsSearchTimer_); renderStudents(content, 1); }
      document.getElementById('stuSearchBtn').onclick = reload;
      document.getElementById('stuStage').onchange = reload;
      document.getElementById('stuClass').onchange = reload;
      document.getElementById('stuDept').onchange = reload;
      input.addEventListener('input', function () {
        clearTimeout(studentsSearchTimer_);
        studentsSearchTimer_ = setTimeout(function () { renderStudents(content, 1, true); }, 350);
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); reload(); } });
      bindExportToolbar_('stu', 'قائمة الطلاب', getScreenPrintableContent_, 'students', function () { return listFilters; });
      var importBtn = document.getElementById('stuImportBtn');
      if (importBtn) importBtn.onclick = function () { openStudentImportModal_(content, studentsPage); };

      content.querySelectorAll('.student-name-link').forEach(function (a) {
        a.onclick = function (e) { e.preventDefault(); openStudentDetailModal_(a.getAttribute('data-code')); };
      });
      if (isAdmin) bindStudentFeeEditors_();

      if (focusInfo) { input.focus(); input.setSelectionRange(focusInfo.start, focusInfo.end); }
    })
    .catch(function (err) { content.innerHTML = errorBox(err.message, function () { renderStudents(content, studentsPage); }); });
}

function selectHtmlWithSelected_(id, options, selected) {
  return '<select id="' + id + '"><option value="">الكل</option>' +
    options.map(function (o) { return '<option value="' + escapeHtml(o) + '"' + (o === selected ? ' selected' : '') + '>' + escapeHtml(o) + '</option>'; }).join('') + '</select>';
}

var CANONICAL_FEE_TYPES = ['تعليم', 'نشاط', 'باص'];
var FEE_TYPE_PREFIX_ = { 'تعليم': 'Education', 'نشاط': 'Activity', 'باص': 'Bus' };

/** One row, independently re-renderable — cell-level updates after a save/reset never touch the rest of the table. */
function studentRowHtml_(s, isAdmin) {
  return '<tr id="stuRow_' + escapeHtml(s.StudentCode) + '" data-code="' + escapeHtml(s.StudentCode) + '">' +
    '<td>' + escapeHtml(s.StudentCode) + '</td>' +
    '<td><a href="#" class="student-name-link" data-code="' + escapeHtml(s.StudentCode) + '">' + escapeHtml(s.StudentName) + '</a></td>' +
    CANONICAL_FEE_TYPES.map(function (ft) { return feeCellHtml_(s, ft, isAdmin); }).join('') +
    '<td>' + escapeHtml(s.Stage) + '</td><td>' + escapeHtml(s.ClassName) + '</td><td>' + escapeHtml(s.Department) + '</td></tr>';
}

function feeCellHtml_(s, feeType, isAdmin) {
  var prefix = FEE_TYPE_PREFIX_[feeType];
  var approved = s[prefix + 'Approved'], hasOverride = s[prefix + 'HasOverride'];
  if (!isAdmin) {
    return '<td>' + fmtAmt_(approved) + (hasOverride ? ' <span class="badge badge-blue" title="سعر خاص بالطالب">معدَّل</span>' : '') + '</td>';
  }
  return '<td style="white-space:nowrap;">' +
    '<input type="number" min="0" step="0.01" class="stu-fee-input" style="width:90px;" data-code="' + escapeHtml(s.StudentCode) + '" data-feetype="' + escapeHtml(feeType) + '" data-saved="' + (approved === null ? '' : approved) + '" value="' + (approved === null ? '' : approved) + '">' +
    (hasOverride ? ' <button class="btn btn-secondary btn-sm stu-fee-reset" data-code="' + escapeHtml(s.StudentCode) + '" data-feetype="' + escapeHtml(feeType) + '" title="استعادة السعر الرسمي">&#8635;</button>' : '') +
    '</td>';
}

/**
 * Binds every fee input/reset button currently in the table. Uses .onchange /
 * .onclick ASSIGNMENT (not addEventListener), so re-binding a cell can never
 * stack a second handler — one edit is always exactly one write.
 */
function bindStudentFeeEditors_(scope) {
  (scope || document).querySelectorAll('.stu-fee-input').forEach(bindStudentFeeInput_);
  (scope || document).querySelectorAll('.stu-fee-reset').forEach(bindStudentFeeReset_);
}
function bindStudentFeeInput_(inp) {
  inp.onchange = function () {
    var code = inp.getAttribute('data-code'), feeType = inp.getAttribute('data-feetype');
    var saved = inp.getAttribute('data-saved');
    var amount = inp.value;
    if (amount === '' || isNaN(Number(amount)) || Number(amount) < 0) { toast('قيمة غير صحيحة', 'error'); inp.value = saved; return; }
    inp.disabled = true;
    apiCall('setStudentFeeOverride', { studentCode: code, academicYear: STATE.academicYear, feeType: feeType, amount: amount })
      .then(function (updated) { updateStudentFeeCell_(code, feeType, updated); showCellSaved_(code, feeType); })
      .catch(function (err) { toast(err.message, 'error'); inp.value = saved; inp.disabled = false; });
  };
}

/** Small inline "saved" confirmation inside the edited cell only; disappears after ~2s. Each cell has its own, independent of other cells. */
function showCellSaved_(studentCode, feeType) {
  var row = document.getElementById('stuRow_' + studentCode);
  var cell = row && row.children[2 + CANONICAL_FEE_TYPES.indexOf(feeType)];
  if (!cell) return;
  var msg = document.createElement('div');
  msg.className = 'stu-fee-saved';
  msg.textContent = '✓ تم حفظ المبلغ';
  msg.style.cssText = 'font-size:11.5px;color:var(--success);margin-top:3px;';
  cell.appendChild(msg);
  setTimeout(function () { msg.remove(); }, 2000);
}
function bindStudentFeeReset_(btn) {
  btn.onclick = function () {
    var code = btn.getAttribute('data-code'), feeType = btn.getAttribute('data-feetype');
    if (!confirm('استعادة السعر الرسمي لـ ' + feeType + '؟')) return;
    btn.disabled = true;
    apiCall('clearStudentFeeOverride', { studentCode: code, academicYear: STATE.academicYear, feeType: feeType })
      .then(function (updated) { updateStudentFeeCell_(code, feeType, updated); toast('تم استعادة السعر الرسمي', 'success'); })
      .catch(function (err) { toast(err.message, 'error'); btn.disabled = false; });
  };
}

/** Replaces ONLY the affected fee cell from the server's returned student — no table/app reload. */
function updateStudentFeeCell_(studentCode, feeType, updatedStudent) {
  var row = document.getElementById('stuRow_' + studentCode);
  if (!row) return;
  var cellIndex = 2 + CANONICAL_FEE_TYPES.indexOf(feeType); // Code, Name, then تعليم/نشاط/باص in order
  var tmp = document.createElement('tbody');
  tmp.innerHTML = '<tr>' + feeCellHtml_(updatedStudent, feeType, true) + '</tr>';
  var newCell = tmp.firstChild.firstChild;
  row.children[cellIndex].replaceWith(newCell);
  bindStudentFeeEditors_(newCell);
}

/** Student name click -> full statement in a modal (reuses getStudentStatement_, same data the "كشف حساب طالب" page already shows). */
function openStudentDetailModal_(studentCode) {
  var backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = '<div class="modal" style="width:min(720px,94vw);"><div class="modal-header"><h3>بيانات الطالب</h3><button class="close-x">&times;</button></div>' +
    '<div class="modal-body" id="studentDetailBody">' + loadingBox() + '</div>' +
    '<div class="modal-footer"><button class="btn btn-secondary btn-sm" id="studentDetailPrintBtn" disabled>&#128424; طباعة</button></div></div>';
  document.body.appendChild(backdrop);
  backdrop.querySelector('.close-x').onclick = function () { backdrop.remove(); };
  var lastData = null;

  apiCall('getStudentStatement', { studentCode: studentCode, academicYear: STATE.academicYear })
    .then(function (d) {
      lastData = d;
      var s = d.student, t = d.totals;
      var activeBadge = (s.Active === true || String(s.Active).toUpperCase() === 'TRUE')
        ? '<span class="badge badge-green">نشط</span>' : '<span class="badge badge-red">غير نشط</span>';
      document.getElementById('studentDetailBody').innerHTML =
        '<h4 style="margin-top:0;">' + escapeHtml(s.StudentName) + ' &nbsp; ' + activeBadge + '</h4>' +
        '<p style="color:var(--text-muted);font-size:13px;">الكود: ' + escapeHtml(s.StudentCode) + ' &nbsp;|&nbsp; المرحلة: ' + escapeHtml(s.Stage) +
        ' &nbsp;|&nbsp; الفصل: ' + escapeHtml(s.ClassName) + ' &nbsp;|&nbsp; القسم: ' + escapeHtml(s.Department) + '</p>' +
        '<div class="cards-row">' +
        statCard('إجمالي المستحق', fmtNum(t.due), '') +
        statCard('إجمالي الخصم', fmtNum(t.discount), '') +
        statCard('إجمالي المحصل', fmtNum(t.collected), 'accent-green') +
        statCard('إجمالي المتبقي', fmtNum(t.remaining), t.remaining > 0 ? 'accent-red' : 'accent-green') +
        '</div>' +
        '<h4 style="margin-top:16px;">المدفوعات السابقة</h4>' +
        '<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>نوع الرسوم</th><th>القسط</th><th>نوع الدفعة</th><th>المبلغ المحصل</th><th>طريقة الدفع</th><th>الإيصال</th><th>بواسطة</th></tr></thead><tbody>' +
        (d.transactions.length ? d.transactions.map(function (tx) {
          return '<tr><td>' + escapeHtml(String(tx.PaymentDate).substring(0, 10)) + '</td><td>' + escapeHtml(tx.FeeType) + '</td><td>' + escapeHtml(installmentDisplay_(tx)) +
            '</td><td>' + escapeHtml(tx.PaymentType || '') + '</td><td class="num">' + fmtNum(tx.AmountPaid) + '</td><td>' + escapeHtml(tx.PaymentMethod) +
            '</td><td><button class="btn btn-secondary btn-sm" onclick="openReceipt_(\'' + tx.ReceiptNumber + '\')">' + escapeHtml(tx.ReceiptNumber) + '</button></td><td>' + escapeHtml(tx.CreatedBy) + '</td></tr>';
        }).join('') : '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">لا توجد مدفوعات بعد</td></tr>') +
        '</tbody></table></div>';
      document.getElementById('studentDetailPrintBtn').disabled = false;
    })
    .catch(function (err) { document.getElementById('studentDetailBody').innerHTML = errorBox(err.message, function () { openStudentDetailModal_(studentCode); }); });

  // Prints ONLY this modal's data — built fresh from the already-fetched statement, not a DOM
  // clone, so the background Students page, the modal's own close/print buttons, and the modal
  // chrome never appear. Receipt numbers are plain text here, never a clickable button.
  document.getElementById('studentDetailPrintBtn').onclick = function () {
    if (!lastData) return;
    var s = lastData.student, t = lastData.totals;
    var activeText = (s.Active === true || String(s.Active).toUpperCase() === 'TRUE') ? 'نشط' : 'غير نشط';
    var body =
      '<h3 style="margin-top:0;">' + escapeHtml(s.StudentName) + '</h3>' +
      '<table style="margin-bottom:14px;"><tbody>' +
      '<tr><td><b>الكود</b></td><td>' + escapeHtml(s.StudentCode) + '</td><td><b>المرحلة</b></td><td>' + escapeHtml(s.Stage) + '</td></tr>' +
      '<tr><td><b>الفصل</b></td><td>' + escapeHtml(s.ClassName) + '</td><td><b>القسم</b></td><td>' + escapeHtml(s.Department) + '</td></tr>' +
      '<tr><td><b>الحالة</b></td><td colspan="3">' + activeText + '</td></tr>' +
      '</tbody></table>' +
      '<table style="margin-bottom:14px;"><tbody>' +
      '<tr><td><b>إجمالي المستحق</b></td><td>' + fmtNum(t.due) + '</td><td><b>إجمالي الخصم</b></td><td>' + fmtNum(t.discount) + '</td></tr>' +
      '<tr><td><b>إجمالي المحصل</b></td><td>' + fmtNum(t.collected) + '</td><td><b>إجمالي المتبقي</b></td><td>' + fmtNum(t.remaining) + '</td></tr>' +
      '</tbody></table>' +
      '<h4>المدفوعات السابقة</h4>' +
      '<table><thead><tr><th>التاريخ</th><th>نوع الرسوم</th><th>القسط</th><th>نوع الدفعة</th><th>المبلغ المحصل</th><th>طريقة الدفع</th><th>الإيصال</th><th>بواسطة</th></tr></thead><tbody>' +
      (lastData.transactions.length ? lastData.transactions.map(function (tx) {
        return '<tr><td>' + escapeHtml(String(tx.PaymentDate).substring(0, 10)) + '</td><td>' + escapeHtml(tx.FeeType) + '</td><td>' + escapeHtml(installmentDisplay_(tx)) +
          '</td><td>' + escapeHtml(tx.PaymentType || '') + '</td><td>' + fmtNum(tx.AmountPaid) + '</td><td>' + escapeHtml(tx.PaymentMethod) +
          '</td><td>' + escapeHtml(tx.ReceiptNumber) + '</td><td>' + escapeHtml(tx.CreatedBy) + '</td></tr>';
      }).join('') : '<tr><td colspan="8" style="text-align:center;">لا توجد مدفوعات بعد</td></tr>') +
      '</tbody></table>';
    printReport_('بيانات الطالب — ' + s.StudentName, body);
  };
}

function panelHeader(title, rightHtml) {
  return '<div class="panel"><div class="panel-header"><h3>' + title + '</h3>' + (rightHtml || '') + '</div><div class="panel-body" style="padding:0;">';
}
function paginationBar(data, onPage) {
  var id = 'pg_' + Math.random().toString(36).slice(2);
  setTimeout(function () {
    var wrap = document.getElementById(id);
    if (!wrap) return;
    wrap.querySelectorAll('[data-p]').forEach(function (b) { b.onclick = function () { onPage(Number(b.getAttribute('data-p'))); }; });
  }, 0);
  var prevDisabled = data.page <= 1 ? 'disabled' : '';
  var nextDisabled = data.page >= data.totalPages ? 'disabled' : '';
  return '<div class="pagination" id="' + id + '">' +
    '<span>إجمالي ' + fmtNum(data.total) + ' — صفحة ' + data.page + ' من ' + data.totalPages + '</span>' +
    '<span class="pages">' +
    '<button class="btn btn-secondary btn-sm" data-p="' + (data.page - 1) + '" ' + prevDisabled + '>السابق</button>' +
    '<button class="btn btn-secondary btn-sm" data-p="' + (data.page + 1) + '" ' + nextDisabled + '>التالي</button>' +
    '</span></div>';
}

/* ============================ Collect payment (multi-line, one receipt) ============================ */
var collectCtx = { feeTypes: [], methods: [], installmentDates: [], blockSeq: 0, selectedStudent: null, selectedStudentSummary: null, searchTimer: null, depositOverrides: {} };

function renderCollect(content) {
  // getInstallments is needed again — Deposit's installment suggestion reads its
  // StartDate/EndDate ranges from Year Settings (never hardcoded here).
  Promise.all([apiCall('getFeeTypes', {}), apiCall('getPaymentMethods', {}), apiCall('getInstallments', { academicYear: STATE.academicYear })])
    .then(function (r) {
      collectCtx.feeTypes = r[0]; collectCtx.methods = r[1]; collectCtx.installmentDates = r[2]; collectCtx.blockSeq = 0;
      collectCtx.selectedStudent = null; collectCtx.selectedStudentSummary = null;

      content.innerHTML = '' +
        '<div class="panel"><div class="panel-header"><h3 id="collectTitle">تحصيل دفعة</h3><div>' + exportToolbarHtml_('col') + '</div></div><div class="panel-body">' +
        '<div class="field full" style="position:relative;max-width:420px;">' +
        '<label>اختر الطالب (بالكود أو الاسم)</label>' +
        '<input id="pStudentSearch" placeholder="ابحث بالكود أو اسم الطالب" autocomplete="off">' +
        '<div id="pStudentResults" style="display:none;position:absolute;z-index:20;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);max-height:220px;overflow-y:auto;width:100%;"></div>' +
        '</div>' +
        '<div id="collectStudentCard"></div>' +
        '<div id="collectFormBody" style="display:none;">' +
        '<div class="form-grid">' +
        field('تاريخ السداد', '<input type="date" id="pDate" value="' + todayStr_() + '">') +
        field('طريقة الدفع', selectHtml('pMethod', collectCtx.methods)) +
        field('رقم الإيصال (من الخادم — يمكن تغييره يدويًا)', '<input id="pReceipt">') +
        '</div>' +
        '<h4 style="margin:16px 0 8px;">بنود التحصيل</h4>' +
        '<div id="collectLines"></div>' +
        '<button class="btn btn-secondary btn-sm" id="addLineBtn" style="margin-top:8px;">+ إضافة بند</button>' +
        '<div class="field full" style="margin-top:10px;"><label>ملاحظات عامة</label><textarea id="pNotes" rows="2"></textarea></div>' +
        '<div style="margin-top:14px;display:flex;gap:10px;align-items:center;">' +
        '<button class="btn btn-primary" id="pSaveBtn">تسجيل التحصيل</button>' +
        '<b id="pTotal" style="font-size:14px;">الإجمالي: 0</b>' +
        '<span id="pStatus" style="align-self:center;font-size:13px;color:var(--text-muted);"></span>' +
        '</div>' +
        '</div>' + // #collectFormBody
        '</div></div>';

      document.getElementById('addLineBtn').onclick = function () { addCollectBlock_(); };
      document.getElementById('pSaveBtn').onclick = function () { submitPayment_(content); };
      document.getElementById('pDate').addEventListener('change', function () { reSuggestAllDepositInstallments_(); });
      // Print/PDF only here — no Excel (a collection entry form has no meaningful tabular
      // dataset to export, per spec). Prints the already-loaded student summary only — never
      // the entry form/installment blocks themselves, which are interactive input, not report content.
      document.getElementById('colPrintBtn').onclick = function () {
        if (!collectCtx.selectedStudentSummary) { toast('اختر الطالب أولًا', 'error'); return; }
        printReport_('ملخص تحصيل — ' + collectCtx.selectedStudentSummary.student.StudentName, collectSummaryPrintBody_());
      };
      document.getElementById('colPdfBtn').onclick = function () {
        if (!collectCtx.selectedStudentSummary) { toast('اختر الطالب أولًا', 'error'); return; }
        exportPdf_('ملخص تحصيل — ' + collectCtx.selectedStudentSummary.student.StudentName, collectSummaryPrintBody_(), document.getElementById('colPdfBtn'));
      };
      bindCollectStudentSearch_(content);
      fetchReceiptNumberPreview_();
    })
    .catch(function (err) { content.innerHTML = errorBox(err.message, function () { renderCollect(content); }); });
}

/** Debounced student search combobox — ONE listStudents call per pause in typing, never per keystroke. */
function bindCollectStudentSearch_(content) {
  var input = document.getElementById('pStudentSearch');
  var results = document.getElementById('pStudentResults');

  input.addEventListener('input', function () {
    clearTimeout(collectCtx.searchTimer);
    var q = input.value.trim();
    if (!q) { results.style.display = 'none'; results.innerHTML = ''; return; }
    collectCtx.searchTimer = setTimeout(function () {
      apiCall('listStudents', { academicYear: STATE.academicYear, search: q, page: 1, pageSize: 8 })
        .then(function (data) {
          if (!data.items.length) {
            results.innerHTML = '<div style="padding:8px 12px;color:var(--text-muted);font-size:13px;">لا نتائج</div>';
            results.style.display = '';
            return;
          }
          results.innerHTML = data.items.map(function (s) {
            return '<div class="combo-item" data-code="' + escapeHtml(s.StudentCode) + '" data-name="' + escapeHtml(s.StudentName) +
              '" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);">' + escapeHtml(s.StudentCode) + ' — ' + escapeHtml(s.StudentName) + '</div>';
          }).join('');
          results.style.display = '';
          results.querySelectorAll('.combo-item').forEach(function (item) {
            item.onclick = function () { selectCollectStudent_(content, item.getAttribute('data-code'), item.getAttribute('data-name')); };
          });
        })
        .catch(function () { results.style.display = 'none'; });
    }, 350);
  });

  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
  document.addEventListener('click', function hideOnOutsideClick(e) {
    if (!results.contains(e.target) && e.target !== input) results.style.display = 'none';
  });
}

function selectCollectStudent_(content, code, name) {
  collectCtx.selectedStudent = { code: code, name: name };
  document.getElementById('pStudentSearch').value = code + ' — ' + name;
  document.getElementById('pStudentResults').style.display = 'none';
  document.getElementById('pStudentResults').innerHTML = '';
  loadCollectStudentSummary_(content);
}

function resetCollectStudent_(content) {
  collectCtx.selectedStudent = null; collectCtx.selectedStudentSummary = null;
  document.getElementById('collectTitle').textContent = 'تحصيل دفعة';
  document.getElementById('collectStudentCard').innerHTML = '';
  document.getElementById('collectFormBody').style.display = 'none';
  var input = document.getElementById('pStudentSearch');
  input.value = '';
  input.focus();
}

/** Loaded ONCE per student selection (and once more after a successful save, to refresh totals) — never per keystroke. */
function loadCollectStudentSummary_(content) {
  var card = document.getElementById('collectStudentCard');
  card.innerHTML = loadingBox();
  apiCall('getStudentStatement', { studentCode: collectCtx.selectedStudent.code, academicYear: STATE.academicYear })
    .then(function (d) {
      collectCtx.selectedStudentSummary = d;
      var s = d.student, t = d.totals;
      card.innerHTML =
        '<div class="panel" style="margin:10px 0 16px;"><div class="panel-body">' +
        '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;align-items:start;">' +
        '<div><b style="font-size:15px;">' + escapeHtml(s.StudentName) + '</b><br>' +
        '<span style="color:var(--text-muted);font-size:12.5px;">الكود: ' + escapeHtml(s.StudentCode) +
        ' &nbsp;|&nbsp; المرحلة: ' + escapeHtml(s.Stage) + ' &nbsp;|&nbsp; الفصل: ' + escapeHtml(s.ClassName) +
        ' &nbsp;|&nbsp; القسم: ' + escapeHtml(s.Department) + '</span></div>' +
        '<button class="btn btn-secondary btn-sm" id="changeStudentBtn">تغيير الطالب</button>' +
        '</div>' +
        '<div class="cards-row" style="margin-top:10px;">' +
        statCard('إجمالي المستحق', fmtNum(t.due), '') +
        statCard('إجمالي الخصم', fmtNum(t.discount), '') +
        statCard('إجمالي المحصل', fmtNum(t.collected), 'accent-green') +
        statCard('المتبقي', fmtNum(t.remaining), t.remaining > 0 ? 'accent-red' : 'accent-green') +
        '</div></div></div>';
      document.getElementById('changeStudentBtn').onclick = function () { resetCollectStudent_(content); };
      document.getElementById('collectTitle').textContent = 'تحصيل دفعة — ' + s.StudentName + ' (' + s.StudentCode + ')';
      document.getElementById('collectFormBody').style.display = '';
      if (!document.getElementById('collectLines').children.length) addCollectBlock_();
    })
    .catch(function (err) { card.innerHTML = errorBox(err.message, function () { loadCollectStudentSummary_(content); }); });
}

/** The "meaningful summary" for Collect Payment print/PDF — student info + totals only, built from data already loaded by loadCollectStudentSummary_ (zero extra calls). Never the entry form/blocks. */
function collectSummaryPrintBody_() {
  var d = collectCtx.selectedStudentSummary, s = d.student, t = d.totals;
  return '<h3 style="margin-top:0;">' + escapeHtml(s.StudentName) + '</h3>' +
    '<table style="margin-bottom:14px;"><tbody>' +
    '<tr><td><b>الكود</b></td><td>' + escapeHtml(s.StudentCode) + '</td><td><b>المرحلة</b></td><td>' + escapeHtml(s.Stage) + '</td></tr>' +
    '<tr><td><b>الفصل</b></td><td>' + escapeHtml(s.ClassName) + '</td><td><b>القسم</b></td><td>' + escapeHtml(s.Department) + '</td></tr>' +
    '</tbody></table>' +
    '<table><tbody>' +
    '<tr><td><b>إجمالي المستحق</b></td><td>' + fmtNum(t.due) + '</td><td><b>إجمالي الخصم</b></td><td>' + fmtNum(t.discount) + '</td></tr>' +
    '<tr><td><b>إجمالي المحصل</b></td><td>' + fmtNum(t.collected) + '</td><td><b>المتبقي</b></td><td>' + fmtNum(t.remaining) + '</td></tr>' +
    '</tbody></table>';
}

/**
 * Fixed, never-changing list — no API call needed to populate this dropdown.
 * PaymentType describes the NATURE of the payment, separate from Fee Type
 * and separate from which installment(s) are being settled:
 *   - 'Full Amount': settle one or more installments in full (multi-select below).
 *   - 'Deposit': a partial/advance payment that MUST belong to exactly one specific installment.
 */
var PAYMENT_TYPES = ['Deposit', 'Full Amount'];

/**
 * One "block" = one Fee Type + one Payment Type. Choosing the Fee Type
 * triggers ONE getCollectionPreview call (not one per installment, not one
 * per checkbox/select change) that returns the live percentage + current
 * outstanding amount for every configured installment — used by BOTH
 * Payment Types. Full Amount lets the collector check any subset of
 * installments (each becomes its own transaction line at submit). Deposit
 * always resolves to exactly one installment (auto-suggested from Payment
 * Date, manually overridable) — per the final business rule, a Deposit
 * always belongs to a specific installment and reduces its Remaining
 * exactly like any other payment against it.
 */
function addCollectBlock_() {
  var id = 'blk' + (collectCtx.blockSeq++);
  var wrap = document.getElementById('collectLines');
  var row = document.createElement('div');
  row.id = id;
  row.style.borderTop = '1px solid var(--border)';
  row.style.paddingTop = '10px';
  row.style.marginTop = '10px';
  row.innerHTML =
    '<div class="form-grid">' +
    field('نوع الرسوم', selectHtml(id + '_fee', collectCtx.feeTypes)) +
    field('نوع الدفعة', selectHtml(id + '_ptype', PAYMENT_TYPES)) +
    '<div class="field"><label>&nbsp;</label><button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'' + id + '\').remove(); recalcTotal_();">حذف البند</button></div>' +
    '</div>' +
    '<div id="' + id + '_body" style="margin-top:8px;"></div>';
  wrap.appendChild(row);
  document.getElementById(id + '_fee').onchange = function () { loadCollectBlockBody_(id); };
  document.getElementById(id + '_ptype').onchange = function () { loadCollectBlockBody_(id); };
}

function loadCollectBlockBody_(id) {
  var fee = document.getElementById(id + '_fee').value;
  var ptype = document.getElementById(id + '_ptype').value;
  var body = document.getElementById(id + '_body');
  if (!fee || !ptype) { body.innerHTML = ''; recalcTotal_(); return; }

  // Both Payment Types now use the SAME preview — ONE call per Fee Type selection,
  // never per checkbox/select change, never per keystroke.
  body.innerHTML = loadingBox();
  apiCall('getCollectionPreview', { studentCode: collectCtx.selectedStudent.code, academicYear: STATE.academicYear, feeType: fee })
    .then(function (preview) {
      var breakdown = preview.installments;
      if (!breakdown.length) {
        body.innerHTML = '<div class="error-box" style="font-size:12.5px;">لا توجد قاعدة سداد أو بند رسوم مُعرّف لهذا النوع لهذا الطالب.</div>';
        recalcTotal_();
        return;
      }
      // Official / Student / Effective — shown once per block, above whichever body renders below.
      var amountInfo = preview.isOverride
        ? '<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:6px;">' + escapeHtml(fee) + ': الرسمي: ' + fmtAmt_(preview.officialAmount) +
          ' — سعر الطالب: ' + fmtNum(preview.approvedAmount) + ' — <b>الفعلي: ' + fmtNum(preview.approvedAmount) + '</b></div>'
        : '<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:6px;">' + escapeHtml(fee) + ': الرسمي: ' + fmtAmt_(preview.officialAmount) +
          ' — سعر الطالب: — — <b>الفعلي: ' + fmtAmt_(preview.officialAmount) + '</b></div>';
      body.innerHTML = amountInfo + '<div id="' + id + '_sub"></div>';
      if (ptype === 'Deposit') {
        renderDepositBody_(id, breakdown);
      } else {
        renderFullAmountBody_(id, breakdown);
      }
    })
    .catch(function (err) { body.innerHTML = '<div class="error-box" style="font-size:12.5px;">' + escapeHtml(err.message) + '</div>'; recalcTotal_(); });
}

/**
 * Deposit: belongs to exactly ONE installment (final business rule). The
 * installment is auto-SUGGESTED from the shared Payment Date against Year
 * Settings' configured date ranges (collectCtx.installmentDates — never
 * hardcoded here), but a manual selection is never overwritten afterward —
 * tracked per-block in collectCtx.depositOverrides.
 */
function renderDepositBody_(id, breakdown) {
  var body = document.getElementById(id + '_sub');
  body.setAttribute('data-breakdown', JSON.stringify(breakdown));
  var suggested = suggestInstallmentForDate_(document.getElementById('pDate').value);
  var current = collectCtx.depositOverrides[id] || suggested || String(breakdown[0].installment);

  body.innerHTML =
    '<div class="form-grid">' +
    field('القسط (مقترح تلقائيًا حسب تاريخ السداد — يمكن تغييره يدويًا)', '<select id="' + id + '_inst">' +
      breakdown.map(function (b) { return '<option value="' + b.installment + '">' + b.percent + '%</option>'; }).join('') + '</select>') +
    field('الخصم (جديد فقط)', '<input type="number" id="' + id + '_disc" min="0" step="0.01" value="0">') +
    field('سبب الخصم', '<input id="' + id + '_reason" placeholder="اختياري">') +
    field('المبلغ (Deposit)', '<input type="number" id="' + id + '_depAmt" min="0" step="0.01">') +
    '</div>' +
    '<div id="' + id + '_info" style="font-size:12.5px;color:var(--text-muted);margin-top:4px;"></div>';

  var instSelect = document.getElementById(id + '_inst');
  instSelect.value = current;
  updateDepositInfo_(id);

  instSelect.addEventListener('change', function () {
    collectCtx.depositOverrides[id] = instSelect.value; // user took manual control — never auto-overwritten again
    updateDepositInfo_(id);
    recalcTotal_();
  });
  document.getElementById(id + '_disc').addEventListener('input', function () { updateDepositInfo_(id); recalcTotal_(); });
  document.getElementById(id + '_depAmt').addEventListener('input', recalcTotal_);
  recalcTotal_();
}

/** Shows the current outstanding for the selected installment — pure display, reads from the ONE preview already fetched. */
function updateDepositInfo_(id) {
  var breakdown = JSON.parse(document.getElementById(id + '_sub').getAttribute('data-breakdown') || '[]');
  var instSelect = document.getElementById(id + '_inst');
  if (!instSelect) return;
  var b = breakdown.filter(function (x) { return String(x.installment) === instSelect.value; })[0];
  var info = document.getElementById(id + '_info');
  if (!b || !info) return;
  var alreadyDiscounted = b.discount > 0;
  info.textContent = 'المستحق الأصلي: ' + fmtNum(b.due) + ' — الخصم الحالي: ' + fmtNum(b.discount) +
    ' — المحصل سابقًا: ' + fmtNum(b.collected) + ' — المتبقي حاليًا: ' + fmtNum(b.remaining) +
    (alreadyDiscounted ? ' (يوجد خصم مطبّق بالفعل — لا يمكن إضافة خصم آخر)' : '');
  var discInput = document.getElementById(id + '_disc');
  if (discInput) discInput.disabled = alreadyDiscounted;
}

/** Re-suggests the installment for every currently-open Deposit block whose selection was never manually overridden. */
function reSuggestAllDepositInstallments_() {
  var suggested = suggestInstallmentForDate_(document.getElementById('pDate').value);
  if (!suggested) return;
  document.querySelectorAll('#collectLines > div').forEach(function (row) {
    var id = row.id;
    var ptypeEl = document.getElementById(id + '_ptype');
    var instSelect = document.getElementById(id + '_inst');
    if (!ptypeEl || ptypeEl.value !== 'Deposit' || !instSelect) return;
    if (collectCtx.depositOverrides[id]) return; // manual selection stands, never overwritten
    instSelect.value = suggested;
    updateDepositInfo_(id);
    recalcTotal_();
  });
}

/** Matches paymentDate against Year Settings' configured installment date ranges — never hardcoded here. */
function suggestInstallmentForDate_(paymentDate) {
  if (!paymentDate || !collectCtx.installmentDates || !collectCtx.installmentDates.length) return null;
  var d = new Date(paymentDate);
  var match = collectCtx.installmentDates.filter(function (inst) {
    return d >= new Date(inst.StartDate) && d <= new Date(inst.EndDate);
  })[0];
  return match ? String(match.InstallmentNo) : null;
}

/** Full Amount: multi-select checkboxes, each checked installment becomes its own line at submit — unchanged behavior. */
function renderFullAmountBody_(id, breakdown) {
  var body = document.getElementById(id + '_sub');
  body.innerHTML =
    '<div class="table-wrap"><table><thead><tr><th></th><th>النسبة</th><th>المتبقي حاليًا</th><th>خصم جديد</th><th>سبب الخصم</th></tr></thead><tbody>' +
    breakdown.map(function (b) {
      var cid = id + '_i' + b.installment;
      var alreadyDiscounted = b.discount > 0;
      var discCell = alreadyDiscounted
        ? '<span style="color:var(--text-muted);font-size:12px;">خصم مطبّق: ' + fmtNum(b.discount) + '</span>'
        : '<input type="number" id="' + cid + '_disc" min="0" step="0.01" value="0" style="width:90px;" disabled>';
      var reasonCell = alreadyDiscounted ? '' : '<input id="' + cid + '_reason" placeholder="اختياري" style="width:110px;" disabled>';
      return '<tr><td><input type="checkbox" id="' + cid + '_chk" data-installment="' + b.installment + '" data-remaining="' + b.remaining + '" data-locked-discount="' + alreadyDiscounted + '"></td>' +
        '<td>' + b.percent + '%</td><td class="num">' + fmtNum(b.remaining) + '</td>' +
        '<td>' + discCell + '</td><td>' + reasonCell + '</td></tr>';
    }).join('') +
    '</tbody></table></div>';
  breakdown.forEach(function (b) {
    var cid = id + '_i' + b.installment;
    var chk = document.getElementById(cid + '_chk');
    var discInput = document.getElementById(cid + '_disc'); // only exists when no discount locked yet
    var reasonInput = document.getElementById(cid + '_reason');
    chk.addEventListener('change', function () {
      if (discInput) discInput.disabled = !chk.checked;
      if (reasonInput) reasonInput.disabled = !chk.checked;
      recalcTotal_();
    });
    if (discInput) discInput.addEventListener('input', recalcTotal_);
  });
  recalcTotal_();
}

/** Pure client-side sum for display — the server always recomputes and enforces the authoritative amount. */
function recalcTotal_() {
  var total = 0;
  document.querySelectorAll('[id$="_depAmt"]').forEach(function (inp) { total += Number(inp.value || 0); });
  document.querySelectorAll('[id$="_chk"]').forEach(function (chk) {
    if (!chk.checked) return;
    var remaining = Number(chk.getAttribute('data-remaining') || 0);
    var discInput = document.getElementById(chk.id.replace('_chk', '_disc'));
    // discInput exists and is enabled only when no discount is locked yet.
    var effectiveDisc = (discInput && chk.getAttribute('data-locked-discount') !== 'true') ? Number(discInput.value || 0) : 0;
    total += Math.max(0, remaining - effectiveDisc);
  });
  var el = document.getElementById('pTotal');
  if (el) el.textContent = 'الإجمالي: ' + fmtNum(total);
}
function field(label, inputHtml) { return '<div class="field"><label>' + label + '</label>' + inputHtml + '</div>'; }
function selectHtml(id, options) {
  return '<select id="' + id + '"><option value="">اختر...</option>' +
    options.map(function (o) { return '<option value="' + escapeHtml(o) + '">' + escapeHtml(o) + '</option>'; }).join('') + '</select>';
}
function todayStr_() { return new Date().toISOString().substring(0, 10); }

/**
 * Shows the collector the actual Receipt Number that will be used, BEFORE
 * they save — server-authoritative (from previewReceiptNumber_ in
 * Payments.gs), never invented by the frontend. It's a starting value in an
 * editable field the collector can still change; either way, createCollection_
 * re-verifies the final number is still free under its write lock right
 * before saving, and rejects clearly (never silently renumbers) if it isn't.
 */
function fetchReceiptNumberPreview_() {
  apiCall('previewReceiptNumber', {})
    .then(function (r) {
      var input = document.getElementById('pReceipt');
      if (input && !input.value) input.value = r.receiptNumber;
    })
    .catch(function () { /* non-critical — the field just stays blank, server still auto-generates one at save time */ });
}

var lastIdempotencyKey = null;
function submitPayment_(content) {
  if (!collectCtx.selectedStudent) { toast('اختر الطالب أولًا', 'error'); return; }
  var btn = document.getElementById('pSaveBtn');
  var status = document.getElementById('pStatus');

  var blockRows = document.querySelectorAll('#collectLines > div');
  var lines = [];
  var lineError = null;
  blockRows.forEach(function (row) {
    var id = row.id;
    var feeEl = document.getElementById(id + '_fee'), ptypeEl = document.getElementById(id + '_ptype');
    if (!feeEl || !ptypeEl) return; // block removed
    var fee = feeEl.value, ptype = ptypeEl.value;
    if (!fee || !ptype) { lineError = 'أكمل نوع الرسوم ونوع الدفعة لكل بند'; return; }

    if (ptype === 'Deposit') {
      var instEl = document.getElementById(id + '_inst');
      var depInput = document.getElementById(id + '_depAmt');
      var discInput = document.getElementById(id + '_disc');
      var reasonInput = document.getElementById(id + '_reason');
      var installment = instEl ? instEl.value : '';
      var depAmt = Number((depInput && depInput.value) || 0);
      if (!installment) { lineError = 'اختر القسط لبند Deposit — ' + fee; return; }
      if (depAmt <= 0) { lineError = 'أدخل مبلغ Deposit صحيح في بند ' + fee; return; }
      var isLocked = discInput ? discInput.disabled : false;
      var disc = isLocked ? 0 : Number((discInput && discInput.value) || 0);
      var reason = isLocked ? '' : ((reasonInput && reasonInput.value) || '');
      lines.push({ feeType: fee, paymentType: 'Deposit', installment: installment, amountPaid: depAmt, discountAmount: disc, discountReason: reason });
      return;
    }

    // Full Amount: one line per checked installment.
    var anyChecked = false;
    row.querySelectorAll('[id$="_chk"]').forEach(function (chk) {
      if (!chk.checked) return;
      anyChecked = true;
      var installment = chk.getAttribute('data-installment');
      var remaining = Number(chk.getAttribute('data-remaining') || 0);
      var locked = chk.getAttribute('data-locked-discount') === 'true';
      var discInput = document.getElementById(chk.id.replace('_chk', '_disc'));
      var reasonInput = document.getElementById(chk.id.replace('_chk', '_reason'));
      var disc = (!locked && discInput) ? Number(discInput.value || 0) : 0;
      var reason = (!locked && reasonInput) ? (reasonInput.value || '') : '';
      var amt = Math.round((remaining - disc) * 100) / 100;
      if (amt <= 0) { lineError = 'قيمة السداد غير صحيحة لأحد الأقساط في بند ' + fee; return; }
      lines.push({ feeType: fee, paymentType: 'Full Amount', installment: installment, amountPaid: amt, discountAmount: disc, discountReason: reason });
    });
    if (!anyChecked) lineError = 'اختر قسطًا واحدًا على الأقل عند اختيار Full Amount في بند ' + fee;
  });
  if (!lines.length && !lineError) lineError = 'أضف بندًا واحدًا على الأقل';
  if (lineError) { toast(lineError, 'error'); return; }

  var payload = {
    studentCode: collectCtx.selectedStudent.code,
    academicYear: STATE.academicYear,
    paymentDate: document.getElementById('pDate').value,
    paymentMethod: document.getElementById('pMethod').value,
    receiptNumber: document.getElementById('pReceipt').value,
    notes: document.getElementById('pNotes').value,
    lines: lines
  };
  if (!lastIdempotencyKey) lastIdempotencyKey = 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  payload.idempotencyKey = lastIdempotencyKey;

  btn.disabled = true; status.textContent = 'جارٍ الحفظ...';
  apiCall('createPayment', payload)
    .then(function (data) {
      lastIdempotencyKey = null;
      toast('تم تسجيل التحصيل بنجاح', 'success');
      status.innerHTML = 'تم تحصيل ' + fmtNum(data.totalPaid) + ' ج.م &nbsp; ' +
        '<button class="btn btn-success btn-sm" onclick="openReceipt_(\'' + data.receiptNumber + '\')">&#128220; عرض / طباعة الإيصال</button>';
      // Do NOT reload the whole app, and do NOT lose the selected student — just reset the
      // line items/notes/receipt-number fields and refresh the student's totals (one call).
      document.getElementById('pReceipt').value = '';
      document.getElementById('pNotes').value = '';
      document.getElementById('collectLines').innerHTML = '';
      collectCtx.blockSeq = 0;
      collectCtx.depositOverrides = {};
      addCollectBlock_();
      recalcTotal_();
      loadCollectStudentSummary_(content);
      fetchReceiptNumberPreview_(); // a fresh server-authoritative number for the NEXT collection
    })
    .catch(function (err) {
      status.textContent = '';
      toast(err.message, 'error');
      if (err.code === 'RECEIPT_NUMBER_TAKEN') {
        // Never silently renumber — clear the stale number and fetch a genuinely fresh one for the collector to use.
        document.getElementById('pReceipt').value = '';
        fetchReceiptNumberPreview_();
      }
    })
    .finally(function () { btn.disabled = false; });
}

/* ============================ Payments list ============================ */
var paymentsPage = 1;
function renderPayments(content, page) {
  paymentsPage = page || 1;
  apiCall('listPayments', { academicYear: STATE.academicYear, page: paymentsPage, pageSize: 25 })
    .then(function (data) {
      content.innerHTML =
        panelHeader('سجل المدفوعات', exportToolbarHtml_('pay') + '<button class="btn btn-secondary" id="payExcelBtn">&#128202; Excel</button>') +
        '<div class="table-wrap"><table><thead><tr><th>رقم الإيصال</th><th>الطالب</th><th>نوع الرسوم</th><th>القسط</th><th>نوع الدفعة</th><th>التاريخ</th>' +
        '<th>صافي المستحق</th><th>المحصل</th><th>طريقة الدفع</th><th>الحالة</th><th></th></tr></thead><tbody>' +
        data.items.map(function (p) {
          var badge = p.Status === 'Cancelled' ? '<span class="badge badge-red">ملغاة</span>' : '<span class="badge badge-green">نشطة</span>';
          return '<tr><td>' + escapeHtml(p.ReceiptNumber) + '</td><td>' + escapeHtml(p.StudentCode) + '</td><td>' + escapeHtml(p.FeeType) +
            '</td><td>' + escapeHtml(installmentDisplay_(p)) + '</td><td>' + escapeHtml(p.PaymentType || '') + '</td><td>' + escapeHtml(String(p.PaymentDate).substring(0, 10)) +
            '</td><td class="num">' + fmtNum(p.NetDue) + '</td><td class="num">' + fmtNum(p.AmountPaid) + '</td><td>' + escapeHtml(p.PaymentMethod) +
            '</td><td>' + badge + '</td><td><button class="btn btn-secondary btn-sm" onclick="openReceipt_(\'' + p.ReceiptNumber + '\')">إيصال</button></td></tr>';
        }).join('') +
        '</tbody></table></div>' + paginationBar(data, function (p) { renderPayments(content, p); }) + '</div>';
      bindExportToolbar_('pay', 'سجل المدفوعات', getScreenPrintableContent_, 'payments', function () { return { academicYear: STATE.academicYear }; });
    })
    .catch(function (err) { content.innerHTML = errorBox(err.message, function () { renderPayments(content, paymentsPage); }); });
}

/* ============================ Reports ============================ */
function renderReportRevenue(content) {
  var from = todayStr_(), to = todayStr_();
  function load(page) {
    apiCall('reportRevenue', { academicYear: STATE.academicYear, dateFrom: from, dateTo: to, page: page || 1, pageSize: 25 })
      .then(function (data) {
        content.innerHTML =
          panelHeader('تقرير الإيرادات', filterDates_()) +
          '<div style="padding:14px 18px 0;"><b>الإجمالي: ' + fmtNum(data.total_amount) + ' ج.م</b> &nbsp; (' + fmtNum(data.transaction_count) + ' عملية)</div>' +
          '<div class="table-wrap"><table><thead><tr><th>رقم الإيصال</th><th>الطالب</th><th>نوع الرسوم</th><th>التاريخ</th><th>المحصل</th><th>طريقة الدفع</th></tr></thead><tbody>' +
          data.items.map(function (p) {
            return '<tr><td>' + escapeHtml(p.ReceiptNumber) + '</td><td>' + escapeHtml(p.StudentCode) + '</td><td>' + escapeHtml(p.FeeType) +
              '</td><td>' + escapeHtml(String(p.PaymentDate).substring(0, 10)) + '</td><td class="num">' + fmtNum(p.AmountPaid) + '</td><td>' + escapeHtml(p.PaymentMethod) + '</td></tr>';
          }).join('') + '</tbody></table></div>' + paginationBar(data, load) + '</div>';
        bindDateFilter_(function () { from = document.getElementById('fFrom').value; to = document.getElementById('fTo').value; load(1); });
        bindExport_(function (btn) { exportExcel_('revenue', { academicYear: STATE.academicYear, dateFrom: from, dateTo: to }, 'الإيرادات', btn); });
        bindExportToolbar_('f', 'تقرير الإيرادات', function () {
          return '<div style="margin-bottom:8px;">الفترة: ' + escapeHtml(from) + ' إلى ' + escapeHtml(to) + '</div>' + getScreenPrintableContent_();
        });
      })
      .catch(function (err) { content.innerHTML = errorBox(err.message, function () { load(page); }); });
  }
  load(1);
}
function filterDates_() {
  return '<div class="filters-row">' +
    field('من تاريخ', '<input type="date" id="fFrom" value="' + todayStr_() + '">') +
    field('إلى تاريخ', '<input type="date" id="fTo" value="' + todayStr_() + '">') +
    '<button class="btn btn-secondary" id="fApply">تطبيق</button>' +
    exportToolbarHtml_('f') + '<button class="btn btn-secondary" id="fExport">&#128202; Excel</button></div>';
}
function bindDateFilter_(fn) { var b = document.getElementById('fApply'); if (b) b.onclick = fn; }
function bindExport_(fn) { var b = document.getElementById('fExport'); if (b) b.onclick = function () { fn(b); }; }

var remainingPage = 1;
function renderReportRemaining(content, page) {
  remainingPage = page || 1;
  apiCall('reportRemainingBalance', { academicYear: STATE.academicYear, page: remainingPage, pageSize: 25 })
    .then(function (data) {
      content.innerHTML =
        panelHeader('المتبقي على الطلاب', exportToolbarHtml_('rem') + '<button class="btn btn-secondary" id="remExcelBtn">&#128202; Excel</button>') +
        '<div class="table-wrap"><table><thead><tr><th>الكود</th><th>الاسم</th><th>المرحلة</th><th>الفصل</th><th>الأصل</th><th>الخصم</th><th>الصافي</th><th>المحصل</th><th>المتبقي</th></tr></thead><tbody>' +
        data.items.map(function (r) {
          return '<tr><td>' + escapeHtml(r.studentCode) + '</td><td>' + escapeHtml(r.studentName) + '</td><td>' + escapeHtml(r.stage) +
            '</td><td>' + escapeHtml(r.className) + '</td><td class="num">' + fmtNum(r.originalDue) + '</td><td class="num">' + fmtNum(r.discount) +
            '</td><td class="num">' + fmtNum(r.netDue) + '</td><td class="num">' + fmtNum(r.collected) + '</td><td class="num">' +
            (r.remaining > 0 ? '<span class="badge badge-red">' + fmtNum(r.remaining) + '</span>' : '<span class="badge badge-green">0</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' + paginationBar(data, function (p) { renderReportRemaining(content, p); }) + '</div>';
      bindExportToolbar_('rem', 'المتبقي على الطلاب', getScreenPrintableContent_, 'remaining', function () { return { academicYear: STATE.academicYear }; });
    })
    .catch(function (err) { content.innerHTML = errorBox(err.message, function () { renderReportRemaining(content, remainingPage); }); });
}

/* ============================ Adjusted Fees report ============================ */
/**
 * ONLY students with a saved override (server decides via the override
 * columns themselves — never "current != official"). Filters: search
 * (name/code), Stage, Class, Department — same filterStudents_ the Students
 * screen uses. Excel = existing server export (full filtered set). Print/PDF
 * = ONE batch call for the full filtered set, never just the visible page.
 */
var adjustedPage = 1;
function renderAdjustedFees(content, page) {
  adjustedPage = page || 1;
  var f = {
    search: (document.getElementById('adjSearch') || {}).value || '',
    stage: (document.getElementById('adjStage') || {}).value || '',
    className: (document.getElementById('adjClass') || {}).value || '',
    department: (document.getElementById('adjDept') || {}).value || ''
  };
  var baseFilters = { academicYear: STATE.academicYear, search: f.search, stage: f.stage, className: f.className, department: f.department };
  var calls = [apiCall('reportAdjustedFees', Object.assign({ page: adjustedPage, pageSize: 25 }, baseFilters))];
  if (!studentsFilterOptions_) calls.push(apiCall('getStudentFilters', { academicYear: STATE.academicYear }));

  Promise.all(calls).then(function (r) {
    var data = r[0];
    if (r[1]) studentsFilterOptions_ = r[1];
    var opts = studentsFilterOptions_ || { stages: [], classNames: [], departments: [] };
    content.innerHTML =
      panelHeader('الطلاب ذوو الرسوم المعدَّلة', '<div class="filters-row">' +
        '<div class="field"><label>بحث (الاسم أو الكود)</label><input id="adjSearch" class="search-box" value="' + escapeHtml(f.search) + '"></div>' +
        field('المرحلة', selectHtmlWithSelected_('adjStage', opts.stages, f.stage)) +
        field('الفصل', selectHtmlWithSelected_('adjClass', opts.classNames, f.className)) +
        field('القسم', selectHtmlWithSelected_('adjDept', opts.departments, f.department)) +
        '<button class="btn btn-secondary" id="adjApply">بحث</button>' +
        exportToolbarHtml_('adj') + '<button class="btn btn-secondary" id="adjExcelBtn">&#128202; Excel</button></div>') +
      '<div class="table-wrap">' + adjustedTableHtml_(data.items) + '</div>' +
      paginationBar(data, function (p) { renderAdjustedFees(content, p); }) + '</div>';

    function reload() { renderAdjustedFees(content, 1); }
    document.getElementById('adjApply').onclick = reload;
    document.getElementById('adjStage').onchange = reload;
    document.getElementById('adjClass').onchange = reload;
    document.getElementById('adjDept').onchange = reload;
    document.getElementById('adjSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') reload(); });

    document.getElementById('adjExcelBtn').onclick = function () {
      exportExcel_('adjustedFees', baseFilters, 'الطلاب ذوو الرسوم المعدَّلة', document.getElementById('adjExcelBtn'));
    };
    function withFullSet(fn) {
      apiCall('reportAdjustedFees', Object.assign({ page: 1, pageSize: 100000 }, baseFilters))
        .then(function (all) { fn(adjustedTableHtml_(all.items)); })
        .catch(function (err) { toast(err.message, 'error'); });
    }
    document.getElementById('adjPrintBtn').onclick = function () {
      withFullSet(function (html) { printReport_('الطلاب ذوو الرسوم المعدَّلة', html); });
    };
    document.getElementById('adjPdfBtn').onclick = function () {
      withFullSet(function (html) { exportPdf_('الطلاب ذوو الرسوم المعدَّلة', html, document.getElementById('adjPdfBtn')); });
    };
  }).catch(function (err) { content.innerHTML = errorBox(err.message, function () { renderAdjustedFees(content, adjustedPage); }); });
}

function adjustedTableHtml_(items) {
  if (!items.length) return '<div class="state-box">لا يوجد طلاب لديهم رسوم معدَّلة</div>';
  return '<table><thead><tr><th>الكود</th><th>الاسم</th><th>المرحلة</th><th>الفصل</th><th>القسم</th>' +
    '<th>تعليم رسمي</th><th>تعليم معتمد</th><th>نشاط رسمي</th><th>نشاط معتمد</th><th>باص رسمي</th><th>باص معتمد</th>' +
    '<th>الأنواع المعدَّلة</th><th>الفرق</th></tr></thead><tbody>' +
    items.map(function (s) {
      return '<tr><td>' + escapeHtml(s.StudentCode) + '</td><td>' + escapeHtml(s.StudentName) + '</td><td>' + escapeHtml(s.Stage) +
        '</td><td>' + escapeHtml(s.ClassName) + '</td><td>' + escapeHtml(s.Department) +
        '</td><td class="num">' + fmtAmt_(s.EducationOfficial) + '</td><td class="num">' + fmtAmt_(s.EducationApproved) +
        '</td><td class="num">' + fmtAmt_(s.ActivityOfficial) + '</td><td class="num">' + fmtAmt_(s.ActivityApproved) +
        '</td><td class="num">' + fmtAmt_(s.BusOfficial) + '</td><td class="num">' + fmtAmt_(s.BusApproved) +
        '</td><td>' + escapeHtml(s.AdjustedTypes) + '</td><td class="num">' + fmtAmt_(s.Difference) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

/* ============================ Statement ============================ */
function renderStatement(content) {
  content.innerHTML =
    '<div class="panel"><div class="panel-header"><h3>كشف حساب طالب</h3>' +
    '<div class="filters-row">' + field('كود الطالب', '<input id="stCode" placeholder="STU1001">') +
    '<button class="btn btn-primary" id="stLoadBtn">عرض</button>' + exportToolbarHtml_('st') +
    '<button class="btn btn-secondary" id="stExcelBtn">&#128202; Excel</button></div></div>' +
    '<div class="panel-body" id="stBody"></div></div>';
  var lastStatement = null;
  document.getElementById('stLoadBtn').onclick = function () {
    var code = document.getElementById('stCode').value.trim();
    if (!code) return;
    var body = document.getElementById('stBody');
    body.innerHTML = loadingBox();
    apiCall('getStudentStatement', { studentCode: code, academicYear: STATE.academicYear })
      .then(function (d) {
        lastStatement = d;
        body.innerHTML =
          '<h4>' + escapeHtml(d.student.StudentName) + ' — ' + escapeHtml(d.student.StudentCode) + '</h4>' +
          '<p style="color:var(--text-muted);font-size:13px;">' + escapeHtml(d.student.Stage) + ' / ' + escapeHtml(d.student.ClassName) + ' / ' + escapeHtml(d.student.Department) + '</p>' +
          '<div class="table-wrap"><table><thead><tr><th>نوع الرسوم</th><th>المستحق</th><th>الخصم</th><th>الصافي</th><th>المحصل</th><th>المتبقي</th></tr></thead><tbody>' +
          d.lines.map(function (l) { return '<tr><td>' + escapeHtml(l.feeType) + '</td><td class="num">' + fmtNum(l.originalDue) + '</td><td class="num">' + fmtNum(l.discount) +
            '</td><td class="num">' + fmtNum(l.netDue) + '</td><td class="num">' + fmtNum(l.collected) + '</td><td class="num">' + fmtNum(l.remaining) + '</td></tr>'; }).join('') +
          '</tbody><tfoot><tr style="font-weight:700;"><td>الإجمالي</td><td class="num">' + fmtNum(d.totals.due) + '</td><td class="num">' + fmtNum(d.totals.discount) +
          '</td><td class="num">' + fmtNum(d.totals.due - d.totals.discount) + '</td><td class="num">' + fmtNum(d.totals.collected) + '</td><td class="num">' + fmtNum(d.totals.remaining) + '</td></tr></tfoot></table></div>' +
          '<h4 style="margin-top:18px;">عمليات التحصيل</h4>' +
          '<div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>نوع الرسوم</th><th>القسط</th><th>نوع الدفعة</th><th>المبلغ</th><th>طريقة الدفع</th><th>الإيصال</th><th>بواسطة</th></tr></thead><tbody>' +
          d.transactions.map(function (t) { return '<tr><td>' + escapeHtml(String(t.PaymentDate).substring(0, 10)) + '</td><td>' + escapeHtml(t.FeeType) +
            '</td><td>' + escapeHtml(installmentDisplay_(t)) + '</td><td>' + escapeHtml(t.PaymentType || '') + '</td><td class="num">' + fmtNum(t.AmountPaid) + '</td><td>' + escapeHtml(t.PaymentMethod) +
            '</td><td><button class="btn btn-secondary btn-sm" onclick="openReceipt_(\'' + t.ReceiptNumber + '\')">' + escapeHtml(t.ReceiptNumber) + '</button></td><td>' + escapeHtml(t.CreatedBy) + '</td></tr>'; }).join('') +
          '</tbody></table></div>';
      })
      .catch(function (err) { body.innerHTML = errorBox(err.message, function () { document.getElementById('stLoadBtn').click(); }); });
  };
  document.getElementById('stPrintBtn').onclick = function () {
    if (!lastStatement) { toast('اعرض كشف حساب أولًا', 'error'); return; }
    printReport_('كشف حساب — ' + lastStatement.student.StudentName, getScreenPrintableContent_());
  };
  document.getElementById('stPdfBtn').onclick = function () {
    if (!lastStatement) { toast('اعرض كشف حساب أولًا', 'error'); return; }
    exportPdf_('كشف حساب — ' + lastStatement.student.StudentName, getScreenPrintableContent_(), document.getElementById('stPdfBtn'));
  };
  // Statement data is already fully loaded client-side (one student, one call) — no server Excel
  // report exists for this and none is needed; SheetJS (already loaded for Student Import) builds
  // the .xlsx directly from what's already in memory, zero extra API calls.
  document.getElementById('stExcelBtn').onclick = function () {
    if (!lastStatement) { toast('اعرض كشف حساب أولًا', 'error'); return; }
    var d = lastStatement;
    var wb = XLSX.utils.book_new();
    var summarySheet = XLSX.utils.json_to_sheet(d.lines.map(function (l) {
      return { 'نوع الرسوم': l.feeType, 'المستحق': l.originalDue, 'الخصم': l.discount, 'الصافي': l.netDue, 'المحصل': l.collected, 'المتبقي': l.remaining };
    }));
    XLSX.utils.book_append_sheet(wb, summarySheet, 'الملخص');
    var txSheet = XLSX.utils.json_to_sheet(d.transactions.map(function (t) {
      return {
        'التاريخ': String(t.PaymentDate).substring(0, 10), 'نوع الرسوم': t.FeeType, 'القسط': installmentDisplay_(t),
        'نوع الدفعة': t.PaymentType || '', 'المبلغ': t.AmountPaid, 'طريقة الدفع': t.PaymentMethod, 'الإيصال': t.ReceiptNumber, 'بواسطة': t.CreatedBy
      };
    }));
    XLSX.utils.book_append_sheet(wb, txSheet, 'عمليات التحصيل');
    XLSX.writeFile(wb, 'كشف حساب - ' + d.student.StudentCode + '.xlsx');
  };
}

/* ============================ Settings (admin) ============================ */
/**
 * Fixed business grouping for Education Fee Schedule entry — never stored
 * anywhere server-side, purely a client-side convenience so an admin can
 * enter one amount per Department+Group instead of per individual Stage.
 * Saving fans this out to real Stage rows via upsertFeeScheduleGroup.
 */
var EDUCATION_GROUPS = {
  AM: [
    { key: 'KG', label: 'كي جي (KG1–KG2) — أمريكي وبريطاني معًا', stages: ['KG1', 'KG2'], departments: ['AM', 'BR'] },
    { key: 'Primary', label: 'ابتدائي (G1–G6)', stages: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'] },
    { key: 'Middle', label: 'إعدادي (G7–G9)', stages: ['G7', 'G8', 'G9'] },
    { key: 'Secondary', label: 'ثانوي (G10–G12)', stages: ['G10', 'G11', 'G12'] }
  ],
  BR: [
    { key: 'KG', label: 'كي جي (KG1–KG2) — أمريكي وبريطاني معًا', stages: ['KG1', 'KG2'], departments: ['AM', 'BR'] },
    { key: 'Primary', label: 'ابتدائي (Y1–Y6)', stages: ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6'] },
    { key: 'Middle', label: 'إعدادي (Y7–Y9)', stages: ['Y7', 'Y8', 'Y9'] },
    { key: 'Secondary', label: 'ثانوي (Y10–Y12)', stages: ['Y10', 'Y11', 'Y12'] }
  ]
};

function renderSettings(content) {
  content.innerHTML =
    '<div class="panel"><div class="panel-header"><h3>السنوات الدراسية وبنود الرسوم وقواعد السداد</h3><div>' + exportToolbarHtml_('set') +
    '<button class="btn btn-secondary btn-sm" id="setExcelBtn">&#128202; Excel</button></div></div><div class="panel-body" id="setBody">' + loadingBox() + '</div></div>';
  loadSettings_(content);
}

function loadSettings_(content) {
  Promise.all([
    apiCall('getYearSettings', {}), apiCall('getFeeSchedule', { academicYear: STATE.academicYear }),
    apiCall('getInstallments', { academicYear: STATE.academicYear }), apiCall('getFeeTypes', {}),
    apiCall('validateStudentStages', { academicYear: STATE.academicYear }), apiCall('getPaymentRules', { academicYear: STATE.academicYear })
  ]).then(function (r) {
      var years = r[0], schedule = r[1], installments = r[2], feeTypesList = r[3], stageIssues = r[4], rules = r[5];
      var rulesByFeeType = {};
      rules.forEach(function (rr) { rulesByFeeType[rr.feeType] = rr; });
      var stageIssuesHtml = Object.keys(stageIssues).length
        ? '<div class="state-box error-box" style="text-align:right;padding:10px 0;">⚠ قيم Stage غير معروفة في بيانات الطلاب (لم يتم تعديلها تلقائيًا): ' +
          Object.keys(stageIssues).map(function (k) { return escapeHtml(k) + ' (' + stageIssues[k] + ')'; }).join('، ') + '</div>'
        : '';

      document.getElementById('setBody').innerHTML =
        '<h4>السنوات الدراسية</h4>' +
        '<div class="table-wrap"><table><thead><tr><th>السنة</th><th>البداية</th><th>النهاية</th></tr></thead><tbody>' +
        years.map(function (y) { return '<tr><td>' + escapeHtml(y.Key) + '</td><td>' + escapeHtml(y.From) + '</td><td>' + escapeHtml(y.To) + '</td></tr>'; }).join('') +
        '</tbody></table></div>' +
        '<div class="form-grid" style="margin-top:8px;">' +
        field('سنة دراسية جديدة (مثال 2027/2028)', '<input id="newYearKey">') +
        field('بداية السنة', '<input type="date" id="newYearFrom">') +
        field('نهاية السنة', '<input type="date" id="newYearTo">') +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-secondary btn-sm" id="addYearBtn">إضافة سنة</button></div>' +
        '</div>' +

        '<h4 style="margin-top:18px;">الأقساط — ' + STATE.academicYear + '</h4>' +
        '<div class="table-wrap"><table><thead><tr><th>رقم القسط</th><th>الاسم</th><th>من</th><th>إلى</th><th></th></tr></thead><tbody>' +
        installments.map(function (i) {
          return '<tr><td>' + escapeHtml(i.InstallmentNo) + '</td><td>' + escapeHtml(i.Label) +
            '</td><td><input type="date" class="inst-from" data-no="' + escapeHtml(i.InstallmentNo) + '" value="' + escapeHtml(i.StartDate) + '"></td>' +
            '<td><input type="date" class="inst-to" data-no="' + escapeHtml(i.InstallmentNo) + '" value="' + escapeHtml(i.EndDate) + '"></td>' +
            '<td><button class="btn btn-secondary btn-sm inst-save" data-no="' + escapeHtml(i.InstallmentNo) + '" data-label="' + escapeHtml(i.Label) + '">حفظ</button></td></tr>';
        }).join('') +
        '</tbody></table></div>' +

        '<h4 style="margin-top:18px;">أنواع الرسوم وقواعد السداد (Payment Rules — نسبة % من كل نوع رسوم لكل قسط، وليست مبلغًا)</h4>' +
        '<div class="table-wrap"><table><thead><tr><th>نوع الرسوم</th><th>القسط 1 %</th><th>القسط 2 %</th><th>القسط 3 %</th><th></th></tr></thead><tbody id="rulesBody">' +
        feeTypesList.map(function (ft) { return ruleRow_(ft, rulesByFeeType[ft] || null); }).join('') +
        '</tbody></table></div>' +
        '<div class="form-grid" style="margin-top:8px;">' +
        field('نوع رسوم جديد', '<input id="newFeeType">') +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-secondary btn-sm" id="addFeeTypeBtn">إضافة نوع رسوم</button></div>' +
        '</div>' +

        '<h4 style="margin-top:18px;">لائحة الرسوم — ' + STATE.academicYear + '</h4>' +
        (schedule.length ? '' : '<p style="color:var(--text-muted);font-size:13px;">لا توجد بنود رسوم بعد — أضفها أدناه (لن يخترع النظام أي مبلغ).</p>') +

        '<div style="font-weight:600;margin-top:10px;">تعليم — حسب القسم والمجموعة</div>' +
        '<div class="form-grid" style="margin-top:6px;">' +
        field('القسم', selectHtml('eduDept', ['أمريكي', 'بريطاني'])) +
        field('المجموعة', '<select id="eduGroup"></select>') +
        field('المبلغ السنوي', '<input type="number" id="eduAmount" min="0" step="0.01">') +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-primary btn-sm" id="saveEduGroupBtn">حفظ</button></div>' +
        '</div>' +

        '<div style="font-weight:600;margin-top:18px;">مواد إضافية — القسم الأمريكي فقط (ليست نوع تحصيل)</div>' +
        '<div class="form-grid" style="margin-top:6px;">' +
        field('المبلغ السنوي', '<input type="number" id="materialsAmount" min="0" step="0.01">') +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-primary btn-sm" id="saveMaterialsBtn">حفظ</button></div>' +
        '</div>' +
        '<p style="color:var(--text-muted);font-size:12px;margin-top:4px;">هذا بند إعدادي/عرضي فقط — لا يظهر كنوع تحصيل، ولا يمكن تحصيل مبلغ باسمه من شاشة التحصيل.</p>' +

        '<div style="font-weight:600;margin-top:18px;">نشاط وباص — مبلغ واحد لكل السنة الدراسية</div>' +
        '<div class="form-grid" style="margin-top:6px;">' +
        field('نوع الرسوم', selectHtml('actBusType', ['نشاط', 'باص'])) +
        field('المبلغ السنوي', '<input type="number" id="actBusAmount" min="0" step="0.01">') +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-primary btn-sm" id="saveActBusBtn">حفظ</button></div>' +
        '</div>' +

        '<h4 style="margin-top:18px;">البنود الحالية</h4>' +
        '<div class="table-wrap"><table><thead><tr><th>المرحلة</th><th>القسم</th><th>نوع الرسوم</th><th>المبلغ الإجمالي</th><th></th></tr></thead><tbody id="scheduleBody">' +
        schedule.map(function (f) { return feeScheduleRow_(f); }).join('') +
        '</tbody></table></div>' +

        '<details id="advancedFeeScheduleDetails" style="margin-top:14px;"><summary style="cursor:pointer;font-weight:600;">متقدم / إدخال يدوي (لحالات خاصة مثل قيم Stage غير القياسية مثل "G 9")</summary>' +
        '<div class="form-grid" style="margin-top:8px;">' +
        field('المرحلة', '<input id="fsStage" placeholder="مثال: G1 أو G 9">') +
        field('القسم (اتركه فارغًا = كل الأقسام)', '<input id="fsDept" placeholder="AM / BR">') +
        field('نوع الرسوم', selectHtml('fsFeeType', feeTypesList)) +
        field('المبلغ الإجمالي', '<input type="number" id="fsAmount" min="0" step="0.01">') +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-primary btn-sm" id="addScheduleBtn">حفظ البند</button></div>' +
        '</div></details>' +

        stageIssuesHtml;

      // Year
      document.getElementById('addYearBtn').onclick = function () {
        var key = document.getElementById('newYearKey').value.trim();
        var from = document.getElementById('newYearFrom').value, to = document.getElementById('newYearTo').value;
        if (!key || !from || !to) { toast('أدخل السنة وتاريخي البداية والنهاية', 'error'); return; }
        apiCall('createYearSetting', { academicYear: key, startDate: from, endDate: to, installments: [] })
          .then(function () { toast('تمت إضافة السنة الدراسية', 'success'); loadSettings_(content); })
          .catch(function (err) { toast(err.message, 'error'); });
      };

      // Installments
      document.querySelectorAll('.inst-save').forEach(function (btn) {
        btn.onclick = function () {
          var no = btn.getAttribute('data-no');
          var from = document.querySelector('.inst-from[data-no="' + no + '"]').value;
          var to = document.querySelector('.inst-to[data-no="' + no + '"]').value;
          apiCall('upsertInstallment', { academicYear: STATE.academicYear, no: no, label: btn.getAttribute('data-label'), startDate: from, endDate: to })
            .then(function () { toast('تم حفظ القسط ' + no, 'success'); })
            .catch(function (err) { toast(err.message, 'error'); });
        };
      });

      // Payment rules
      bindRuleSaveButtons_();

      // Fee types
      document.getElementById('addFeeTypeBtn').onclick = function () {
        var ft = document.getElementById('newFeeType').value.trim();
        if (!ft) return;
        apiCall('upsertFeeType', { academicYear: STATE.academicYear, feeType: ft })
          .then(function () { toast('تمت إضافة نوع الرسوم', 'success'); loadSettings_(content); })
          .catch(function (err) { toast(err.message, 'error'); });
      };

      // Fee schedule — Education Group (batch save)
      function populateEduGroups() {
        var dept = document.getElementById('eduDept').value === 'أمريكي' ? 'AM' : 'BR';
        var groupSelect = document.getElementById('eduGroup');
        groupSelect.innerHTML = EDUCATION_GROUPS[dept].map(function (g) { return '<option value="' + g.key + '">' + g.label + '</option>'; }).join('');
      }
      populateEduGroups();
      document.getElementById('eduDept').onchange = populateEduGroups;
      document.getElementById('saveEduGroupBtn').onclick = function () {
        var deptLabel = document.getElementById('eduDept').value;
        var dept = deptLabel === 'أمريكي' ? 'AM' : 'BR';
        var groupKey = document.getElementById('eduGroup').value;
        var groupDef = EDUCATION_GROUPS[dept].filter(function (g) { return g.key === groupKey; })[0];
        var amount = document.getElementById('eduAmount').value;
        if (amount === '') { toast('أدخل المبلغ', 'error'); return; }
        var eduBtn = document.getElementById('saveEduGroupBtn');
        eduBtn.disabled = true;
        apiCall('upsertFeeScheduleGroup', { academicYear: STATE.academicYear, department: dept, departments: groupDef.departments || [dept], feeType: 'تعليم', stages: groupDef.stages, amount: amount })
          .then(function () { toast('تم حفظ رسوم ' + groupDef.label, 'success'); loadSettings_(content); })
          .catch(function (err) { toast(err.message, 'error'); eduBtn.disabled = false; });
      };

      // Fee schedule — Activity/Bus (single universal row)
      document.getElementById('saveActBusBtn').onclick = function () {
        var feeType = document.getElementById('actBusType').value;
        var amount = document.getElementById('actBusAmount').value;
        if (amount === '') { toast('أدخل المبلغ', 'error'); return; }
        var actBusBtn = document.getElementById('saveActBusBtn');
        actBusBtn.disabled = true;
        apiCall('upsertFeeSchedule', { academicYear: STATE.academicYear, stage: '', department: '', feeType: feeType, amount: amount })
          .then(function () { toast('تم حفظ رسوم ' + feeType, 'success'); loadSettings_(content); })
          .catch(function (err) { toast(err.message, 'error'); actBusBtn.disabled = false; });
      };

      // مواد إضافية — American only, not a Collection Type; blocked server-side if department != AM.
      document.getElementById('saveMaterialsBtn').onclick = function () {
        var amount = document.getElementById('materialsAmount').value;
        if (amount === '') { toast('أدخل المبلغ', 'error'); return; }
        var materialsBtn = document.getElementById('saveMaterialsBtn');
        materialsBtn.disabled = true;
        apiCall('upsertFeeSchedule', { academicYear: STATE.academicYear, stage: '', department: 'AM', feeType: 'مواد إضافية', amount: amount })
          .then(function () { toast('تم حفظ مواد إضافية', 'success'); loadSettings_(content); })
          .catch(function (err) { toast(err.message, 'error'); materialsBtn.disabled = false; });
      };

      // Fee schedule — Advanced/Manual (raw entry, unchanged from before)
      document.getElementById('addScheduleBtn').onclick = function () {
        var payload = {
          academicYear: STATE.academicYear, stage: document.getElementById('fsStage').value.trim(),
          department: document.getElementById('fsDept').value.trim(), feeType: document.getElementById('fsFeeType').value,
          amount: document.getElementById('fsAmount').value
        };
        if (!payload.stage || !payload.feeType || payload.amount === '') { toast('أكمل المرحلة ونوع الرسوم والمبلغ', 'error'); return; }
        var addSchedBtn = document.getElementById('addScheduleBtn');
        addSchedBtn.disabled = true;
        apiCall('upsertFeeSchedule', payload)
          .then(function () { toast('تم حفظ بند الرسوم', 'success'); loadSettings_(content); })
          .catch(function (err) { toast(err.message, 'error'); addSchedBtn.disabled = false; });
      };
      document.querySelectorAll('.fs-edit').forEach(function (btn) {
        btn.onclick = function () {
          document.getElementById('fsStage').value = btn.getAttribute('data-stage');
          document.getElementById('fsDept').value = btn.getAttribute('data-dept');
          document.getElementById('fsFeeType').value = btn.getAttribute('data-feetype');
          document.getElementById('fsAmount').value = btn.getAttribute('data-amount');
          // ROOT CAUSE FIX (Issue 3): these fields live inside a collapsed <details> — a
          // click populated them correctly all along, but the section stayed closed,
          // so nothing visible ever changed. Opening it here is what was missing.
          document.getElementById('advancedFeeScheduleDetails').open = true;
          document.getElementById('fsStage').scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
      });
      document.querySelectorAll('.fs-delete').forEach(function (btn) {
        btn.onclick = function () {
          var stage = btn.getAttribute('data-stage'), dept = btn.getAttribute('data-dept'), feeType = btn.getAttribute('data-feetype');
          var label = (stage || 'الكل') + ' / ' + (dept || 'الكل') + ' / ' + feeType;
          if (!confirm('هل تريد حذف بند الرسوم: ' + label + '؟')) return;
          btn.disabled = true;
          apiCall('deleteFeeSchedule', { academicYear: STATE.academicYear, stage: stage, department: dept, feeType: feeType })
            .then(function () { toast('تم حذف البند', 'success'); loadSettings_(content); })
            .catch(function (err) { toast(err.message, 'error'); btn.disabled = false; });
        };
      });

      document.getElementById('setPrintBtn').onclick = function () { printReport_('الإعدادات', getScreenPrintableContent_()); };
      document.getElementById('setPdfBtn').onclick = function () { exportPdf_('الإعدادات', getScreenPrintableContent_(), document.getElementById('setPdfBtn')); };
      // Settings data is already fully loaded client-side (one Promise.all on screen entry) —
      // SheetJS builds the .xlsx directly from what's already in memory, zero extra API calls.
      document.getElementById('setExcelBtn').onclick = function () {
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(years.map(function (y) { return { 'السنة': y.Key, 'البداية': y.From, 'النهاية': y.To }; })), 'السنوات الدراسية');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(installments.map(function (i) { return { 'رقم القسط': i.InstallmentNo, 'الاسم': i.Label, 'من': i.StartDate, 'إلى': i.EndDate }; })), 'الأقساط');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rules.map(function (r) { return { 'نوع الرسوم': r.feeType, 'القسط 1 %': r.percent1, 'القسط 2 %': r.percent2, 'القسط 3 %': r.percent3 }; })), 'قواعد السداد');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(schedule.map(function (f) { return { 'المرحلة': f.Stage || 'الكل', 'القسم': f.Department || 'الكل', 'نوع الرسوم': f.FeeType, 'المبلغ': f.Amount }; })), 'لائحة الرسوم');
        XLSX.writeFile(wb, 'الإعدادات - ' + STATE.academicYear + '.xlsx');
      };
    })
    .catch(function (err) { document.getElementById('setBody').innerHTML = errorBox(err.message, function () { loadSettings_(content); }); });
}

function ruleRow_(feeType, existing) {
  var id = 'rule_' + feeType.replace(/[^A-Za-z0-9\u0600-\u06FF]/g, '_');
  var p1 = existing ? existing.percent1 : '';
  var p2 = existing ? existing.percent2 : '';
  var p3 = existing ? existing.percent3 : '';
  var warn = !existing ? '<div style="font-size:11px;color:var(--warning);">غير مُعدّة — التحصيل لهذا النوع سيُرفض حتى تُدخل النسب</div>' : '';
  return '<tr data-feetype="' + escapeHtml(feeType) + '"><td>' + escapeHtml(feeType) + warn + '</td>' +
    '<td><input type="number" min="0" max="100" class="' + id + '_p1" style="width:70px;" value="' + p1 + '"></td>' +
    '<td><input type="number" min="0" max="100" class="' + id + '_p2" style="width:70px;" value="' + p2 + '"></td>' +
    '<td><input type="number" min="0" max="100" class="' + id + '_p3" style="width:70px;" value="' + p3 + '"></td>' +
    '<td><button class="btn btn-secondary btn-sm rule-save" data-feetype="' + escapeHtml(feeType) + '" data-id="' + id + '">حفظ</button></td></tr>';
}

/** Percentages come straight from the getPaymentRules read (fetched once when Settings opens) — never pre-filled with invented numbers, only real stored values or blank. */
function bindRuleSaveButtons_() {
  document.querySelectorAll('.rule-save').forEach(function (btn) {
    btn.onclick = function () {
      var id = btn.getAttribute('data-id'), feeType = btn.getAttribute('data-feetype');
      var p1 = document.querySelector('.' + id + '_p1').value || 0;
      var p2 = document.querySelector('.' + id + '_p2').value || 0;
      var p3 = document.querySelector('.' + id + '_p3').value || 0;
      apiCall('upsertPaymentRule', { academicYear: STATE.academicYear, feeType: feeType, percent1: p1, percent2: p2, percent3: p3 })
        .then(function () { toast('تم حفظ قاعدة السداد لـ ' + feeType, 'success'); })
        .catch(function (err) { toast(err.message, 'error'); });
    };
  });
}

function feeScheduleRow_(f) {
  return '<tr><td>' + escapeHtml(f.Stage || 'الكل') + '</td><td>' + escapeHtml(f.Department || 'الكل') + '</td><td>' + escapeHtml(f.FeeType) +
    '</td><td class="num">' + fmtNum(f.Amount) + '</td><td style="display:flex;gap:6px;"><button class="btn btn-secondary btn-sm fs-edit" ' +
    'data-stage="' + escapeHtml(f.Stage) + '" data-dept="' + escapeHtml(f.Department || '') + '" data-feetype="' + escapeHtml(f.FeeType) + '" data-amount="' + escapeHtml(f.Amount) + '">تعديل</button>' +
    '<button class="btn btn-danger btn-sm fs-delete" data-stage="' + escapeHtml(f.Stage) + '" data-dept="' + escapeHtml(f.Department || '') +
    '" data-feetype="' + escapeHtml(f.FeeType) + '">حذف</button></td></tr>';
}

/* ============================ Users (Administrator only) ============================ */
function renderUsers(content) {
  content.innerHTML = '<div class="panel"><div class="panel-header"><h3>المستخدمون</h3><div>' + exportToolbarHtml_('usr') + '</div></div><div class="panel-body" id="usersBody">' + loadingBox() + '</div></div>';
  loadUsers_(content);
}
function loadUsers_(content) {
  apiCall('listUsers', {})
    .then(function (users) {
      document.getElementById('usersBody').innerHTML =
        '<div class="table-wrap"><table><thead><tr><th>اسم المستخدم</th><th>الاسم</th><th>الدور</th><th>الحالة</th><th></th></tr></thead><tbody>' +
        users.map(function (u) {
          var toggleLabel = u.status === 'Active' ? 'تعطيل' : 'تفعيل';
          return '<tr><td>' + escapeHtml(u.username) + '</td><td>' + escapeHtml(u.displayName) + '</td><td>' + escapeHtml(u.role) +
            '</td><td>' + (u.status === 'Active' ? '<span class="badge badge-green">نشط</span>' : '<span class="badge badge-red">معطل</span>') + '</td>' +
            '<td style="display:flex;gap:6px;">' +
            '<button class="btn btn-secondary btn-sm user-toggle" data-username="' + escapeHtml(u.username) + '" data-active="' + (u.status === 'Active') + '">' + toggleLabel + '</button>' +
            '<button class="btn btn-secondary btn-sm user-reset" data-username="' + escapeHtml(u.username) + '">إعادة تعيين كلمة المرور</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<h4 style="margin-top:18px;">إضافة مستخدم جديد</h4>' +
        '<div class="form-grid">' +
        field('اسم المستخدم', '<input id="nuUsername">') +
        field('الاسم المعروض', '<input id="nuDisplayName">') +
        field('كلمة المرور (6 أحرف على الأقل)', '<input type="password" id="nuPassword">') +
        field('الدور', selectHtml('nuRole', ['Administrator', 'Collection User', 'Reports User'])) +
        '<div class="field"><label>&nbsp;</label><button class="btn btn-primary btn-sm" id="addUserBtn">إنشاء مستخدم</button></div>' +
        '</div>';
      document.getElementById('usrPrintBtn').onclick = function () { printReport_('المستخدمون', getScreenPrintableContent_()); };
      document.getElementById('usrPdfBtn').onclick = function () { exportPdf_('المستخدمون', getScreenPrintableContent_(), document.getElementById('usrPdfBtn')); };

      document.querySelectorAll('.user-toggle').forEach(function (btn) {
        btn.onclick = function () {
          var username = btn.getAttribute('data-username');
          var currentlyActive = btn.getAttribute('data-active') === 'true';
          apiCall('setUserActive', { username: username, active: !currentlyActive })
            .then(function () { toast('تم تحديث حالة المستخدم', 'success'); loadUsers_(content); })
            .catch(function (err) { toast(err.message, 'error'); });
        };
      });
      document.querySelectorAll('.user-reset').forEach(function (btn) {
        btn.onclick = function () {
          var username = btn.getAttribute('data-username');
          var np = prompt('كلمة المرور الجديدة لـ ' + username + ' (6 أحرف على الأقل):');
          if (!np) return;
          apiCall('resetPassword', { username: username, newPassword: np })
            .then(function () { toast('تم تغيير كلمة المرور', 'success'); })
            .catch(function (err) { toast(err.message, 'error'); });
        };
      });
      document.getElementById('addUserBtn').onclick = function () {
        var payload = {
          username: document.getElementById('nuUsername').value.trim(),
          displayName: document.getElementById('nuDisplayName').value.trim(),
          password: document.getElementById('nuPassword').value,
          role: document.getElementById('nuRole').value
        };
        apiCall('createUser', payload)
          .then(function () { toast('تم إنشاء المستخدم', 'success'); loadUsers_(content); })
          .catch(function (err) { toast(err.message, 'error'); });
      };
    })
    .catch(function (err) { document.getElementById('usersBody').innerHTML = errorBox(err.message, function () { loadUsers_(content); }); });
}

/* ============================ Receipt (always English, even in an Arabic UI) ============================ */
var SCHOOL_NAME = 'SCHOOL NAME'; // change in JavaScript.html to your school's name

function openReceipt_(receiptNumber) {
  apiCall('getReceipt', { receiptNumber: receiptNumber })
    .then(function (data) { showReceiptModal_(data); })
    .catch(function (err) { toast(err.message, 'error'); });
}
function showReceiptModal_(data) {
  var backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML =
    '<div class="modal">' +
    '<div class="modal-header"><h3>Receipt</h3><button class="close-x">&times;</button></div>' +
    '<div class="modal-body" id="receiptPrintArea">' + receiptHtml_(data) + '</div>' +
    '<div class="modal-footer"><button class="btn btn-secondary" id="closeReceiptBtn">Close</button><button class="btn btn-primary" id="printReceiptBtn">&#128220; Print</button></div>' +
    '</div>';
  document.body.appendChild(backdrop);
  backdrop.querySelector('.close-x').onclick = function () { backdrop.remove(); };
  document.getElementById('closeReceiptBtn').onclick = function () { backdrop.remove(); };
  document.getElementById('printReceiptBtn').onclick = function () { printReceipt_(data); };
}
function fmtDateEn_(d) {
  var dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
/**
 * Renders the receipt exactly per spec: SCHOOL NAME / PAYMENT RECEIPT header,
 * student block, a Fee Type / Installment / Amount line per item (re-uses the
 * stored transaction values — never recalculated), then Original Due /
 * Allowed Discount / Net Due / Amount Paid totals, Payment Method, Collected By.
 * Re-printing always reads back the same stored PAYMENTS rows — nothing here
 * is recomputed differently than when the payment was first saved.
 */
function receiptHtml_(data) {
  var s = data.student, t = data.totals;
  var linesRows = data.lines.map(function (l) {
    var cancelledTag = l.Status === 'Cancelled' ? ' (CANCELLED)' : '';
    return '<tr><td>' + escapeHtml(l.FeeType) + cancelledTag + '</td><td>' + escapeHtml(installmentDisplay_(l)) + '</td><td>' + escapeHtml(l.PaymentType || '') + '</td><td style="text-align:left;">' + fmtNum(l.AmountPaid) + '</td></tr>';
  }).join('');
  return '' +
    '<div style="font-family:\'Courier New\',monospace;font-size:13px;line-height:1.5;direction:ltr;text-align:left;">' +
    '<div style="text-align:center;font-weight:700;">' + escapeHtml(SCHOOL_NAME) + '<br>PAYMENT RECEIPT</div>' +
    '<div style="margin-top:10px;">Receipt No.&nbsp;&nbsp;&nbsp;: ' + escapeHtml(data.receiptNumber) + '<br>' +
    'Payment Date&nbsp;&nbsp;: ' + fmtDateEn_(data.paymentDate) + '</div>' +
    '<div style="margin-top:10px;">Student Name&nbsp;&nbsp;: ' + escapeHtml(s.StudentName) + '<br>' +
    'Student Code&nbsp;&nbsp;: ' + escapeHtml(s.StudentCode) + '<br>' +
    'Stage&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: ' + escapeHtml(s.Stage) + '<br>' +
    'Class&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: ' + escapeHtml(s.ClassName) + '<br>' +
    'Department&nbsp;&nbsp;&nbsp;: ' + escapeHtml(s.Department || '-') + '</div>' +
    '<div style="border-top:1px dashed #000;margin:10px 0;"></div>' +
    '<table style="width:100%;border-collapse:collapse;"><thead><tr>' +
    '<th style="text-align:left;">Fee Type</th><th style="text-align:left;">Installment</th><th style="text-align:left;">Payment Type</th><th style="text-align:left;">Amount</th></tr></thead>' +
    '<tbody>' + linesRows + '</tbody></table>' +
    '<div style="border-top:1px dashed #000;margin:10px 0;"></div>' +
    '<div>Original Due' + pad_() + fmtNum(t.originalDue) + '<br>' +
    'Allowed Discount' + pad_() + fmtNum(t.discount) + '<br>' +
    'Net Due' + pad_() + fmtNum(t.netDue) + '<br>' +
    '<b>Amount Paid' + pad_() + fmtNum(t.amountPaid) + '</b></div>' +
    '<div style="margin-top:10px;">Payment Method' + pad_() + escapeHtml(data.paymentMethod) + '</div>' +
    (data.notes ? '<div style="margin-top:6px;">Notes: ' + escapeHtml(data.notes) + '</div>' : '') +
    '<div style="margin-top:10px;">Collected By' + pad_() + escapeHtml(data.createdBy) + '</div>' +
    '<div style="border-top:1px dashed #000;margin:10px 0;"></div>' +
    (data.anyCancelled ? '<div style="color:#dc2626;font-weight:700;">NOTE: one or more lines on this receipt were cancelled — see Payments for status.</div>' : '') +
    '<div style="text-align:center;margin-top:10px;">Thank you</div>' +
    '</div>';
}
function pad_() { return '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: '; }
function printReceipt_(data) {
  var w = window.open('', '_blank', 'width=420,height=650');
  w.document.write('<html dir="ltr"><head><title>Receipt ' + escapeHtml(data.receiptNumber) + '</title>' +
    '<style>body{padding:20px;}table{width:100%;}</style></head><body>' + receiptHtml_(data) + '</body></html>');
  w.document.close();
  w.focus();
  setTimeout(function () { w.print(); }, 300);
}

/* ============================ Receipt search (item 11: by no. / code / name) ============================ */
function renderReceiptSearch(content) {
  content.innerHTML =
    '<div class="panel"><div class="panel-header"><h3>بحث عن إيصال</h3>' +
    '<div>' + exportToolbarHtml_('rs') + '<button class="btn btn-secondary" id="rsExcelBtn">&#128202; Excel</button></div></div>' +
    '<div class="panel-body">' +
    // Both searches side by side on desktop; flex-wrap drops the second group to its own row only when space runs out.
    '<div style="display:flex;flex-wrap:wrap;gap:10px 28px;align-items:flex-end;">' +
    '<div class="filters-row">' + field('رقم الإيصال', '<input id="rsReceiptNo" class="search-box" placeholder="مثال: RCPT-1234ABCD">') +
    '<button class="btn btn-primary" id="rsReceiptBtn">بحث</button></div>' +
    '<div class="filters-row">' + field('كود الطالب / اسم الطالب', '<input id="rsStudent" class="search-box" placeholder="الكود أو الاسم">') +
    '<button class="btn btn-primary" id="rsStudentBtn">بحث</button></div>' +
    '</div>' +
    '</div>' +
    '<div class="panel-body" id="rsBody" style="padding:0;"></div></div>';
  var lastQuery = '', lastResults = [];

  function showResults(list) {
    lastResults = list;
    var body = document.getElementById('rsBody');
    if (!list.length) { body.innerHTML = '<div class="state-box">لا توجد نتائج</div>'; return; }
    body.innerHTML = '<div class="table-wrap"><table><thead><tr><th>رقم الإيصال</th><th>كود الطالب</th><th>اسم الطالب</th><th>التاريخ</th><th>الإجمالي</th><th></th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td>' + escapeHtml(r.receiptNumber) + '</td><td>' + escapeHtml(r.studentCode) + '</td><td>' + escapeHtml(r.studentName) +
          '</td><td>' + escapeHtml(String(r.paymentDate).substring(0, 10)) + '</td><td class="num">' + fmtNum(r.amountPaid) +
          '</td><td><button class="btn btn-secondary btn-sm" onclick="openReceipt_(\'' + r.receiptNumber + '\')">عرض</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // Receipt Number ONLY — existing getReceipt action (exact receipt number), one request, never interpreted as a student.
  function runReceipt() {
    var q = document.getElementById('rsReceiptNo').value.trim();
    if (!q) { toast('أدخل رقم الإيصال', 'error'); return; }
    lastQuery = q;
    document.getElementById('rsBody').innerHTML = loadingBox();
    apiCall('getReceipt', { receiptNumber: q })
      .then(function (d) {
        showResults([{ receiptNumber: d.receiptNumber, studentCode: d.student.StudentCode, studentName: d.student.StudentName, paymentDate: d.paymentDate, amountPaid: d.totals.amountPaid }]);
      })
      .catch(function (err) {
        if (err.code === 'NOT_FOUND') { showResults([]); return; }
        document.getElementById('rsBody').innerHTML = errorBox(err.message, runReceipt);
      });
  }

  // Student Code / Name ONLY — existing searchReceipts action (one request); rows that matched only
  // by receipt number are dropped, so the student box never behaves as a receipt-number search.
  function runStudent() {
    var q = document.getElementById('rsStudent').value.trim();
    if (!q) { toast('أدخل كود الطالب أو اسمه', 'error'); return; }
    lastQuery = q;
    var ql = q.toLowerCase();
    document.getElementById('rsBody').innerHTML = loadingBox();
    apiCall('searchReceipts', { query: q, academicYear: STATE.academicYear })
      .then(function (list) {
        showResults(list.filter(function (r) {
          return String(r.studentCode).toLowerCase().indexOf(ql) !== -1 || String(r.studentName || '').toLowerCase().indexOf(ql) !== -1;
        }));
      })
      .catch(function (err) { document.getElementById('rsBody').innerHTML = errorBox(err.message, runStudent); });
  }

  document.getElementById('rsReceiptBtn').onclick = runReceipt;
  document.getElementById('rsStudentBtn').onclick = runStudent;
  document.getElementById('rsReceiptNo').addEventListener('keydown', function (e) { if (e.key === 'Enter') runReceipt(); });
  document.getElementById('rsStudent').addEventListener('keydown', function (e) { if (e.key === 'Enter') runStudent(); });
  document.getElementById('rsPrintBtn').onclick = function () {
    if (!lastResults.length) { toast('ابحث أولًا', 'error'); return; }
    printReport_('نتائج البحث عن إيصال — ' + lastQuery, getScreenPrintableContent_());
  };
  document.getElementById('rsPdfBtn').onclick = function () {
    if (!lastResults.length) { toast('ابحث أولًا', 'error'); return; }
    exportPdf_('نتائج البحث عن إيصال — ' + lastQuery, getScreenPrintableContent_(), document.getElementById('rsPdfBtn'));
  };
  document.getElementById('rsExcelBtn').onclick = function () {
    if (!lastResults.length) { toast('ابحث أولًا', 'error'); return; }
    var sheet = XLSX.utils.json_to_sheet(lastResults.map(function (r) {
      return { 'رقم الإيصال': r.receiptNumber, 'كود الطالب': r.studentCode, 'اسم الطالب': r.studentName, 'التاريخ': String(r.paymentDate).substring(0, 10), 'الإجمالي': r.amountPaid };
    }));
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'نتائج البحث');
    XLSX.writeFile(wb, 'بحث إيصال - ' + lastQuery + '.xlsx');
  };
}

/* ============================ Print / PDF (generic, reusable) ============================ */
/**
 * Shared wrapper: title + academic year + generation date + body HTML,
 * used by BOTH Print and PDF so the two always show identical content.
 * The existing receiptHtml_()/printReceipt_() are untouched and unrelated —
 * receipts keep their own dedicated English-only format exactly as before.
 */
function buildPrintableHtml_(title, bodyHtml) {
  var now = new Date();
  return '' +
    '<div style="font-family:Tahoma,Arial,sans-serif;direction:rtl;text-align:right;padding:16px;color:#111;">' +
    '<h2 style="margin:0 0 4px;">' + escapeHtml(title) + '</h2>' +
    '<div style="font-size:12.5px;color:#555;margin-bottom:14px;">' +
    'العام الدراسي: ' + escapeHtml(STATE.academicYear) + ' &nbsp;|&nbsp; تاريخ الإصدار: ' + now.toLocaleString('en-GB') +
    '</div>' + bodyHtml + '</div>';
}

/**
 * Removes/converts interactive controls so only meaningful report content
 * prints: buttons are dropped (except a receipt-number button, which becomes
 * plain text — same value, just not clickable, per spec); form controls
 * inside a table (e.g. Settings' editable percentage cells) become plain
 * text showing their current value (real data, must not vanish); form
 * controls outside a table (search boxes, filter inputs, "add new" forms)
 * are removed entirely — they are input tools, not report content.
 */
function sanitizeForPrint_(container) {
  container.querySelectorAll('button').forEach(function (btn) {
    var onclick = btn.getAttribute('onclick') || '';
    if (onclick.indexOf('openReceipt_') !== -1) {
      var span = document.createElement('span');
      span.textContent = btn.textContent;
      btn.replaceWith(span);
    } else {
      btn.remove();
    }
  });
  container.querySelectorAll('table input, table select').forEach(function (el) {
    var span = document.createElement('span');
    span.textContent = el.tagName === 'SELECT' ? (el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value) : el.value;
    el.replaceWith(span);
  });
  container.querySelectorAll('input, select, textarea').forEach(function (el) {
    var field = el.closest('.field');
    if (field) field.remove(); else el.remove();
  });
  container.querySelectorAll('.filters-row, .pagination').forEach(function (el) { el.remove(); });
  container.querySelectorAll('details').forEach(function (d) { if (!d.querySelector('table, .cards-row')) d.remove(); });
  return container;
}

/** Clones the current screen's panels and sanitizes them — the generic "meaningful content" source for most screens. */
function getScreenPrintableContent_() {
  var wrap = document.createElement('div');
  document.querySelectorAll('#content .panel').forEach(function (p) { wrap.appendChild(p.cloneNode(true)); });
  sanitizeForPrint_(wrap);
  return wrap.innerHTML;
}

/** Opens a temporary print window with the given title/body, prints, and closes — never touches the live screen DOM. */
function printReport_(title, bodyHtml) {
  var w = window.open('', '_blank', 'width=900,height=700');
  w.document.write('<html dir="rtl"><head><title>' + escapeHtml(title) + '</title>' +
    '<style>body{margin:0;}table{width:100%;border-collapse:collapse;font-size:12.5px;}th,td{border:1px solid #ccc;padding:6px 8px;text-align:right;}th{background:#f3f4f6;}</style>' +
    '</head><body>' + buildPrintableHtml_(title, bodyHtml) + '</body></html>');
  w.document.close();
  w.focus();
  setTimeout(function () { w.print(); }, 300);
}

/**
 * Real PDF via html2canvas (rasterizes the correctly-RTL-rendered HTML) + jsPDF
 * (embeds that image into an actual PDF page, splitting across pages if tall).
 * The temporary container is rendered off-screen and removed immediately after
 * capture — the live screen DOM is never modified.
 */
function exportPdf_(title, bodyHtml, btnEl) {
  if (typeof html2canvas === 'undefined' || typeof jspdf === 'undefined') {
    toast('تعذر تحميل مكتبة PDF — تحقق من الاتصال بالإنترنت وأعد المحاولة', 'error');
    return;
  }
  var originalText = btnEl ? btnEl.textContent : null;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'جارٍ إنشاء PDF...'; }

  var holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;top:0;left:-99999px;width:800px;background:#fff;';
  holder.innerHTML = buildPrintableHtml_(title, bodyHtml);
  document.body.appendChild(holder);

  html2canvas(holder, { scale: 2, backgroundColor: '#ffffff' })
    .then(function (canvas) {
      document.body.removeChild(holder);
      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      var pageWidth = pdf.internal.pageSize.getWidth();
      var pageHeight = pdf.internal.pageSize.getHeight();
      var imgWidth = pageWidth;
      var imgHeight = (canvas.height * imgWidth) / canvas.width;
      var imgData = canvas.toDataURL('image/png');

      if (imgHeight <= pageHeight) {
        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
      } else {
        // Split the tall image across multiple A4 pages.
        var remaining = imgHeight, position = 0;
        while (remaining > 0) {
          pdf.addImage(imgData, 'PNG', 0, position === 0 ? 0 : -(imgHeight - remaining), imgWidth, imgHeight);
          remaining -= pageHeight;
          if (remaining > 0) pdf.addPage();
          position += pageHeight;
        }
      }
      pdf.save(title.replace(/[^A-Za-z0-9\u0600-\u06FF _-]/g, '') + '.pdf');
    })
    .catch(function () { document.body.removeChild(holder); toast('تعذر إنشاء PDF', 'error'); })
    .finally(function () { if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalText; } });
}

/**
 * Standard 3-button toolbar. printFn/pdfFn are called with no args and must
 * read the current screen content themselves (so the toolbar HTML stays the
 * same everywhere); excelReport (an exportExcel_ report key) is optional —
 * omit it for screens with no meaningful tabular dataset (e.g. Dashboard,
 * Collect Payment), per spec — never invents Excel content.
 */
function exportToolbarHtml_(idPrefix) {
  return '<button class="btn btn-secondary btn-sm" id="' + idPrefix + 'PrintBtn">&#128424; طباعة</button>' +
    '<button class="btn btn-secondary btn-sm" id="' + idPrefix + 'PdfBtn">&#128196; PDF</button>';
}
function bindExportToolbar_(idPrefix, title, getBodyHtml, excelReport, excelFilters) {
  document.getElementById(idPrefix + 'PrintBtn').onclick = function () { printReport_(title, getBodyHtml()); };
  document.getElementById(idPrefix + 'PdfBtn').onclick = function () { exportPdf_(title, getBodyHtml(), document.getElementById(idPrefix + 'PdfBtn')); };
  if (excelReport) {
    var excelBtn = document.getElementById(idPrefix + 'ExcelBtn');
    if (excelBtn) excelBtn.onclick = function () { exportExcel_(excelReport, excelFilters(), title, excelBtn); };
  }
}

/**
 * Real .xlsx export: server builds the file (Excel.gs, using native
 * SpreadsheetApp/DriveApp — no client-side library) from the FULL filtered
 * result set (never just the current page), returns it as base64, and the
 * browser decodes + downloads it. Replaces the earlier CSV-only export.
 */
function exportExcel_(report, filters, label, btnEl) {
  var originalText = btnEl ? btnEl.textContent : null;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'جارٍ التصدير...'; }
  apiCall('exportExcel', { report: report, filters: filters })
    .then(function (result) {
      var byteChars = atob(result.base64);
      var byteNumbers = new Array(byteChars.length);
      for (var i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      var blob = new Blob([new Uint8Array(byteNumbers)], { type: result.mimeType });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('تم تصدير ' + label, 'success');
    })
    .catch(function (err) { toast(err.message, 'error'); })
    .finally(function () { if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalText; } });
}

/* ============================ Student Import (Excel/CSV) ============================ */
// Uses SheetJS (loaded in index.html) to parse .xlsx/.csv entirely client-side — no
// per-row server call. The parsed rows are sent to the server ONCE for preview, and
// ONCE again (only if the admin confirms) to actually write — both as a single batch
// call each, never a loop of API calls. Student Master only; never touches Payments/
// Receipts/Revenue/FeeSchedule/PaymentRules (enforced server-side in Students.gs).
var importParsedRows_ = null;

function openStudentImportModal_(content, currentPage) {
  var backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML =
    '<div class="modal">' +
    '<div class="modal-header"><h3>استيراد الطلاب</h3><button class="close-x">&times;</button></div>' +
    '<div class="modal-body">' +
    '<p style="font-size:13px;color:var(--text-muted);">ملف Excel (.xlsx) أو CSV بالأعمدة: Student Code, Student Name, Stage, Class Name, Department, Active. ' +
    'الاستيراد يخص السنة الدراسية الحالية (' + escapeHtml(STATE.academicYear) + ') فقط. لن يتم حذف أي طالب، ولن تتأثر أي بيانات مدفوعات أو رسوم.</p>' +
    '<input type="file" id="importFileInput" accept=".xlsx,.xls,.csv">' +
    '<div id="importStatus" style="margin-top:10px;font-size:13px;"></div>' +
    '<div id="importPreview"></div>' +
    '</div>' +
    '<div class="modal-footer">' +
    '<button class="btn btn-secondary" id="importCloseBtn">إغلاق</button>' +
    '<button class="btn btn-primary" id="importConfirmBtn" disabled>&#128190; اعتماد واستيراد</button>' +
    '</div></div>';
  document.body.appendChild(backdrop);
  importParsedRows_ = null;

  function close() { backdrop.remove(); importParsedRows_ = null; }
  backdrop.querySelector('.close-x').onclick = close;
  document.getElementById('importCloseBtn').onclick = close;

  document.getElementById('importFileInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var status = document.getElementById('importStatus');
    var preview = document.getElementById('importPreview');
    var confirmBtn = document.getElementById('importConfirmBtn');
    confirmBtn.disabled = true;
    preview.innerHTML = '';
    status.textContent = 'جارٍ قراءة الملف...';

    var reader = new FileReader();
    var isCsv = /\.csv$/i.test(file.name);
    reader.onload = function (evt) {
      var rows;
      try {
        var wb = isCsv ? XLSX.read(evt.target.result, { type: 'string' }) : XLSX.read(evt.target.result, { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      } catch (err) {
        status.innerHTML = '<span class="error-box">تعذر قراءة الملف — تأكد أنه Excel أو CSV صحيح.</span>';
        return;
      }
      if (!rows.length) { status.innerHTML = '<span class="error-box">الملف لا يحتوي على بيانات.</span>'; return; }

      status.textContent = 'جارٍ التحليل والمعاينة...';
      apiCall('previewStudentImport', { rows: rows, academicYear: STATE.academicYear })
        .then(function (summary) {
          importParsedRows_ = rows;
          status.textContent = '';
          preview.innerHTML = importSummaryHtml_(summary);
          confirmBtn.disabled = summary.newCount + summary.updateCount === 0;
        })
        .catch(function (err) { status.innerHTML = '<span class="error-box">' + escapeHtml(err.message) + '</span>'; });
    };
    reader.onerror = function () { status.innerHTML = '<span class="error-box">تعذر قراءة الملف.</span>'; };
    if (isCsv) reader.readAsText(file, 'utf-8'); else reader.readAsArrayBuffer(file);
  });

  document.getElementById('importConfirmBtn').onclick = function () {
    if (!importParsedRows_) return;
    var btn = document.getElementById('importConfirmBtn');
    var status = document.getElementById('importStatus');
    btn.disabled = true;
    status.textContent = 'جارٍ الحفظ...';
    apiCall('applyStudentImport', { rows: importParsedRows_, academicYear: STATE.academicYear }, { retries: false })
      .then(function (result) {
        status.innerHTML = '';
        document.getElementById('importPreview').innerHTML = importSummaryHtml_({
          newCount: result.added, updateCount: result.updated, noChangeCount: result.unchanged,
          errorCount: result.errorCount, errors: result.errors, totalRows: result.added + result.updated + result.unchanged + result.errorCount
        }, true);
        toast('تم الاستيراد: ' + result.added + ' جديد، ' + result.updated + ' محدَّث', 'success');
        importParsedRows_ = null;
        renderStudents(content, currentPage); // refresh the list underneath; modal stays open so the admin can read the summary
      })
      .catch(function (err) { status.innerHTML = ''; toast(err.message, 'error'); btn.disabled = false; });
  };
}

function importSummaryHtml_(s, isFinal) {
  var errorsHtml = '';
  if (s.errorCount > 0) {
    errorsHtml = '<div style="margin-top:10px;max-height:160px;overflow-y:auto;">' +
      '<table style="width:100%;font-size:12.5px;"><thead><tr><th style="text-align:right;">صف</th><th style="text-align:right;">كود الطالب</th><th style="text-align:right;">السبب</th></tr></thead><tbody>' +
      (s.errors || []).map(function (e) { return '<tr><td>' + e.row + '</td><td>' + escapeHtml(e.studentCode) + '</td><td>' + escapeHtml(e.reason) + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  return '<div class="cards-row" style="margin-top:14px;">' +
    statCard('إجمالي الصفوف', fmtNum(s.totalRows), '') +
    statCard('طلاب جدد', fmtNum(s.newCount), 'accent-green') +
    statCard('سيتم تحديثهم', fmtNum(s.updateCount), 'accent-blue') +
    statCard('بدون تغيير', fmtNum(s.noChangeCount), '') +
    statCard('أخطاء', fmtNum(s.errorCount), s.errorCount > 0 ? 'accent-red' : '') +
    '</div>' +
    (isFinal ? '<p style="color:var(--success);font-weight:600;">تم اعتماد الاستيراد.</p>' : '') +
    errorsHtml;
}

/* ============================ Modals: ESC / click outside ============================ */
/**
 * Registered ONCE at load (event delegation on document) — no per-modal or
 * per-render handlers, so nothing can stack. Closing always triggers the
 * modal's own existing X button, so each modal keeps its own close logic
 * (e.g. the Import modal resets its state). Applies to .modal-backdrop
 * overlays only — clicks on normal module pages are never affected.
 */
function closeTopModal_() {
  var backdrops = document.querySelectorAll('.modal-backdrop');
  if (!backdrops.length) return;
  var top = backdrops[backdrops.length - 1];
  var x = top.querySelector('.close-x');
  if (x) x.click(); else top.remove();
}
var modalPressTarget_ = null;
document.addEventListener('mousedown', function (e) { modalPressTarget_ = e.target; });
document.addEventListener('click', function (e) {
  // Only a click that both started AND ended on the backdrop itself (outside .modal) closes —
  // a text-selection drag that starts inside the modal and ends outside does not.
  if (e.target.classList && e.target.classList.contains('modal-backdrop') && modalPressTarget_ === e.target) closeTopModal_();
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeTopModal_(); });

/* ============================ Boot ============================ */
document.addEventListener('DOMContentLoaded', function () {
  // getDashboardSummary's own SESSION_EXPIRED handling already triggers doLogout(true) —
  // a separate ping pre-check was a redundant extra round-trip before first render.
  renderApp();
});
