import axios from "axios";
import * as cheerio from "cheerio";
import cron from "node-cron";
import dotenv from "dotenv";
import { parseStringPromise } from "xml2js";
import puppeteer from "puppeteer";
import OpenAI from "openai";
import { KEYWORDS } from "./keywords.js";
import express from "express";

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DART_API_KEY = process.env.DART_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_AI_SUMMARY = process.env.USE_AI_SUMMARY === "true";

const FAST_CHECK_MINUTES = Number(process.env.FAST_CHECK_MINUTES || 1);
const SLOW_CHECK_MINUTES = Number(process.env.SLOW_CHECK_MINUTES || 3);

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

const sentNews = new Set();

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
  Referer: "https://www.naver.com"
};

const FAST_SOURCES = [
  {
    name: "연합뉴스 RSS",
    type: "rss",
    url: "https://www.yna.co.kr/rss/economy.xml"
  }
];

const SLOW_SOURCES = [
  {
    name: "머니투데이 증권",
    type: "moneytoday",
    url: "https://news.mt.co.kr/newsList.html?pDepth1=stock"
  },
  {
    name: "이데일리 증권",
    type: "edaily",
    url: "https://www.edaily.co.kr/news/stock"
  },
  {
    name: "이데일리 경제",
    type: "edaily",
    url: "https://www.edaily.co.kr/news/economy"
  },
  {
    name: "네이버 경제",
    type: "naver",
    url: "https://news.naver.com/main/list.naver?mode=LSD&mid=sec&sid1=101"
  }
];

