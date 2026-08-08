import fs from "node:fs";
import vm from "node:vm";

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fail = msg => { console.error(`[실패] ${msg}`); process.exitCode = 1; };
const ok = msg => console.log(`[확인] ${msg}`);

for (const file of ["index.html", "sw.js", "manifest.json", "vercel.json", "data/market.json", "data/kiwoom.json", "data/briefs.json", "data/stocks.json", "data/collect_list.json", "data/automation_status.json", "vendor/chart.umd.js"]) {
  try { read(file); ok(`${file} 있음`); } catch { fail(`${file} 없음`); }
}

for (const file of ["manifest.json", "vercel.json", "data/market.json", "data/kiwoom.json", "data/briefs.json", "data/stocks.json", "data/collect_list.json", "data/automation_status.json"]) {
  try { JSON.parse(read(file)); ok(`${file} JSON 정상`); } catch (e) { fail(`${file} JSON 오류: ${e.message}`); }
}

try { new vm.Script(read("sw.js")); ok("sw.js 문법 정상"); } catch (e) { fail(`sw.js 문법 오류: ${e.message}`); }

try {
  const html = read("index.html");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).join("\n");
  new vm.Script(scripts);
  ok("index.html 안쪽 프로그램 문법 정상");
  if (html.includes("장중 실시간")) fail("실제보다 빠른 '장중 실시간' 표시가 남아 있음");
  if (!html.includes("약 5~8분 지연")) fail("지연 안내 문구가 없음");
  if (!html.includes("즐겨찾기최대 = 12")) fail("즐겨찾기 12개 제한이 없음");
} catch (e) { fail(`index.html 프로그램 오류: ${e.message}`); }

try {
  const market = JSON.parse(read("data/market.json"));
  const names = new Set((market.indices || []).map(x => x.nm));
  for (const name of ["KOSPI", "KOSDAQ", "S&P 500", "NASDAQ", "DOW"]) {
    if (!names.has(name)) fail(`market.json 필수 지수 누락: ${name}`);
  }
  if (!market.asOf) fail("market.json asOf 누락");
  ok("market.json 필수 항목 확인");
} catch {}

try {
  const k = JSON.parse(read("data/kiwoom.json"));
  if (!k.asOf) fail("kiwoom.json asOf 누락");
  if (!Array.isArray(k.체결강도)) fail("kiwoom.json 체결강도 배열 누락");
  ok("kiwoom.json 필수 항목 확인");
} catch {}

const publicText = ["index.html", "sw.js", "manifest.json", "vercel.json"].map(read).join("\n");
for (const pattern of [/KIWOOM_SECRET/i, /GITHUB_TOKEN/i, /github_pat_/i, /secretkey\s*[=:]/i]) {
  if (pattern.test(publicText)) fail(`공개 파일에 비밀값 이름 또는 형태가 발견됨: ${pattern}`);
}

if (!process.exitCode) console.log("[완료] 공개 전 자동검사를 통과했습니다.");
