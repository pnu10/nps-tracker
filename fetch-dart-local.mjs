// 로컬에서 실행 → KV에 업로드용 JSON 생성
const DART_KEY = process.env.DART_API_KEY || "12bbbcfce5dcae69967a8c2d9e4613da80c0122f";

function fmtDate(d) {
  return d.toISOString().slice(0,10).replace(/-/g,"");
}

async function fetchKoreanHoldings() {
  const today = new Date();
  const chunks = [];
  for (let i = 0; i < 8; i++) {
    const end = new Date(today);
    end.setMonth(end.getMonth() - i * 3);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 3);
    chunks.push({ bgn: fmtDate(start), end: fmtDate(end) });
  }

  const corpMap = {};
  for (const chunk of chunks) {
    let page = 1, total = Infinity;
    while (page * 100 <= total + 100) {
      const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_KEY}&bgn_de=${chunk.bgn}&end_de=${chunk.end}&page_no=${page}&page_count=100`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== "000") break;
      total = parseInt(data.total_count) || 0;
      for (const item of (data.list || [])) {
        if (item.report_nm?.includes("대량보유") && item.flr_nm?.includes("국민연금")) {
          const code = item.corp_code;
          if (!corpMap[code] || item.rcept_dt > corpMap[code].rcept_dt) {
            corpMap[code] = { corp_name: item.corp_name, rcept_dt: item.rcept_dt, rcept_no: item.rcept_no };
          }
        }
      }
      if (page * 100 >= total) break;
      page++;
    }
  }

  console.error(`corp_code 수집: ${Object.keys(corpMap).length}개`);

  const holdings = [];
  await Promise.all(
    Object.entries(corpMap).map(async ([corp_code, info]) => {
      try {
        const url = `https://opendart.fss.or.kr/api/majorstock.json?crtfc_key=${DART_KEY}&corp_code=${corp_code}`;
        const res = await fetch(url);
        const data = await res.json();
        const npsRows = (data.list || [])
          .filter(r => r.repror?.includes("국민연금"))
          .sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt));
        if (!npsRows.length) return;
        const latest = npsRows[0];
        const pct = parseFloat(latest.stkrt || "0");
        const shares = parseInt((latest.stkqy || "0").replace(/,/g,""));
        if (pct >= 5) {
          holdings.push({ corp_code, corp_name: info.corp_name, shares, pct, rcept_dt: latest.rcept_dt, market: "KOSPI" });
        }
      } catch(e) {}
    })
  );

  holdings.sort((a,b) => b.pct - a.pct);
  return holdings;
}

const kr = await fetchKoreanHoldings();
const result = JSON.stringify({ updatedAt: new Date().toISOString(), count: kr.length, holdings: kr });
console.log(result);