const KEYWORD_SCORES = {
  세계최초: 10,
  국내최초: 8,
  국내유일: 9,
  단독: 8,
  독점계약: 10,
  독점: 8,
  최초개발: 10,
  첫수출: 9,
  첫공급: 9,

  공급계약: 9,
  계약체결: 8,
  수주: 8,
  대규모: 7,
  투자유치: 8,
  지분투자: 7,
  "M&A": 8,
  인수: 7,
  합병: 7,

  FDA: 9,
  FDA승인: 10,
  품목허가: 9,
  임상성공: 10,
  임상3상: 9,
  임상2상: 7,
  임상1상: 5,
  치료제: 6,
  신약: 7,

  AI반도체: 8,
  AI: 5,
  인공지능: 5,
  반도체: 5,
  HBM: 7,
  로봇: 5,
  로봇산업: 6,
  "2차전지": 5,
  전고체: 7,
  원전: 6,
  방산: 6,
  양자: 6,
  초전도체: 7,
  자율주행: 5,
  데이터센터: 5,

  국책과제: 7,
  정부지원: 7,
  정부정책: 6,
  지원확대: 6,
  규제완화: 6,
  예산확대: 6,
  국가전략: 7,
  선정: 5,
  지정: 5,

  흑자전환: 8,
  실적개선: 7,
  어닝서프라이즈: 8,
  매출증가: 6,
  영업이익: 5,
  고성장: 6,
  매출: 3,

  급등: 6,
  강세: 5,
  부각: 5,
  수혜: 6,
  기대감: 4,
  테마: 4,
  주목: 4,

  MOU: 5,
  상용화: 8,
  특허: 6,
  신사업: 6,
  출시: 5,
  개발완료: 7
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(text) {
  return String(text || "").replace(/\s+/g, "");
}

function getTodayYYYYMMDD() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function containsMoneyKeyword(title) {
  const normalizedTitle = normalize(title);

  return KEYWORDS.filter((keyword) => {
    const normalizedKeyword = normalize(keyword);
    return normalizedTitle.includes(normalizedKeyword);
  });
}

function calculateNewsScore(title, matchedKeywords) {
  let score = 0;
  const normalizedTitle = normalize(title);

  for (const keyword of matchedKeywords) {
    const normalizedKeyword = normalize(keyword);
    score += KEYWORD_SCORES[keyword] || KEYWORD_SCORES[normalizedKeyword] || 1;
  }

  if (normalizedTitle.includes("상한가")) score += 10;
  if (normalizedTitle.includes("세계최초")) score += 5;
  if (normalizedTitle.includes("국내최초")) score += 4;
  if (normalizedTitle.includes("단독")) score += 4;

  return score;
}

function getNewsGrade(score) {
  if (score >= 18) return "🔥 상한가 후보";
  if (score >= 12) return "🚨 강한 재료";
  if (score >= 7) return "📈 관심 뉴스";
  return "📰 일반 뉴스";
}

function extractStockName(title) {
  const STOCK_SECTORS = {
    "AI/HBM/반도체": [
      "삼성전자", "SK하이닉스", "한미반도체", "리노공업", "이오테크닉스",
      "ISC", "HPSP", "주성엔지니어링", "원익IPS", "동진쎄미켐",
      "제우스", "피에스케이", "코미코", "하나마이크론", "네패스",
      "가온칩스", "오픈엣지테크놀로지", "칩스앤미디어",
      "퀄리타스반도체", "DB하이텍", "심텍", "대덕전자", "덕산하이메탈"
    ],
    "로봇/휴머노이드": [
      "레인보우로보틱스", "두산로보틱스", "로보스타", "유일로보틱스",
      "티로보틱스", "에스피시스템스", "뉴로메카", "로보티즈",
      "휴림로봇", "에브리봇", "케이엔알시스템", "고영", "삼익THK", "스맥"
    ],
    "바이오/FDA/신약": [
      "셀트리온", "삼성바이오로직스", "알테오젠", "HLB",
      "에이비엘바이오", "리가켐바이오", "유한양행", "한미약품",
      "펩트론", "보로노이", "에스티팜", "박셀바이오",
      "큐리옥스바이오시스템즈", "오스코텍", "신라젠", "차바이오텍"
    ],
    방산: [
      "한화에어로스페이스", "LIG넥스원", "현대로템", "한국항공우주",
      "풍산", "빅텍", "퍼스텍", "휴니드", "한화시스템"
    ],
    원전: [
      "두산에너빌리티", "한전기술", "한전KPS", "우진", "보성파워텍",
      "비에이치아이", "우리기술", "일진파워", "서전기전"
    ],
    "양자/보안": [
      "엑스게이트", "케이씨에스", "드림시큐리티", "우리넷",
      "코위버", "쏠리드", "아이씨티케이", "한국정보인증"
    ],
    "자율주행/AI모빌리티": [
      "현대차", "기아", "모트렉스", "팅크웨어", "스마트레이더시스템",
      "퓨런티어", "라이콤", "라닉스", "모바일어플라이언스"
    ],
    "2차전지/전고체": [
      "에코프로", "에코프로비엠", "포스코퓨처엠", "금양", "엘앤에프",
      "LG에너지솔루션", "삼성SDI", "SK이노베이션", "씨아이에스",
      "레이크머티리얼즈", "나노신소재", "천보", "대주전자재료"
    ],
    "데이터센터/클라우드": [
      "네이버", "NAVER", "카카오", "NHN", "더존비즈온", "가비아",
      "케이아이엔엑스", "모아데이타", "플리토", "솔트룩스",
      "폴라리스오피스", "엑셈"
    ]
  };

  const bracketMatch = title.match(/\[(.*?)\]/);
  if (bracketMatch) return bracketMatch[1];

  for (const sector in STOCK_SECTORS) {
    for (const stock of STOCK_SECTORS[sector]) {
      if (title.includes(stock)) {
        return `${stock} (${sector})`;
      }
    }
  }

  return null;
}

function summarizeNewsFree(newsTitle, matchedKeywords, score, grade, stockName) {
  const title = newsTitle.replace(/\s+/g, " ").trim();

  let reason = "시장 관심 키워드가 포함된 뉴스입니다.";

  if (title.includes("공급계약") || title.includes("수주") || title.includes("계약체결")) {
    reason = "매출 발생 가능성이 있는 계약성 재료로 시장 관심을 받을 수 있습니다.";
  } else if (title.includes("세계최초") || title.includes("국내최초") || title.includes("최초")) {
    reason = "최초 타이틀이 포함된 기술·사업 이슈로 테마성 관심이 붙을 수 있습니다.";
  } else if (title.includes("FDA") || title.includes("임상") || title.includes("품목허가") || title.includes("신약")) {
    reason = "바이오 인허가·임상 관련 이슈로 주가 변동성이 커질 수 있습니다.";
  } else if (title.includes("AI") || title.includes("반도체") || title.includes("HBM")) {
    reason = "AI·반도체 관련 성장 테마와 연결될 수 있는 뉴스입니다.";
  } else if (title.includes("로봇") || title.includes("휴머노이드")) {
    reason = "로봇·자동화 테마와 연결되어 시장 관심을 받을 수 있습니다.";
  } else if (title.includes("방산") || title.includes("수출")) {
    reason = "방산·수출 관련 재료로 실적 기대감이 반영될 수 있습니다.";
  } else if (title.includes("원전")) {
    reason = "원전 정책·수주 테마와 연결될 수 있는 뉴스입니다.";
  } else if (title.includes("흑자전환") || title.includes("실적개선") || title.includes("영업이익")) {
    reason = "실적 개선 재료로 투자자 관심을 받을 수 있습니다.";
  } else if (title.includes("정부지원") || title.includes("국책과제") || title.includes("선정")) {
    reason = "정부 정책·지원 사업과 연결된 재료로 해석될 수 있습니다.";
  }

  const stockText = stockName ? `${stockName} 관련 뉴스로, ` : "";

  return `${stockText}${reason}`;
}

async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false
    });

    console.log("✅ 텔레그램 전송 완료");
    await sleep(1500);
  } catch (error) {
    if (error.response?.status === 429) {
      const retryAfter = error.response.data?.parameters?.retry_after || 40;
      console.log(`⏳ 텔레그램 제한 발생, ${retryAfter}초 대기 후 재시도`);
      await sleep((retryAfter + 2) * 1000);
      return sendTelegramMessage(message);
    }

    console.error("❌ 텔레그램 전송 실패:", error.message);
  }
}

