/**
 * 키움증권 REST API 중계서버 (베르셀 서버리스 함수)
 *
 * 브라우저는 키움 서버에 직접 연결할 수 없습니다(CORS 차단).
 * 이 함수가 중간에서 대신 물어보고 답을 넘겨줍니다.
 *
 * 앱키와 시크릿은 베르셀 환경변수에만 있고, 브라우저로는 절대 나가지 않습니다.
 *
 * ★ 조회 전용입니다. 주문 계열 API는 아래 목록에 없으므로 호출 자체가 막힙니다.
 */

const BASE = "https://api.kiwoom.com";        // 실전투자
const TOKEN_URL = BASE + "/oauth2/token";

/* ── 허용 목록 ────────────────────────────────────────────
   여기 없는 API는 부를 수 없습니다. 주문(kt10000~kt10009 등)은
   의도적으로 넣지 않았습니다. 넣더라도 아래 BLOCK 검사에 걸립니다. */
const ALLOWED = {
  // 업종 — 상승/하락 종목수, 지수
  "ka20001": "/api/dostk/sect",      // 업종현재가요청
  "ka20003": "/api/dostk/sect",      // 전업종지수요청
  "ka20002": "/api/dostk/sect",      // 업종별주가요청
  "ka10051": "/api/dostk/sect",      // 업종별투자자순매수요청

  // 외국인·기관
  "ka10008": "/api/dostk/frgnistt",  // 주식외국인종목별매매동향
  "ka10009": "/api/dostk/frgnistt",  // 주식기관요청
  "ka10131": "/api/dostk/frgnistt",  // 기관외국인연속매매현황요청

  // 종목 정보
  "ka10001": "/api/dostk/stkinfo",   // 주식기본정보요청
  "ka10059": "/api/dostk/stkinfo",   // 종목별투자자기관별요청
  "ka10061": "/api/dostk/stkinfo",   // 종목별투자자기관별합계요청
};

/* 혹시라도 주문 계열이 들어오면 이중으로 막습니다 */
const BLOCK = /^(kt1000[0-9]|kt5000[0-3]|kt1000[6-9])$/i;


/* 환경변수가 왜 안 보이는지 알려주는 도우미.
   ★ 값은 절대 내보내지 않습니다. 이름과 글자 수만 알려줍니다. */
function envDiagnosis() {
  const want = ["KIWOOM_APP_KEY", "KIWOOM_SECRET"];
  const found = Object.keys(process.env)
    .filter(k => /KIWOOM|KIS_|APP_KEY|APPKEY|SECRET/i.test(k))
    .sort();
  return {
    필요한이름: want,
    실제찾은이름: found.length ? found : "(비슷한 이름이 하나도 없습니다)",
    이름별상태: found.reduce((o, k) => {
      const v = process.env[k] || "";
      o[k] = v ? `값 있음 (${v.length}글자)` : "비어 있음";
      return o;
    }, {}),
    환경: process.env.VERCEL_ENV || "(모름)",
    맞는지: want.every(k => (process.env[k] || "").length > 0),
  };
}


/* 키움이 준 오류 번호를 쉬운 말로 풀어줍니다 */
function 설명(code, msg) {
  const 안내 = {
    2: "보낸 값의 이름이 키움이 기대하는 것과 다릅니다.",
    3: "키는 제대로 전달됐지만 키움이 이 접속을 거부했습니다.\n" +
       "→ 8050(지정단말기 인증 실패)이면 키움 계정 쪽 설정 문제입니다.\n" +
       "   ① 키움 OpenAPI 포털에서 '접속 허용 IP'가 등록돼 있는지\n" +
       "   ② 계좌에 '지정단말 서비스'(등록한 PC에서만 접속 허용)가 켜져 있는지\n" +
       "   ③ 실전투자용 키가 맞는지 (모의투자 키는 mockapi 주소를 씁니다)\n" +
       "   이 서버는 베르셀에서 도는데 접속 IP가 매번 바뀝니다.\n" +
       "   키움이 고정 IP를 요구하면 다른 방식이 필요합니다.",
    8: "접근토큰이 만료됐거나 잘못됐습니다.",
  };
  const 부연 = 안내[code] ? "\n\n[쉬운 설명] " + 안내[code] : "";
  return `[${code}] ${msg || ""}${부연}`;
}

/* ── 접근토큰 ─────────────────────────────────────────────
   토큰은 하루짜리입니다. 함수 인스턴스가 살아 있는 동안 재사용합니다.
   키움은 토큰 발급 횟수에 제한이 있어 매번 새로 받으면 안 됩니다. */
