// Auto-backup test comment
export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() })
    }

    if (url.pathname === '/api/tables') {
      return listTables(env)
    }

    if (url.pathname === '/api/rows') {
      return listRows(request, env)
    }

    if (url.pathname === '/api/latest-metrics') {
      return getLatestMetrics(request, env)
    }

    if (url.pathname === '/api/metric-history') {
      return getMetricHistory(request, env)
    }

    if (url.pathname === '/api/available-dates') {
      return getAvailableDates(env)
    }

    return new Response(renderHtml(), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  },
}

const DEFAULT_TABLE = 'daily_metrics'
const TABLE_ORDER = [DEFAULT_TABLE, 'market_summary']

const TABLES = {
  daily_metrics: {
    label: 'daily_metrics',
    columns: ['metric_key', 'ticker', 'value', 'date', 'uploaded_at'],
    orderBy: '"date" DESC, "metric_key" ASC',
  },
  market_summary: {
    label: 'market_summary',
    columns: ['summary_date', 'macro_issues', 'stock_issues', 'created_at'],
    orderBy: '"summary_date" DESC',
  },
}

async function listTables(env) {
  if (!env.DB) return dbBindingError()

  return jsonResponse({
    defaultTable: DEFAULT_TABLE,
    tables: TABLE_ORDER.filter((table) => TABLES[table]),
  })
}

async function listRows(request, env) {
  if (!env.DB) return dbBindingError()

  const url = new URL(request.url)
  const table = url.searchParams.get('table')
  const limit = clampNumber(url.searchParams.get('limit'), 1, 100, 50)
  const offset = clampNumber(url.searchParams.get('offset'), 0, 1000000, 0)

  if (!table) {
    return jsonResponse({ error: 'table parameter is required.' }, 400)
  }

  try {
    const tableConfig = TABLES[table]

    if (!tableConfig) {
      return jsonResponse({ error: 'Table not found.' }, 404)
    }

    const safeTable = quoteIdentifier(table)
    const selectedColumns = tableConfig.columns.map(quoteIdentifier).join(', ')
    const [countResult, rowsResult] = await env.DB.batch([
      env.DB.prepare(`SELECT COUNT(*) AS total FROM ${safeTable}`),
      env.DB
        .prepare(
          `SELECT ${selectedColumns} FROM ${safeTable} ORDER BY ${tableConfig.orderBy} LIMIT ? OFFSET ?`,
        )
        .bind(limit, offset),
    ])

    return jsonResponse({
      table,
      columns: tableConfig.columns,
      rows: rowsResult.results,
      total: countResult.results[0]?.total ?? 0,
      limit,
      offset,
    })
  } catch (error) {
    return jsonResponse({ error: error.message }, 500)
  }
}

async function getLatestMetrics(request, env) {
  if (!env.DB) return dbBindingError()

  const url = new URL(request.url)
  let targetDate = url.searchParams.get('date')

  try {
    if (!targetDate) {
      const latestDateQuery = `SELECT MAX(date) as max_date FROM daily_metrics`
      const latestDateResult = await env.DB.prepare(latestDateQuery).first()
      targetDate = latestDateResult ? latestDateResult.max_date : null
    }

    if (!targetDate) {
      return jsonResponse([])
    }

    const query = `
      WITH RankedMetrics AS (
        SELECT 
          metric_key, 
          ticker, 
          value, 
          date,
          ROW_NUMBER() OVER (PARTITION BY metric_key ORDER BY date DESC) as rn
        FROM daily_metrics
        WHERE date <= ?
      )
      SELECT 
        r1.metric_key, 
        r1.ticker, 
        r1.value as latest_value, 
        r1.date as latest_date,
        r2.value as prev_value,
        r2.date as prev_date
      FROM RankedMetrics r1
      LEFT JOIN RankedMetrics r2 ON r1.metric_key = r2.metric_key AND r2.rn = 2
      WHERE r1.rn = 1
      ORDER BY 
        CASE r1.metric_key
          WHEN 'S&P500' THEN 1
          WHEN '코스피' THEN 2
          WHEN 'USD/KRW' THEN 3
          WHEN '달러인덱스' THEN 4
          WHEN 'WTI' THEN 5
          WHEN 'US HY Spread' THEN 6
          ELSE 7
        END, r1.metric_key ASC
    `
    const { results } = await env.DB.prepare(query).bind(targetDate).all()
    
    const formatted = results.map(row => {
      const latest = row.latest_value ?? 0
      const prev = row.prev_value ?? latest
      const change = latest - prev
      const changePercent = prev !== 0 ? (change / prev) * 100 : 0
      
      return {
        metric_key: row.metric_key,
        ticker: row.ticker || '',
        latest_value: latest,
        latest_date: row.latest_date,
        prev_value: prev,
        prev_date: row.prev_date || '',
        change: change,
        change_percent: changePercent
      }
    })

    return jsonResponse(formatted)
  } catch (error) {
    return jsonResponse({ error: error.message }, 500)
  }
}