async function fetchDartDisclosures() {
  if (!DART_API_KEY) {
    console.log("⚠️ DART_API_KEY 없음 - DART 공시 생략");
    return [];
  }

  try {
    const today = getTodayYYYYMMDD();

    const response = await axios.get("https://opendart.fss.or.kr/api/list.json", {
      params: {
        crtfc_key: DART_API_KEY,
        bgn_de: today,
        end_de: today,
        page_count: 30
      },
      timeout: 10000
    });

    if (!response.data.list) return [];

    return response.data.list.map((item) => ({
      source: "DART 공시",
      title: `[${item.corp_name}] ${item.report_nm}`,
      link: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
      urgent: true
    }));
  } catch (error) {
    console.error("❌ DART 수집 실패:", error.message);
    return [];
  }
}

async function fetchRssNews(source) {
  try {
    const response = await axios.get(source.url, {
      headers: COMMON_HEADERS,
      timeout: 10000
    });

    const parsed = await parseStringPromise(response.data);
    const items = parsed.rss.channel[0].item || [];

    return items.slice(0, 30).map((item) => ({
      source: source.name,
      title: item.title?.[0] || "",
      link: item.link?.[0] || "",
      urgent: true
    }));
  } catch (error) {
    console.error(`❌ ${source.name} 수집 실패:`, error.message);
    return [];
  }
}

