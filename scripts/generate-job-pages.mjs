// なんでも屋さん(旧jobchain/WorkChain)の求人データから、Googleしごと検索(Google for Jobs)と
// 求人アグリゲーター(Indeed・求人ボックスなど)向けの、クロール可能な
// 静的ページ/サイトマップ/フィードを自動生成するスクリプト。
//
// GitHub Actions(.github/workflows/generate-job-pages.yml)から
// 定期的に実行される想定。firebase-admin(サービスアカウント認証)で
// Firestoreのjobs/accountsコレクションを直接読み取り、
// リポジトリ内に静的ファイルを書き出す。
//
// 注意: このスクリプトはなんでも屋さん本体(index.html)のアプリ内ロジックには
// 一切手を加えない。あくまで検索エンジン向けの「もう1枚の入り口」を
// 追加で生成するだけで、実際の応募・チャットなどの操作は
// 必ずindex.html(本体アプリ)側で行われる。

import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ↓サイトのURLを変更した場合(ユーザー名変更やカスタムドメイン化など)は、
// 必ずここも書き換えること。
const SITE_BASE_URL = "https://ut181749ut.github.io/jobchain";
const SITE_NAME = "なんでも屋さん";

// この文字数未満しか説明文が書かれていない求人は、内容が薄すぎるため
// 検索エンジン向けページを作らない(質の低いページを量産するとサイト
// 全体の評価を下げかねないため)。アプリ本体では通常通り表示され続ける。
const MIN_DESCRIPTION_LENGTH = 20;

// 求人ごとのvalidThrough(有効期限)。実行のたびにこの日数だけ延長する。
// → もしこのワークフローが何らかの理由で動かなくなっても、この日数が
//    過ぎれば自動的に「掲載終了」とみなされ、古い求人が検索結果に
//    残り続ける事態を防げる(Googleのガイドライン上もこれが推奨されている)。
const VALID_THROUGH_DAYS = 7;

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// JSON.stringify()はHTMLの特殊文字(特に "</script" という並び)をエスケープしない。
// 求人タイトル・説明文はユーザーが自由に入力できる値なので、万一
// "</script>...<script>...</script>" のような文字列が含まれていた場合、
// そのままJSON-LDの<script>タグに埋め込むと、そこでタグが閉じられて
// 任意のHTML/スクリプトが注入されてしまう(XSS)。
// "<" を "<" に置き換えることで、有効なJSONのまま安全に埋め込める。
export function jsonLdToSafeScript(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

// XMLのCDATAセクションは "]]>" という並びが来るとそこで終了してしまう。
// ユーザー入力(求人タイトル・説明文など)に偶然この並びが含まれていても
// フィードのXML構造が壊れないよう、間に空白を入れて無害化する。
export function safeCdata(s) {
  return String(s ?? "").replace(/]]>/g, "]] >");
}