async function getAvailableDates(env) {
  if (!env.DB) return dbBindingError()

  try {
    const query = `SELECT DISTINCT date FROM daily_metrics ORDER BY date DESC`
    const { results } = await env.DB.prepare(query).all()
    const dates = results.map(row => row.date).filter(Boolean)
    return jsonResponse(dates)
  } catch (error) {
    return jsonResponse({ error: error.message }, 500)
  }
}

async function getMetricHistory(request, env) {
  if (!env.DB) return dbBindingError()

  const url = new URL(request.url)
  const metricKey = url.searchParams.get('metric_key')
  const period = url.searchParams.get('period') || '1Y'

  if (!metricKey) {
    return jsonResponse({ error: 'metric_key parameter is required.' }, 400)
  }

  let sqlitePeriod = '-1 year'
  if (period === '1M') sqlitePeriod = '-1 month'
  else if (period === '3M') sqlitePeriod = '-3 month'
  else if (period === '1Y') sqlitePeriod = '-1 year'
  else if (period === '3Y') sqlitePeriod = '-3 year'

  try {
    const query = `
      SELECT value, date 
      FROM daily_metrics 
      WHERE metric_key = ? 
        AND date >= date((SELECT MAX(date) FROM daily_metrics WHERE metric_key = ?), ?)
      ORDER BY date ASC
    `
    const { results } = await env.DB.prepare(query).bind(metricKey, metricKey, sqlitePeriod).all()
    return jsonResponse(results)
  } catch (error) {
    return jsonResponse({ error: error.message }, 500)
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

function dbBindingError() {
  return jsonResponse(
    {
      error:
        "D1 binding 'DB' is missing. In the Worker settings, add a D1 database binding named DB.",
    },
    500,
  )
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function renderHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Market Monitoring Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg-primary: #0b0f19;
      --bg-secondary: #131a26;
      --bg-card: #151c2c;
      --bg-card-hover: #1e293b;
      --border-color: rgba(255, 255, 255, 0.05);
      --text-primary: #ffffff;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --color-up: #f87171;
      --color-down: #60a5fa;
      --color-accent: #6366f1;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    main {
      flex: 1;
      padding: 32px;
      max-width: 1600px;
      margin: 0 auto;
      width: 100%;
    }

    header {
      margin-bottom: 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .title-area h1 {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.025em;
    }

    .title-area p {
      color: var(--text-secondary);
      font-size: 14px;
      margin-top: 4px;
    }

    .date-picker-container {
      display: flex;
      align-items: center;
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 10px 16px;
      gap: 12px;
      transition: all 0.2s ease;
    }

    .date-picker-container:hover, .date-picker-container:focus-within {
      border-color: var(--color-accent);
      background-color: var(--bg-card-hover);
    }

    .date-picker-container label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      user-select: none;
    }

    .date-input {
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      font-weight: 700;
      outline: none;
      cursor: pointer;
    }

    .date-input::-webkit-calendar-picker-indicator {
      filter: invert(1);
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.2s;
    }

    .date-input::-webkit-calendar-picker-indicator:hover {
      opacity: 1;
    }

    .btn-refresh {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 10px 20px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-refresh:hover {
      background-color: var(--bg-card-hover);
      border-color: var(--color-accent);
    }

    .cards-wrapper {
      margin-bottom: 32px;
      width: 100%;
    }

    .cards-container {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 16px;
      width: 100%;
    }

    @media (max-width: 1400px) {
      .cards-container {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }

    @media (max-width: 1024px) {
      .cards-container {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }

    @media (max-width: 768px) {
      .cards-container {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 480px) {
      .cards-container {
        grid-template-columns: 1fr;
      }
    }

    .metric-card {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px 24px;
      width: 100%;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .metric-card:hover {
      background-color: var(--bg-card-hover);
      transform: translateY(-2px);
    }

    .metric-card.active {
      background-color: var(--bg-card-hover);
      border-color: var(--color-accent);
      box-shadow: 0 0 16px rgba(99, 102, 241, 0.2);
    }

    .metric-card.active::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: linear-gradient(90deg, #6366f1, #a855f7);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .card-name {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .card-ticker {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 500;
      text-transform: uppercase;
    }

    .card-value {
      font-size: 26px;
      font-weight: 800;
      margin-bottom: 8px;
      letter-spacing: -0.03em;
    }

    .card-change-info {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
    }

    .card-change-info.up {
      color: var(--color-up);
    }

    .card-change-info.down {
      color: var(--color-down);
    }

    .card-change-info.zero {
      color: var(--text-secondary);
    }

    .chart-section {
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 32px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .chart-title-area h2 {
      font-size: 20px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .chart-title-area span {
      font-size: 14px;
      color: var(--text-secondary);
      font-weight: 400;
    }

    .period-selector {
      display: flex;
      background-color: var(--bg-primary);
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }

    .btn-period {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-weight: 700;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-period.active {
      background-color: var(--bg-card-hover);
      color: var(--text-primary);
    }

    .chart-wrapper {
      position: relative;
      height: 450px;
      width: 100%;
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: rgba(11, 15, 25, 0.7);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
      color: var(--text-secondary);
      backdrop-filter: blur(4px);
    }

    .loading-overlay[hidden] {
      display: none !important;
    }

    @media (max-width: 768px) {
      main {
        padding: 16px;
      }
      header {
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
      }
      .btn-refresh {
        width: 100%;
        text-align: center;
      }
      .chart-section {
        padding: 16px;
      }
      .chart-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
      }
      .period-selector {
        width: 100%;
        justify-content: space-between;
      }
      .chart-wrapper {
        height: 300px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="title-area">
        <h1>Market Monitoring Dashboard</h1>
        <p>글로벌 주요 자산 및 지표 모니터링</p>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <div class="date-picker-container">
          <label for="dateInput">조회 기준일</label>
          <input type="date" id="dateInput" class="date-input" />
        </div>
        <button class="btn-refresh" id="btnRefresh">지표 새로고침</button>
      </div>
    </header>

    <div class="cards-wrapper">
      <div class="cards-container" id="cardsContainer">
      </div>
    </div>

    <section class="chart-section">
      <div class="chart-header">
        <div class="chart-title-area">
          <h2>
            <span id="chartTargetName">종목명</span>
            <span id="chartTargetTicker">TICKER</span>
            <span>역사적 추이</span>
          </h2>
        </div>
        <div class="period-selector">
          <button class="btn-period" data-period="1M">1M</button>
          <button class="btn-period" data-period="3M">3M</button>
          <button class="btn-period active" data-period="1Y">1Y</button>
          <button class="btn-period" data-period="3Y">3Y</button>
        </div>
      </div>

      <div class="chart-wrapper">
        <div class="loading-overlay" id="loadingOverlay" hidden>데이터를 불러오는 중...</div>
        <canvas id="historyChart"></canvas>
      </div>
    </section>
  </main>

  <script>
    let latestMetrics = [];
    let selectedMetric = null;
    let selectedPeriod = '1Y';
    let selectedDate = '';
    let chartInstance = null;

    const dom = {
      cardsContainer: document.getElementById('cardsContainer'),
      chartTargetName: document.getElementById('chartTargetName'),
      chartTargetTicker: document.getElementById('chartTargetTicker'),
      loadingOverlay: document.getElementById('loadingOverlay'),
      btnRefresh: document.getElementById('btnRefresh'),
      periodButtons: document.querySelectorAll('.btn-period'),
      dateInput: document.getElementById('dateInput'),
    };

    dom.btnRefresh.addEventListener('click', async () => {
      await loadAvailableDates();
      await loadLatestMetrics();
    });

    dom.dateInput.addEventListener('change', (e) => {
      selectedDate = e.target.value;
      loadLatestMetrics();
    });

    dom.periodButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        dom.periodButtons.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        selectedPeriod = e.target.dataset.period;
        if (selectedMetric) {
          loadHistory(selectedMetric.metric_key);
        }
      });
    });

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function escapeJs(value) {
      return String(value ?? '').replace(/'/g, "\\\\'");
    }

    function formatNumber(num, isPercent = false) {
      if (num === null || num === undefined) return '-';
      const parsed = parseFloat(num);
      if (isNaN(parsed)) return num;
      
      const options = {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      };
      
      const formatted = parsed.toLocaleString('ko-KR', options);
      if (isPercent) {
        return (parsed >= 0 ? '+' : '') + formatted + '%';
      }
      return formatted;
    }

    async function loadAvailableDates() {
      try {
        const res = await fetch('/api/available-dates');
        if (!res.ok) throw new Error('날짜 목록 조회 실패');
        const dates = await res.json();
        
        if (dates.length > 0) {
          const maxDate = dates[0];
          const minDate = dates[dates.length - 1];
          
          dom.dateInput.max = maxDate;
          dom.dateInput.min = minDate;
          
          if (!selectedDate || !dates.includes(selectedDate)) {
            selectedDate = maxDate;
          }
          dom.dateInput.value = selectedDate;
        } else {
          selectedDate = '';
          dom.dateInput.value = '';
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function loadLatestMetrics() {
      try {
        dom.loadingOverlay.hidden = false;
        const url = selectedDate ? '/api/latest-metrics?date=' + encodeURIComponent(selectedDate) : '/api/latest-metrics';
        const res = await fetch(url);
        if (!res.ok) throw new Error('API 호출 실패');
        latestMetrics = await res.json();
        
        latestMetrics = latestMetrics.filter(m => m.metric_key !== '_cf_KV' && m.metric_key !== '_chf_KV');

        renderCards();

        if (latestMetrics.length > 0) {
          const defaultTarget = latestMetrics.find(m => m.metric_key === 'S&P500') || latestMetrics[0];
          selectMetric(defaultTarget);
        } else {
          dom.loadingOverlay.hidden = true;
        }
      } catch (err) {
        console.error(err);
        alert('최신 지표 로드 실패: ' + err.message);
        dom.loadingOverlay.hidden = true;
      }
    }

    function renderCards() {
      dom.cardsContainer.innerHTML = latestMetrics.map(metric => {
        const isUp = metric.change > 0;
        const isDown = metric.change < 0;
        const changeClass = isUp ? 'up' : (isDown ? 'down' : 'zero');
        const sign = isUp ? '▲' : (isDown ? '▼' : '');
        
        const activeClass = selectedMetric && selectedMetric.metric_key === metric.metric_key ? 'active' : '';

        return '<div class="metric-card ' + activeClass + '" data-key="' + escapeHtml(metric.metric_key) + '" onclick="handleCardClick(this.dataset.key)">' +
          '<div class="card-header">' +
            '<span class="card-name">' + escapeHtml(metric.metric_key) + '</span>' +
            '<span class="card-ticker">' + escapeHtml(metric.ticker) + '</span>' +
          '</div>' +
          '<div class="card-value">' + formatNumber(metric.latest_value) + '</div>' +
          '<div class="card-change-info ' + changeClass + '">' +
            '<span>' + sign + ' ' + formatNumber(Math.abs(metric.change_percent)) + '%</span>' +
            '<span>' + (metric.change >= 0 ? '+' : '-') + formatNumber(Math.abs(metric.change)) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function handleCardClick(metricKey) {
      const target = latestMetrics.find(m => m.metric_key === metricKey);
      if (target) {
        selectMetric(target);
      }
    }

    function selectMetric(metric) {
      selectedMetric = metric;
      
      const cards = dom.cardsContainer.querySelectorAll('.metric-card');
      latestMetrics.forEach((m, idx) => {
        if (m.metric_key === metric.metric_key) {
          cards[idx]?.classList.add('active');
        } else {
          cards[idx]?.classList.remove('active');
        }
      });

      dom.chartTargetName.textContent = metric.metric_key;
      dom.chartTargetTicker.textContent = metric.ticker;
      
      loadHistory(metric.metric_key);
    }

    async function loadHistory(metricKey) {
      try {
        dom.loadingOverlay.hidden = false;
        const res = await fetch('/api/metric-history?metric_key=' + encodeURIComponent(metricKey) + '&period=' + selectedPeriod);
        if (!res.ok) throw new Error('API 호출 실패');
        const historyData = await res.json();
        
        renderChart(historyData);
        dom.loadingOverlay.hidden = true;
      } catch (err) {
        console.error(err);
        alert('역사적 추이 로드 실패: ' + err.message);
        dom.loadingOverlay.hidden = true;
      }
    }

    function renderChart(data) {
      const ctx = document.getElementById('historyChart').getContext('2d');
      
      const labels = data.map(d => d.date);
      const values = data.map(d => d.value);

      if (chartInstance) {
        chartInstance.destroy();
      }

      const gradient = ctx.createLinearGradient(0, 0, 0, 400);
      gradient.addColorStop(0, 'rgba(248, 113, 113, 0.4)');
      gradient.addColorStop(1, 'rgba(248, 113, 113, 0.0)');

      chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: selectedMetric ? selectedMetric.metric_key : '',
            data: values,
            borderColor: '#f87171',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#f87171',
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
            fill: true,
            backgroundColor: gradient,
            tension: 0.15
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: '#1f293d',
              titleColor: '#94a3b8',
              bodyColor: '#ffffff',
              borderColor: 'rgba(255,255,255,0.1)',
              borderWidth: 1,
              titleFont: {
                family: 'Inter',
                weight: '600'
              },
              bodyFont: {
                family: 'Inter',
                weight: '700'
              },
              callbacks: {
                label: function(context) {
                  return '값: ' + formatNumber(context.raw);
                }
              }
            }
          },
          scales: {
            x: {
              grid: {
                display: false
              },
              ticks: {
                color: '#64748b',
                font: {
                  family: 'Inter',
                  size: 11
                },
                maxTicksLimit: 10
              }
            },
            y: {
              grid: {
                color: 'rgba(255, 255, 255, 0.05)'
              },
              ticks: {
                color: '#64748b',
                font: {
                  family: 'Inter',
                  size: 11
                }
              }
            }
          }
        }
      });
    }

    async function init() {
      await loadAvailableDates();
      await loadLatestMetrics();
    }
    init();
  </script>
</body>
</html>`
}