let cachedToken = null;
let cachedUntil = 0;
let lastTokenShape = null;   // 어느 이름으로 성공했는지 기록

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedUntil) return cachedToken;

  // 붙여넣을 때 앞뒤에 공백이나 줄바꿈이 딸려오는 일이 흔합니다
  const key = (process.env.KIWOOM_APP_KEY || "").trim();
  const secret = (process.env.KIWOOM_SECRET || "").trim();
  if (!key || !secret) {
    throw new Error("환경변수 KIWOOM_APP_KEY 또는 KIWOOM_SECRET 이 없습니다");
  }

  // ★ 확인된 형식입니다 (2026-08-05 실측)
  //   JSON 본문 + secretkey  →  파라미터 검사 통과
  //   appsecretkey / appsecret → 8020 오류
  //   form-urlencoded → HTTP 415 거부
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: key,
      secretkey: secret,
    }),
  });

  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch (e) { throw new Error(`토큰 응답이 JSON이 아닙니다 (HTTP ${r.status}): ${text.slice(0, 200)}`); }

  const token = j.token || j.access_token;
  if (!token) {
    throw new Error(`토큰 발급 실패 ${설명(j.return_code, j.return_msg)}`);
  }
  lastTokenShape = "secretkey";

  cachedToken = token;
  // 유효기간보다 10분 일찍 만료 처리해 경계에서 실패하지 않게 합니다
  const ttl = Number(j.expires_in || 86400) * 1000;
  cachedUntil = now + Math.max(60000, ttl - 600000);
  return token;
}

async function callKiwoom(apiId, body, contYn, nextKey) {
  const path = ALLOWED[apiId];
  const token = await getToken();

  const r = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "authorization": "Bearer " + token,
      "api-id": apiId,
      "cont-yn": contYn || "N",
      "next-key": nextKey || "",
    },
    body: JSON.stringify(body || {}),
  });

  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch (e) { throw new Error(`응답이 JSON이 아닙니다 (HTTP ${r.status}): ${text.slice(0, 300)}`); }

  return {
    httpStatus: r.status,
    contYn: r.headers.get("cont-yn") || j.cont_yn || "N",
    nextKey: r.headers.get("next-key") || j.next_key || "",
    data: j,
  };
}



/* 이 서버가 바깥으로 나갈 때 쓰는 IP를 알아냅니다.
   키움에 등록한 IP와 이게 같아야 통과합니다. */
async function 나가는IP() {
  const 후보 = [
    ["ipify",   "https://api.ipify.org?format=json", j => j.ip],
    ["ipinfo",  "https://ipinfo.io/json",            j => j.ip],
    ["ifconfig","https://ifconfig.co/json",          j => j.ip],
  ];
  for (const [이름, url, 뽑기] of 후보) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 6000);
      const r = await fetch(url, { signal: c.signal });
      clearTimeout(t);
      const j = await r.json();
      const ip = 뽑기(j);
      if (ip) return { ip, 확인처: 이름 };
    } catch (e) { /* 다음 후보로 */ }
  }
  return { ip: null, 확인처: "확인 실패" };
}

/* 어떤 형식이 통하는지 한 번에 다 시험합니다.
   ★ 키 값은 절대 내보내지 않습니다. */
