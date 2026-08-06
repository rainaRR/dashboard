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

/* ── 접근토큰 ─────────────────────────────────────────────
   토큰은 하루짜리입니다. 함수 인스턴스가 살아 있는 동안 재사용합니다.
   키움은 토큰 발급 횟수에 제한이 있어 매번 새로 받으면 안 됩니다. */
let cachedToken = null;
let cachedUntil = 0;
let lastTokenShape = null;   // 어느 이름으로 성공했는지 기록

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedUntil) return cachedToken;

  const key = process.env.KIWOOM_APP_KEY;
  const secret = process.env.KIWOOM_SECRET;
  if (!key || !secret) {
    throw new Error("환경변수 KIWOOM_APP_KEY 또는 KIWOOM_SECRET 이 없습니다");
  }

  // 키움이 기다리는 항목 이름이 문서마다 다르게 적혀 있습니다.
  // secretkey 를 먼저 쓰고, 안 되면 appsecretkey 로 한 번 더 시도합니다.
  const 후보 = [
    { grant_type: "client_credentials", appkey: key, secretkey: secret },
    { grant_type: "client_credentials", appkey: key, appsecretkey: secret },
  ];

  let token = null, 마지막오류 = "", 성공한형식 = "";
  for (const payload of 후보) {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); }
    catch (e) { 마지막오류 = `토큰 응답이 JSON이 아닙니다 (HTTP ${r.status}): ${text.slice(0, 200)}`; continue; }

    // 키움은 성공 시 return_code 0, 토큰은 token 필드에 담겨 옵니다
    const t = j.token || j.access_token;
    if (t) {
      token = t;
      성공한형식 = Object.keys(payload).find(k => k !== "grant_type" && k !== "appkey");
      lastTokenShape = 성공한형식;
      var 응답 = j;
      break;
    }
    마지막오류 = `[${j.return_code}] ${j.return_msg || text.slice(0, 200)}`;
  }

  if (!token) {
    throw new Error(`토큰 발급 실패 ${마지막오류}`);
  }
  const j = 응답;

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  const body = (req.method === "POST" && req.body) ? req.body : {};

  // ── 점검 모드: 설정이 제대로 됐는지만 확인 ──
  if (q.check === "1") {
    try {
      await getToken();
      return res.status(200).json({
        ok: true,
        message: "키움 접속 정상. 접근토큰을 받았습니다.",
        server: "실전투자 (api.kiwoom.com)",
        토큰항목이름: lastTokenShape,
        allowedApis: Object.keys(ALLOWED),
        note: "주문 계열 API는 허용 목록에 없어 호출할 수 없습니다.",
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: String(e.message || e),
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
