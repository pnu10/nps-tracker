// ── 국민연금 뭐샀지 — Cloudflare Worker ──────────────────────────
// 국내: DART API (5% 이상 대량보유)
// 미국: SEC EDGAR 13F (전종목)

const NPS_CIK       = "0001608046";
const NPS_NUMERIC   = "1608046";
const SEC_UA        = "NPS-Tracker contact@example.com";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ── 환율 ──────────────────────────────────────────────────────────
async function updateExchangeRate(env) {
  const res  = await fetch("https://api.frankfurter.app/latest?from=USD&to=KRW");
  const data = await res.json();
  await env.KV.put("exchange_rate", JSON.stringify({
    rate: data.rates.KRW,
    date: data.date,
  }));
}

// ── 미국 주식: SEC EDGAR 13F (이번 + 직전 2분기 비교) ───────────
async function fetchUSHoldings() {
  // 1. 제출 목록에서 최신 13F-HR 2개 찾기
  const subRes = await fetch(
    `https://data.sec.gov/submissions/CIK${NPS_CIK}.json`,
    { headers: { "User-Agent": SEC_UA } }
  );
  if (!subRes.ok) throw new Error(`SEC submissions ${subRes.status}`);
  const sub     = await subRes.json();
  const filings = sub.filings?.recent;
  if (!filings) throw new Error("SEC filing 없음");

  const found = []; // 최신 2개
  for (let i = 0; i < filings.form.length && found.length < 2; i++) {
    if (filings.form[i] === "13F-HR") {
      found.push({
        accession:  filings.accessionNumber[i],
        filingDate: filings.filingDate[i],
      });
    }
  }
  if (found.length === 0) throw new Error("13F-HR 없음");

  // 2. 두 분기 동시에 fetch
  const [curr, prev] = await Promise.all(
    found.map(f => fetchOneQuarter(f.accession, f.filingDate))
  );

  // 3. 직전 분기 종목 맵 (name → shares)
  const prevMap = {};
  for (const h of (prev?.holdings || [])) {
    prevMap[h.name] = h.shares;
  }

  // 4. 변화 유형 계산
  const currNames = new Set(curr.holdings.map(h => h.name));
  const prevNames = new Set(Object.keys(prevMap));

  const holdings = curr.holdings.map(h => {
    const prevShares = prevMap[h.name];
    let changeType, changePct;

    if (prevShares === undefined) {
      changeType = "NEW";
      changePct  = null;
    } else if (h.shares > prevShares) {
      changeType = "INCREASED";
      changePct  = +((h.shares - prevShares) / prevShares * 100).toFixed(1);
    } else if (h.shares < prevShares) {
      changeType = "DECREASED";
      changePct  = +((h.shares - prevShares) / prevShares * 100).toFixed(1);
    } else {
      changeType = "HOLD";
      changePct  = 0;
    }

    return { ...h, changeType, changePct };
  });

  // 5. 직전엔 있었지만 이번엔 없는 종목 → SOLD
  const sold = [];
  for (const name of prevNames) {
    if (!currNames.has(name)) {
      const prevH = prev.holdings.find(h => h.name === name);
      if (prevH) sold.push({ ...prevH, changeType: "SOLD", changePct: -100 });
    }
  }

  return {
    filingDate:     curr.filingDate,
    prevFilingDate: prev?.filingDate || null,
    accession:      curr.accession,
    holdings,
    sold,
  };
}

async function fetchOneQuarter(accession, filingDate) {
  const accNo    = accession.replace(/-/g, "");
  const indexRes = await fetch(
    `https://www.sec.gov/Archives/edgar/data/${NPS_NUMERIC}/${accNo}/index.json`,
    { headers: { "User-Agent": SEC_UA } }
  );
  if (!indexRes.ok) return { filingDate, accession, holdings: [] };

  const items   = (await indexRes.json()).directory?.item || [];
  const xmlFile = items.find(f =>
    f.name?.toLowerCase().includes("infotable") && f.name?.endsWith(".xml")
  ) || items.find(f =>
    f.name?.endsWith(".xml") && !f.name?.toLowerCase().includes("primary")
  );
  if (!xmlFile) return { filingDate, accession, holdings: [] };

  const xmlRes = await fetch(
    `https://www.sec.gov/Archives/edgar/data/${NPS_NUMERIC}/${accNo}/${xmlFile.name}`,
    { headers: { "User-Agent": SEC_UA } }
  );
  if (!xmlRes.ok) return { filingDate, accession, holdings: [] };

  return {
    filingDate,
    accession,
    holdings: parseInfoTable(await xmlRes.text()),
  };
}