async function 형식진단() {
  const rawKey = process.env.KIWOOM_APP_KEY || "";
  const rawSec = process.env.KIWOOM_SECRET || "";
  const key = rawKey.trim(), secret = rawSec.trim();

  const 값점검 = {
    "앱키 길이": `원본 ${rawKey.length} / 공백제거 ${key.length}`,
    "시크릿 길이": `원본 ${rawSec.length} / 공백제거 ${secret.length}`,
    "앞뒤 공백 있었나": (rawKey.length !== key.length || rawSec.length !== secret.length) ? "있었음 ⚠" : "없음",
    "둘이 같은 값인가": key === secret ? "같음 ⚠ (잘못 붙여넣었을 수 있습니다)" : "다름",
    "앱키 시작": key.slice(0, 3) + "…",
    "시크릿 시작": secret.slice(0, 3) + "…",
  };

  const 시도목록 = [
    { 이름: "JSON · secretkey",
      ct: "application/json;charset=UTF-8",
      body: JSON.stringify({ grant_type: "client_credentials", appkey: key, secretkey: secret }) },
    { 이름: "JSON · appsecretkey",
      ct: "application/json;charset=UTF-8",
      body: JSON.stringify({ grant_type: "client_credentials", appkey: key, appsecretkey: secret }) },
    { 이름: "JSON · appsecret",
      ct: "application/json;charset=UTF-8",
      body: JSON.stringify({ grant_type: "client_credentials", appkey: key, appsecret: secret }) },
    { 이름: "JSON(charset 없음) · secretkey",
      ct: "application/json",
      body: JSON.stringify({ grant_type: "client_credentials", appkey: key, secretkey: secret }) },
    { 이름: "JSON · 세 이름 모두",
      ct: "application/json;charset=UTF-8",
      body: JSON.stringify({ grant_type: "client_credentials", appkey: key,
                             secretkey: secret, appsecretkey: secret, appsecret: secret }) },
    { 이름: "폼(form-urlencoded) · secretkey",
      ct: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ grant_type: "client_credentials", appkey: key, secretkey: secret }).toString() },
  ];

  const 결과 = [];
  for (const t of 시도목록) {
    try {
      const r = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": t.ct },
        body: t.body,
      });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch (e) {}
      const tok = j && (j.token || j.access_token);
      결과.push({
        형식: t.이름,
        HTTP: r.status,
        성공: !!tok,
        코드: j ? j.return_code : null,
        메시지: j ? (j.return_msg || "").slice(0, 120) : text.slice(0, 120),
      });
      if (tok) break;   // 되는 걸 찾으면 멈춥니다
    } catch (e) {
      결과.push({ 형식: t.이름, 성공: false, 메시지: String(e.message || e).slice(0, 120) });
    }
  }

  const 성공한것 = 결과.find(r => r.성공);
  const ipInfo = await 나가는IP();
  return {
    이서버가나가는IP: ipInfo.ip,
    IP안내: "키움 포털에 등록한 IP와 위 주소가 같은지 확인하세요.",
    값점검,
    시도결과: 결과,
    결론: 성공한것
      ? `"${성공한것.형식}" 형식으로 성공했습니다. 이 형식으로 고정하면 됩니다.`
      : "모든 형식이 실패했습니다. 키 자체나 API 사용 승인 상태를 확인해야 합니다.",
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  const body = (req.method === "POST" && req.body) ? req.body : {};

  // ── 형식 진단 모드: 어떤 요청 형식이 통하는지 전부 시험 ──
  if (q.diag === "1") {
    try {
      return res.status(200).json(await 형식진단());
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  // ── 점검 모드: 설정이 제대로 됐는지만 확인 ──
  if (q.check === "1") {
    try {
      const ipInfo = await 나가는IP();
      await getToken();
      return res.status(200).json({
        ok: true,
        이서버가나가는IP: ipInfo.ip,
        IP확인처: ipInfo.확인처,
        message: "키움 접속 정상. 접근토큰을 받았습니다.",
        server: "실전투자 (api.kiwoom.com)",
        토큰항목이름: lastTokenShape,
        allowedApis: Object.keys(ALLOWED),
        note: "주문 계열 API는 허용 목록에 없어 호출할 수 없습니다.",
      });
    } catch (e) {
      const ipInfo2 = await 나가는IP().catch(() => ({ ip: null }));
      return res.status(500).json({
        ok: false,
        error: String(e.message || e),
        이서버가나가는IP: ipInfo2.ip,
        IP안내: "키움에 등록한 IP와 위 주소가 같아야 합니다. 다르면 등록해 주세요.",
        진단: envDiagnosis(),
        확인하세요: [
          "베르셀 Settings → Environment Variables 에서 이름이 정확한지",
          "Production 에 체크되어 있는지",
          "변수를 넣은 뒤 Deployments 에서 Redeploy 를 했는지",
        ],
      });
    }
  }

  const apiId = String(q.apiId || body.apiId || "").trim();
  if (!apiId) {
    return res.status(400).json({
      ok: false,
      error: "apiId 가 필요합니다",
      사용법: {
        "설정 점검": "/api/kiwoom?check=1",
        "조회": "/api/kiwoom?apiId=ka20001&inds_cd=001",
        "허용된 API": Object.keys(ALLOWED),
      },
    });
  }

  if (BLOCK.test(apiId) || !ALLOWED[apiId]) {
    return res.status(403).json({
      ok: false,
      error: `${apiId} 는 허용되지 않은 API입니다. 이 중계서버는 조회만 합니다.`,
      allowedApis: Object.keys(ALLOWED),
    });
  }

  // 나머지 쿼리스트링을 그대로 키움 요청 본문으로 넘깁니다
  const payload = { ...body };
  delete payload.apiId; delete payload.contYn; delete payload.nextKey;
  for (const [k, v] of Object.entries(q)) {
    if (["apiId", "check", "contYn", "nextKey"].includes(k)) continue;
    payload[k] = v;
  }

  try {
    const out = await callKiwoom(apiId, payload, q.contYn || body.contYn, q.nextKey || body.nextKey);
    const rc = out.data && out.data.return_code;
    return res.status(200).json({
      ok: rc === 0 || rc === undefined,
      apiId,
      path: ALLOWED[apiId],
      sent: payload,
      returnCode: rc,
      returnMsg: out.data && out.data.return_msg,
      contYn: out.contYn,
      nextKey: out.nextKey,
      data: out.data,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, apiId, error: String(e.message || e) });
  }
}