async function fetchNaverNews(source) {
  try {
    const response = await axios.get(source.url, {
      headers: COMMON_HEADERS,
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const newsList = [];

    $("ul.type06_headline li, ul.type06 li").each((_, element) => {
      const titleElement = $(element).find("dt:not(.photo) a").first();
      const title = titleElement.text().replace(/\s+/g, " ").trim();
      const link = titleElement.attr("href");

      if (title && link) {
        newsList.push({
          source: source.name,
          title,
          link,
          urgent: false
        });
      }
    });

    return newsList;
  } catch (error) {
    console.error(`❌ ${source.name} 수집 실패:`, error.message);
    return [];
  }
}

async function fetchMoneyTodayNews(source) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setUserAgent(COMMON_HEADERS["User-Agent"]);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "ko-KR,ko;q=0.9",
      Referer: "https://www.naver.com"
    });

    await page.goto(source.url, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    const html = await page.content();
    const $ = cheerio.load(html);
    const newsList = [];
    const seenLinks = new Set();

    $("a").each((_, element) => {
      const title = $(element).text().replace(/\s+/g, " ").trim();
      let link = $(element).attr("href");

      if (!title || title.length < 10 || title.length > 100) return;
      if (!link) return;

      if (link.startsWith("/")) {
        link = `https://news.mt.co.kr${link}`;
      }

      if (!link.includes("news.mt.co.kr")) return;
      if (seenLinks.has(link)) return;

      seenLinks.add(link);

      newsList.push({
        source: source.name,
        title,
        link,
        urgent: false
      });
    });

    return newsList.slice(0, 30);
  } catch (error) {
    console.error(`❌ ${source.name} Puppeteer 수집 실패:`, error.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchEdailyNews(source) {
  try {
    const response = await axios.get(source.url, {
      headers: COMMON_HEADERS,
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const newsList = [];
    const seenLinks = new Set();

    $("a").each((_, element) => {
      const title = $(element).text().replace(/\s+/g, " ").trim();
      let link = $(element).attr("href");

      if (!title || title.length < 10 || title.length > 100) return;
      if (!link) return;

      if (link.startsWith("/")) {
        link = `https://www.edaily.co.kr${link}`;
      }

      if (!link.includes("edaily.co.kr")) return;
      if (seenLinks.has(link)) return;

      seenLinks.add(link);

      newsList.push({
        source: source.name,
        title,
        link,
        urgent: false
      });
    });

    return newsList.slice(0, 30);
  } catch (error) {
    console.error(`❌ ${source.name} 수집 실패:`, error.message);
    return [];
  }
}

async function fetchBySource(source) {
  if (source.type === "rss") return fetchRssNews(source);
  if (source.type === "naver") return fetchNaverNews(source);
  if (source.type === "moneytoday") return fetchMoneyTodayNews(source);
  if (source.type === "edaily") return fetchEdailyNews(source);
  return [];
}

async function processNewsList(newsList, modeName) {
  let sentCount = 0;

  for (const news of newsList) {
    if (!news.title || !news.link) continue;
    if (sentNews.has(news.link)) continue;

    const matchedKeywords = containsMoneyKeyword(news.title);
    if (matchedKeywords.length === 0) continue;

    const score = calculateNewsScore(news.title, matchedKeywords);
    const grade = getNewsGrade(score);
    const stockName = extractStockName(news.title);

    const aiSummary = summarizeNewsFree(
      news.title,
      matchedKeywords,
      score,
      grade,
      stockName
    );

    sentNews.add(news.link);
    sentCount++;

    const header = news.urgent
      ? "🚨 <b>[초긴급] 돈 되는 정보 감지</b>"
      : "📢 <b>[일반] 돈 되는 뉴스 감지</b>";

    const message =
      `${header}\n\n` +
      `🏷 등급: <b>${grade}</b>\n` +
      `📊 점수: <b>${score}점</b>\n` +
      (stockName ? `🏢 종목: <b>${stockName}</b>\n` : "") +
      `📌 출처: <b>${news.source}</b>\n` +
      `📰 <b>${news.title}</b>\n\n` +
      (aiSummary ? `🤖 AI 요약:\n${aiSummary}\n\n` : "") +
      `🔑 키워드: ${matchedKeywords.join(", ")}\n\n` +
      `🔗 ${news.link}`;

    await sendTelegramMessage(message);
  }

  console.log(`🟢 ${modeName} 완료 / 수집 ${newsList.length}건 / 전송 ${sentCount}건\n`);
}

async function checkFastSources() {
  console.log("⚡ 빠른 소스 감시 시작:", new Date().toLocaleString());

  let allNews = [];

  const dartNews = await fetchDartDisclosures();
  allNews = allNews.concat(dartNews);

  const rssResults = await Promise.all(
    FAST_SOURCES.map((source) => fetchBySource(source))
  );

  for (const list of rssResults) {
    allNews = allNews.concat(list);
  }

  await processNewsList(allNews, "빠른 소스");
}

async function checkSlowSources() {
  console.log("🟡 일반 뉴스 감시 시작:", new Date().toLocaleString());

  let allNews = [];

  const results = await Promise.all(
    SLOW_SOURCES.map((source) => fetchBySource(source))
  );

  for (const list of results) {
    allNews = allNews.concat(list);
  }

  await processNewsList(allNews, "일반 뉴스");
}

function startBot() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ .env에 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID를 입력하세요.");
    process.exit(1);
  }

  console.log("🚀 돈 되는 정보 자동 감시 봇 실행");
  console.log(`⚡ 빠른 소스: ${FAST_CHECK_MINUTES}분마다`);
  console.log(`🟡 일반 뉴스: ${SLOW_CHECK_MINUTES}분마다\n`);

  checkFastSources();
  checkSlowSources();

  cron.schedule(`*/${FAST_CHECK_MINUTES} * * * *`, () => {
    checkFastSources();
  });

  cron.schedule(`*/${SLOW_CHECK_MINUTES} * * * *`, () => {
    checkSlowSources();
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Money News Bot is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "running",
    fastCheckMinutes: FAST_CHECK_MINUTES,
    slowCheckMinutes: SLOW_CHECK_MINUTES,
    time: new Date().toLocaleString()
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

startBot();