export function textToHtmlParagraphs(text) {
  const esc = escapeHtml(text || "");
  return esc
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// なんでも屋さん本体(index.html)の PAY_METHODS と同じ表示ロジック。
// 本体側の表記を変えた場合は、ここも合わせて更新すること。
const PAY_METHODS = {
  eth: { label: "ETH", fmt: (n) => Number(n).toFixed(4) + " ETH" },
  xmr: { label: "Monero (XMR)", fmt: (n) => Number(n).toFixed(4) + " XMR" },
  btc: { label: "Bitcoin (BTC)", fmt: (n) => Number(n).toFixed(6) + " BTC" },
  usdc: { label: "USDC", fmt: (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " USDC" },
  usdt: { label: "USDT", fmt: (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " USDT" },
  sol: { label: "Solana (SOL)", fmt: (n) => Number(n).toFixed(4) + " SOL" },
  card: { label: "カード / Apple Pay", fmt: (n) => "¥" + Number(n).toLocaleString("ja-JP") },
  cash: { label: "手渡し(現金)", fmt: (n) => "¥" + Number(n).toLocaleString("ja-JP") },
  other: { label: "その他", fmt: (n) => "¥" + Number(n).toLocaleString("ja-JP") },
};
export function payInfo(method) { return PAY_METHODS[method] || PAY_METHODS.eth; }

function initFirebaseAdmin() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    console.error("環境変数 FIREBASE_SERVICE_ACCOUNT が設定されていません(GitHub Actionsのsecretsを確認してください)。");
    process.exit(1);
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (e) {
    console.error("FIREBASE_SERVICE_ACCOUNT の中身がJSONとして読み込めませんでした。", e.message);
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

export function buildJobPageHtml(job, employerName, now) {
  const payLabel = payInfo(job.pay_method).label;
  const rewardText = payInfo(job.pay_method).fmt(job.reward);
  const location = (job.location || "").trim();
  const isRemote = !location || /オンライン|リモート|remote|在宅/i.test(location);
  const pageUrl = `${SITE_BASE_URL}/jobs/${job.id}.html`;
  const appUrl = `${SITE_BASE_URL}/#job-${job.id}`;
  const locationLabel = location || "オンライン/リモート";

  // ロングテールSEOを意識し、タイトル・meta descriptionに
  // 「職種名 × 勤務地 × 支払い方法」の組み合わせを自然に含める。
  const pageTitle = `${job.title}｜${locationLabel}の求人(${payLabel}払い) - ${SITE_NAME}`;
  const metaDescription = `${job.title}。勤務地: ${locationLabel}。報酬: ${rewardText}(${payLabel})。${SITE_NAME}に掲載中の求人です。`;

  const validThrough = new Date(now.getTime() + VALID_THROUGH_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const jobLocationFields = isRemote
    ? {
        jobLocationType: "TELECOMMUTE",
        applicantLocationRequirements: { "@type": "Country", name: "Japan" },
      }
    : {
        jobLocation: {
          "@type": "Place",
          address: { "@type": "PostalAddress", addressLocality: location, addressCountry: "JP" },
        },
      };

  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: textToHtmlParagraphs(job.description),
    identifier: { "@type": "PropertyValue", name: SITE_NAME, value: job.id },
    datePosted: job.created_at,
    validThrough,
    employmentType: ["OTHER"],
    hiringOrganization: { "@type": "Organization", name: employerName },
    directApply: false,
    ...jobLocationFields,
  };
  // 備考: 報酬(reward)はなんでも屋さんでは「単発の仕事1件あたりの固定報酬」であり、
  // schema.orgのbaseSalary(時給・日給・月給・年俸などの単位が前提)には
  // 正確に対応しないため、誤解を招く構造化データにしないよう、あえて
  // baseSalaryは出力していない。報酬額はページ本文とmeta descriptionに
  // 通常のテキストとして明記している。

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(metaDescription)}">
<link rel="canonical" href="${pageUrl}">
<script type="application/ld+json">${jsonLdToSafeScript(jsonLd)}</script>
<style>
  body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; max-width: 680px; margin: 0 auto; padding: 24px 18px 60px; line-height: 1.7; color: #1b1f24; background: #fffdf8; }
  .meta { color: #555; font-size: 14px; margin-bottom: 18px; }
  .meta span { display: inline-block; margin-right: 14px; }
  .reward { font-size: 20px; font-weight: 700; margin-bottom: 18px; }
  .apply-btn { display: inline-block; margin-top: 12px; padding: 12px 28px; background: #a8790a; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
  .back { display: inline-block; margin-top: 28px; font-size: 13px; color: #a8790a; }
  .desc p { margin: 0 0 1em; }
  footer { margin-top: 40px; font-size: 12px; color: #888; }
</style>
</head>
<body>
  <h1>${escapeHtml(job.title)}</h1>
  <div class="meta">
    <span>勤務地: ${escapeHtml(locationLabel)}</span>
    <span>支払い方法: ${escapeHtml(payLabel)}</span>
    <span>投稿者: ${escapeHtml(employerName)}</span>
  </div>
  <div class="reward">報酬: ${escapeHtml(rewardText)}</div>
  <div class="desc">${textToHtmlParagraphs(job.description)}</div>
  <a class="apply-btn" href="${appUrl}">この求人に応募する(${SITE_NAME}アプリで開く)</a>
  <br>
  <a class="back" href="${SITE_BASE_URL}/jobs/">← 求人一覧に戻る</a>
  <footer>このページは <a href="${SITE_BASE_URL}/">${SITE_NAME}</a> に掲載されている求人情報をもとに自動生成されています。応募・チャットなどの実際の操作は、上のボタンからアプリ内で行えます。</footer>
</body>
</html>
`;
}

async function main() {
  const db = initFirebaseAdmin();

  console.log("Firestoreから求人・アカウント情報を取得しています...");
  const [jobsSnap, accountsSnap] = await Promise.all([
    db.collection("jobs").get(),
    db.collection("accounts").get(),
  ]);

  const accountsById = new Map();
  accountsSnap.forEach((doc) => accountsById.set(doc.id, doc.data()));

  const now = new Date();
  const openJobs = [];
  jobsSnap.forEach((doc) => {
    const job = { id: doc.id, ...doc.data() };
    if (!job.is_open) return; // 締め切り済みの求人は検索向けページを作らない(=掲載終了として扱う)
    if (!job.description || job.description.trim().length < MIN_DESCRIPTION_LENGTH) return; // 内容が薄い求人は対象外
    openJobs.push(job);
  });
  console.log(`対象の求人: ${openJobs.length}件 / 全${jobsSnap.size}件`);

  const jobsDir = path.join(REPO_ROOT, "jobs");
  fs.rmSync(jobsDir, { recursive: true, force: true }); // 前回生成分をクリア(締め切られた求人のページを残さないため)
  fs.mkdirSync(jobsDir, { recursive: true });

  const sitemapEntries = [`${SITE_BASE_URL}/`, `${SITE_BASE_URL}/jobs/`];
  const indexEntries = [];

  for (const job of openJobs) {
    const employerAccount = accountsById.get(job.employer_id);
    // Googleの公式ガイドラインでは、匿名での採用の場合は
    // hiringOrganization.name に "confidential" を使うことが
    // 明示的に認められている。なんでも屋さんは匿名投稿が前提のため、
    // アカウントが削除済み/取得できない場合はこれに倣う。
    const employerName = (employerAccount && !employerAccount.is_deleted && employerAccount.name)
      ? employerAccount.name
      : "confidential";

    const html = buildJobPageHtml(job, employerName, now);
    fs.writeFileSync(path.join(jobsDir, `${job.id}.html`), html, "utf-8");

    sitemapEntries.push(`${SITE_BASE_URL}/jobs/${job.id}.html`);
    indexEntries.push({
      id: job.id,
      title: job.title,
      location: (job.location || "").trim() || "オンライン/リモート",
      rewardText: payInfo(job.pay_method).fmt(job.reward),
      pageUrl: `${SITE_BASE_URL}/jobs/${job.id}.html`,
    });
  }

  // 求人一覧のクローラブルなインデックスページ(サイトマップに加え、
  // 通常のリンクを辿るクローラーからも見つけてもらえるようにする)。
  const indexHtml = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>求人一覧 - ${SITE_NAME}</title>
<meta name="description" content="${SITE_NAME}に掲載中の求人の一覧です。">
<link rel="canonical" href="${SITE_BASE_URL}/jobs/">
<style>
  body { font-family: system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px 18px 60px; background: #fffdf8; color: #1b1f24; }
  ul { list-style: none; padding: 0; }
  li { border-bottom: 1px solid #e3e5e8; padding: 14px 0; }
  a { color: #a8790a; text-decoration: none; font-weight: 600; }
  .sub { color: #666; font-size: 13px; margin-top: 4px; }
</style>
</head>
<body>
  <h1>求人一覧</h1>
  ${indexEntries.length === 0 ? "<p>現在、募集中の求人はありません。</p>" : `<ul>
    ${indexEntries.map((e) => `<li><a href="${e.id}.html">${escapeHtml(e.title)}</a><div class="sub">${escapeHtml(e.location)} ・ ${escapeHtml(e.rewardText)}</div></li>`).join("\n    ")}
  </ul>`}
  <p><a href="${SITE_BASE_URL}/">← ${SITE_NAME}トップに戻る</a></p>
</body>
</html>
`;
  fs.writeFileSync(path.join(jobsDir, "index.html"), indexHtml, "utf-8");

  // sitemap.xml
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`;
  fs.writeFileSync(path.join(REPO_ROOT, "sitemap.xml"), sitemapXml, "utf-8");

  // robots.txt
  const robotsTxt = `User-agent: *\nAllow: /\nSitemap: ${SITE_BASE_URL}/sitemap.xml\n`;
  fs.writeFileSync(path.join(REPO_ROOT, "robots.txt"), robotsTxt, "utf-8");

  // 求人アグリゲーター向けの汎用XMLフィード。
  // Indeedなど「直接フィード連携(パートナー申請)」を受け付けている
  // サービスに申請する際の素材として使える、一般的なXML求人フィード形式。
  // ※この連携自体は各サービスへの申請・審査が必要で、ファイルを置くだけ
  //   では自動的には連携されない(詳しくはチャット内の説明を参照)。
  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<source>
  <publisher>${SITE_NAME}</publisher>
  <publisherurl>${SITE_BASE_URL}/</publisherurl>
  <lastBuildDate>${now.toUTCString()}</lastBuildDate>
${openJobs.map((job) => {
  const employerAccount = accountsById.get(job.employer_id);
  const employerName = (employerAccount && !employerAccount.is_deleted && employerAccount.name) ? employerAccount.name : "confidential";
  const location = (job.location || "").trim() || "Japan";
  return `  <job>
    <title><![CDATA[${safeCdata(job.title)}]]></title>
    <date><![CDATA[${safeCdata(job.created_at)}]]></date>
    <referencenumber><![CDATA[${safeCdata(job.id)}]]></referencenumber>
    <url><![CDATA[${SITE_BASE_URL}/jobs/${job.id}.html]]></url>
    <company><![CDATA[${safeCdata(employerName)}]]></company>
    <city><![CDATA[${safeCdata(location)}]]></city>
    <country><![CDATA[Japan]]></country>
    <description><![CDATA[${safeCdata(job.description)}]]></description>
  </job>`;
}).join("\n")}
</source>
`;
  fs.writeFileSync(path.join(REPO_ROOT, "job-feed.xml"), feedXml, "utf-8");

  console.log(`生成完了: 求人ページ ${openJobs.length}件 / sitemap.xml / robots.txt / job-feed.xml`);
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("生成処理でエラーが発生しました:", err);
    process.exit(1);
  });
}