function parseInfoTable(xml) {
  const holdings = [];
  const regex    = /<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const block = match[1];
    const get   = (tag) => {
      const m = block.match(
        new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]*)<\\/(?:\\w+:)?${tag}>`, "i")
      );
      return m ? m[1].trim() : "";
    };

    const name   = get("nameOfIssuer");
    const value  = parseInt(get("value") || "0");
    const shares = parseInt(get("sshPrnamt") || "0");
    const putCall = get("putCall");

    if (name && value > 0) {
      holdings.push({ name, value, shares, putCall });
    }
  }

  holdings.sort((a, b) => b.value - a.value);
  return holdings;
}

// ── 국내 주식: DART 대량보유 ──────────────────────────────────────
async function fetchKoreanHoldings(dartKey) {
  // DART: 국민연금이 제출한 '주식등의대량보유상황보고서' 전체 스캔
  // 3개월씩 최근 2년치 조회 → 국민연금 공시 corp_code 수집
  const today  = new Date();
  const chunks = [];

  for (let i = 0; i < 4; i++) {
    const end   = new Date(today);
    end.setMonth(end.getMonth() - i * 3);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 3);
    chunks.push({ bgn: fmtDate(start), end: fmtDate(end) });
  }

  // corp_code → 최신 rcept_no 매핑
  const corpMap = {};

  for (const chunk of chunks) {
    let page  = 1;
    let total = Infinity;

    while (page * 100 <= total + 100) {
      const url = `https://opendart.fss.or.kr/api/list.json` +
        `?crtfc_key=${dartKey}` +
        `&bgn_de=${chunk.bgn}&end_de=${chunk.end}` +
        `&page_no=${page}&page_count=100`;

      const res  = await fetch(url);
      const data = await res.json();

      if (data.status !== "000") break;
      total = parseInt(data.total_count) || 0;

      for (const item of (data.list || [])) {
        const isLargeholding = item.report_nm?.includes("대량보유");
        const isNPS = item.flr_nm?.includes("국민연금");
        if (isLargeholding && isNPS) {
          const code = item.corp_code;
          if (!corpMap[code] || item.rcept_dt > corpMap[code].rcept_dt) {
            corpMap[code] = {
              corp_name: item.corp_name,
              rcept_dt:  item.rcept_dt,
              rcept_no:  item.rcept_no,
            };
          }
        }
      }

      if (page * 100 >= total) break;
      page++;
    }
  }

  // 각 corp_code → majorstock API 로 최신 지분율 확인
  const holdings = [];

  await Promise.all(
    Object.entries(corpMap).map(async ([corp_code, info]) => {
      try {
        const url  = `https://opendart.fss.or.kr/api/majorstock.json` +
          `?crtfc_key=${dartKey}&corp_code=${corp_code}`;
        const res  = await fetch(url);
        const data = await res.json();

        const npsRows = (data.list || [])
          .filter(r => r.repror?.includes("국민연금"))
          .sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt));

        if (npsRows.length === 0) return;

        const current  = npsRows[0];
        const previous = npsRows[1] || null;
        const pct      = parseFloat(current.stkrt || "0");
        const prevPct  = previous ? parseFloat(previous.stkrt || "0") : null;
        const shares   = parseInt((current.stkqy || "0").replace(/,/g, ""));

        let changeType, changePct;
        if (prevPct === null) {
          changeType = "NEW"; changePct = null;
        } else if (pct > prevPct) {
          changeType = "INCREASED"; changePct = +(pct - prevPct).toFixed(2);
        } else if (pct < prevPct) {
          changeType = "DECREASED"; changePct = +(pct - prevPct).toFixed(2);
        } else {
          changeType = "HOLD"; changePct = 0;
        }

        if (pct >= 5) {
          holdings.push({
            corp_code,
            corp_name: info.corp_name,
            shares, pct, prevPct,
            changeType, changePct,
            rcept_dt: current.rcept_dt,
            prevRcept_dt: previous?.rcept_dt || null,
            market: "KOSPI",
          });
        }
      } catch (e) {
        console.error(`majorstock ${corp_code}:`, e.message);
      }
    })
  );

  holdings.sort((a, b) => b.pct - a.pct);
  return holdings;
}

// ── Cron: 매일 새벽 데이터 갱신 ──────────────────────────────────
export async function scheduled(event, env, ctx) {
  ctx.waitUntil((async () => {
    await updateExchangeRate(env);

    // 국내
    try {
      const kr = await fetchKoreanHoldings(env.DART_API_KEY);
      await env.KV.put("kr_holdings", JSON.stringify({
        updatedAt: new Date().toISOString(),
        count:     kr.length,
        holdings:  kr,
      }), { expirationTtl: 86400 * 7 });
      console.log(`국내 보유 갱신 완료: ${kr.length}개`);
    } catch (e) {
      console.error("국내 갱신 실패:", e.message);
    }

    // 미국
    try {
      const rateRaw = await env.KV.get("exchange_rate");
      const { rate } = rateRaw ? JSON.parse(rateRaw) : { rate: 1350 };
      const us  = await fetchUSHoldings();
      const total = us.holdings.reduce((s, h) => s + h.value, 0);
      await env.KV.put("us_holdings", JSON.stringify({
        updatedAt:      new Date().toISOString(),
        filingDate:     us.filingDate,
        prevFilingDate: us.prevFilingDate,
        count:          us.holdings.length,
        totalValueUsd:  total,
        exchangeRate:   rate,
        holdings: us.holdings.map(h => ({
          ...h,
          pct:      total > 0 ? +((h.value / total) * 100).toFixed(2) : 0,
          valueKrw: Math.round(h.value * rate),
        })),
        sold: us.sold.map(h => ({ ...h, valueKrw: Math.round(h.value * rate) })),
      }), { expirationTtl: 21600 });
      console.log(`미국 보유 갱신 완료: ${us.holdings.length}개`);
    } catch (e) {
      console.error("미국 갱신 실패:", e.message);
    }
  })());
}

// ── HTTP 라우터 ───────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // 환율
    if (path === "/api/exchange-rate") {
      let cached = await env.KV.get("exchange_rate");
      if (!cached) {
        await updateExchangeRate(env);
        cached = await env.KV.get("exchange_rate");
      }
      return json(JSON.parse(cached));
    }

    // 미국 주식 (캐시 우선, 없으면 실시간)
    if (path === "/api/us-holdings") {
      const cached = await env.KV.get("us_holdings");
      if (cached) return json(JSON.parse(cached));

      try {
        const rateRaw = await env.KV.get("exchange_rate");
        const { rate } = rateRaw ? JSON.parse(rateRaw) : { rate: 1350 };
        const us    = await fetchUSHoldings();
        const total = us.holdings.reduce((s, h) => s + h.value, 0);
        const result = {
          filingDate:     us.filingDate,
          prevFilingDate: us.prevFilingDate,
          count:          us.holdings.length,
          totalValueUsd:  total,
          exchangeRate:   rate,
          holdings: us.holdings.map(h => ({
            ...h,
            pct:      total > 0 ? +((h.value / total) * 100).toFixed(2) : 0,
            valueKrw: Math.round(h.value * rate),
          })),
          sold: us.sold.map(h => ({ ...h, valueKrw: Math.round(h.value * rate) })),
        };
        ctx.waitUntil(env.KV.put("us_holdings", JSON.stringify(result), { expirationTtl: 21600 }));
        return json(result);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // 국내 주식 (캐시 우선, 없으면 실시간)
    if (path === "/api/kr-holdings") {
      const cached = await env.KV.get("kr_holdings");
      if (cached) return json(JSON.parse(cached));

      try {
        const kr = await fetchKoreanHoldings(env.DART_API_KEY);
        const result = {
          updatedAt: new Date().toISOString(),
          count:     kr.length,
          holdings:  kr,
        };
        ctx.waitUntil(env.KV.put("kr_holdings", JSON.stringify(result), { expirationTtl: 86400 }));
        return json(result);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // 수동 갱신 트리거 (배포 후 첫 데이터 채우기용)
    if (path === "/api/refresh" && request.method === "POST") {
      ctx.waitUntil((async () => {
        try {
          await updateExchangeRate(env);
          const kr = await fetchKoreanHoldings(env.DART_API_KEY);
          await env.KV.put("kr_holdings", JSON.stringify({ updatedAt: new Date().toISOString(), count: kr.length, holdings: kr }), { expirationTtl: 86400 * 7 });
          const rateRaw = await env.KV.get("exchange_rate");
          const { rate } = rateRaw ? JSON.parse(rateRaw) : { rate: 1350 };
          const us = await fetchUSHoldings();
          const total = us.holdings.reduce((s, h) => s + h.value, 0);
          await env.KV.put("us_holdings", JSON.stringify({
            filingDate: us.filingDate,
            count: us.holdings.length,
            totalValueUsd: total,
            exchangeRate: rate,
            holdings: us.holdings.map(h => ({ ...h, pct: total > 0 ? +((h.value / total) * 100).toFixed(2) : 0, valueKrw: Math.round(h.value * rate) })),
          }), { expirationTtl: 21600 });
        } catch(e) { console.error(e); }
      })());
      return json({ message: "갱신 시작됨 (백그라운드)" });
    }

    return json({ error: "Not Found" }, 404);
  },

  scheduled,
};
