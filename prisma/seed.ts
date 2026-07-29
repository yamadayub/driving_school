import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
// tsx 実行では `@/` エイリアスが解決されないため相対パスで読む（SEC-012）。
import { assertSeedAllowed } from '../lib/seed-guard'

/**
 * 岩滝・網野自動車教習所 — 開発用シード（`pnpm db:seed`）。
 *
 * データ源: docs/current-site-analysis.md（§4 コース料金 / §6 FAQ / §1 校舎）。
 * 方針:
 *  - 冪等（再実行で重複しない）: Course/News/Faq/SupplementalChatRule は deleteMany→create、
 *    AdminUser は email を natural key に upsert。Application/LicensePhoto/UploadToken は触らない。
 *  - REV-009: 合宿（GASSHUKU）とスクール系/追加講習の料金・日数は現行調査に出典が無いため
 *    「デモ用参考値」ラベルを description に明記したダミー値で投入する。
 *  - REV-003/RE-03: category=LICENSE のみ licenseType/licenseTypeLabel を持ち、transmission は
 *    ORDINARY のみ AT/MT。非LICENSE（DRONE/KENKI/ADDITIONAL）は programLabel で表示名を解決。
 *  - REV-001: ChatBot 一次ナレッジは公開 Faq。SupplementalChatRule は FAQに載らない料金/アクセス補助のみ。
 */

// --- .env ローダ（tsx は .env を自動読込しないため最小実装。既存 process.env を優先）---
function loadDotenv(path: string) {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadDotenv(resolve(process.cwd(), '.env'))

// --- パスワードハッシュ（デモ用。scrypt。方式は F-012 実装時に確定）---
// 形式: scrypt$<saltHex>$<hashHex>
function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

const prisma = new PrismaClient()

// ---------------------------------------------------------------------------
// Course データ
// ---------------------------------------------------------------------------
// 給付金タグ: 現行調査「給付金タグ（準中型/中型/大型等）」→ プロ免許系に付与。
// 助成金タグ: 現行調査「助成金タグ（ドローン/建機）」→ スクール系に付与。
const SUBSIDY_KYUFU = '教育訓練給付金'
const SUBSIDY_JOSEI = '助成金対象'
const DEMO_LABEL = '【デモ用参考値】'

type CourseSeed = Parameters<typeof prisma.course.create>[0]['data']

const licenseCourses: CourseSeed[] = [
  {
    category: 'LICENSE',
    licenseType: 'ORDINARY',
    licenseTypeLabel: '普通車（AT）',
    transmission: 'AT',
    format: 'TSUGAKU',
    minDays: 14,
    priceFrom: 225500,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [],
    description:
      '普通自動車AT限定の通学コース。料金は現行サイト表記の代表値（〜）。最短卒業日数はFAQ記載のAT最短14日。',
    published: true,
    sortOrder: 10,
  },
  {
    category: 'LICENSE',
    licenseType: 'ORDINARY',
    licenseTypeLabel: '普通車（MT）',
    transmission: 'MT',
    format: 'TSUGAKU',
    minDays: 15,
    priceFrom: 225500,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [],
    description: '普通自動車MTの通学コース。料金は現行サイトの普通車代表値（〜）。',
    published: true,
    sortOrder: 20,
  },
  {
    category: 'LICENSE',
    licenseType: 'SEMI_MEDIUM',
    licenseTypeLabel: '準中型',
    format: 'TSUGAKU',
    minDays: 7,
    priceFrom: 180400,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [SUBSIDY_KYUFU],
    description: '準中型免許の通学コース。',
    published: true,
    sortOrder: 30,
  },
  {
    category: 'LICENSE',
    licenseType: 'MEDIUM',
    licenseTypeLabel: '中型',
    format: 'TSUGAKU',
    minDays: 7,
    priceFrom: 151800,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [SUBSIDY_KYUFU],
    description: '中型免許の通学コース。',
    published: true,
    sortOrder: 40,
  },
  {
    category: 'LICENSE',
    licenseType: 'LARGE',
    licenseTypeLabel: '大型',
    format: 'TSUGAKU',
    minDays: 8,
    priceFrom: 239800,
    schools: ['IWATAKI'],
    subsidyTags: [SUBSIDY_KYUFU],
    description: '大型免許の通学コース（岩滝校）。',
    published: true,
    sortOrder: 50,
  },
  {
    category: 'LICENSE',
    licenseType: 'ORDINARY_2ND',
    licenseTypeLabel: '普通二種',
    format: 'TSUGAKU',
    minDays: 5,
    priceFrom: 217800,
    schools: ['IWATAKI'],
    subsidyTags: [SUBSIDY_KYUFU],
    description: '普通二種免許の通学コース（岩滝校）。',
    published: true,
    sortOrder: 60,
  },
  {
    category: 'LICENSE',
    licenseType: 'LARGE_SPECIAL',
    licenseTypeLabel: '大型特殊',
    format: 'TSUGAKU',
    minDays: 4,
    priceFrom: 114400,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [SUBSIDY_KYUFU],
    description: '大型特殊免許の通学コース。',
    published: true,
    sortOrder: 70,
  },
  {
    category: 'LICENSE',
    licenseType: 'TOWING',
    licenseTypeLabel: 'けん引',
    format: 'TSUGAKU',
    minDays: 7,
    priceFrom: 158400,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [SUBSIDY_KYUFU],
    description: 'けん引免許の通学コース。',
    published: true,
    sortOrder: 80,
  },
  {
    category: 'LICENSE',
    licenseType: 'LARGE_2ND',
    licenseTypeLabel: '大型二種',
    format: 'TSUGAKU',
    minDays: 8,
    priceFrom: 327800,
    schools: ['IWATAKI'],
    subsidyTags: [SUBSIDY_KYUFU],
    description: '大型二種免許の通学コース（岩滝校）。',
    published: true,
    sortOrder: 90,
  },
  {
    category: 'LICENSE',
    licenseType: 'MOTORCYCLE',
    licenseTypeLabel: '普通自動二輪',
    format: 'TSUGAKU',
    minDays: 9,
    priceFrom: 177100,
    schools: ['AMINO'],
    subsidyTags: [],
    description: '普通自動二輪免許の通学コース（網野校）。',
    published: true,
    sortOrder: 100,
  },
]

// 合宿（REV-009: デモ用参考値ダミー。US-001 の通学/合宿絞り込みE2Eが空表にならないよう最低1件）
const gasshukuCourses: CourseSeed[] = [
  {
    category: 'LICENSE',
    licenseType: 'ORDINARY',
    licenseTypeLabel: '普通車（AT）',
    transmission: 'AT',
    format: 'GASSHUKU',
    minDays: 14,
    priceFrom: 253000,
    schools: ['IWATAKI'],
    subsidyTags: [],
    description: `${DEMO_LABEL} 合宿免許（普通車AT）。料金・最短日数は現行 /camp/ 調査で後日確定（REV-009）。`,
    published: true,
    sortOrder: 200,
  },
]

// スクール系・追加講習（category=DRONE/KENKI/ADDITIONAL。licenseType/transmission/format=null）
const programCourses: CourseSeed[] = [
  {
    category: 'DRONE',
    programLabel: 'ドローン操縦（国家資格対応）',
    minDays: 2,
    priceFrom: 176000,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [SUBSIDY_JOSEI],
    description: `${DEMO_LABEL} ドローン操縦スクール。料金・日数は現行 /drone/ 調査で後日確定。`,
    published: true,
    sortOrder: 300,
  },
  {
    category: 'DRONE',
    programLabel: '農業用ドローン',
    minDays: 2,
    priceFrom: 143000,
    schools: ['AMINO'],
    subsidyTags: [SUBSIDY_JOSEI],
    description: `${DEMO_LABEL} 農業用ドローンスクール（/drone/agriculture/）。料金・日数は後日確定。`,
    published: true,
    sortOrder: 310,
  },
  {
    category: 'KENKI',
    programLabel: '建設機械（車両系建設機械）',
    minDays: 3,
    priceFrom: 88000,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [SUBSIDY_JOSEI],
    description: `${DEMO_LABEL} 建設機械講習（/construction/）。料金・日数は後日確定。`,
    published: true,
    sortOrder: 320,
  },
  {
    category: 'ADDITIONAL',
    programLabel: '高齢者講習',
    minDays: 1,
    priceFrom: 6450,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [],
    description: `${DEMO_LABEL} 高齢者講習（/senior/）。所要日数・料金は法定/現行運用で後日確定。`,
    published: true,
    sortOrder: 330,
  },
  {
    category: 'ADDITIONAL',
    programLabel: 'ペーパードライバー講習',
    minDays: 1,
    priceFrom: 16500,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [],
    description: `${DEMO_LABEL} ペーパードライバー講習（/beginner/）。時限数により料金変動。`,
    published: true,
    sortOrder: 340,
  },
  {
    category: 'ADDITIONAL',
    programLabel: '企業向け安全運転研修',
    minDays: 1,
    priceFrom: 22000,
    schools: ['IWATAKI', 'AMINO'],
    subsidyTags: [],
    description: `${DEMO_LABEL} 企業向け安全運転研修（/corporation/）。内容・料金は要相談。`,
    published: true,
    sortOrder: 350,
  },
]

const allCourses = [...licenseCourses, ...gasshukuCourses, ...programCourses]

// ---------------------------------------------------------------------------
// Faq データ（現行11件・4カテゴリ。keywords は ChatBot 照合用, REV-001）
// ---------------------------------------------------------------------------
type FaqSeed = Parameters<typeof prisma.faq.create>[0]['data']

const faqs: FaqSeed[] = [
  {
    category: 'SCHOOL',
    question: '送迎バスはありますか？',
    answer:
      '無料の送迎バスをご用意しています。主要駅・エリアを巡回しています。運行ルート・時刻は校舎ごとに異なりますのでお問い合わせください。',
    keywords: ['送迎', 'バス', '送迎バス', '無料', '駅'],
    published: true,
    sortOrder: 10,
  },
  {
    category: 'SCHOOL',
    question: '夜間の教習は何時まで受けられますか？',
    answer:
      '夜間の教習にも対応しています。お仕事や学校帰りにも通学いただけます。最終時限の時刻は校舎・時期により異なります。',
    keywords: ['夜間', '時間', '何時', '営業時間', '夜'],
    published: true,
    sortOrder: 20,
  },
  {
    category: 'SCHOOL',
    question: '何歳から入校できますか？',
    answer:
      '普通車は18歳の誕生日の1ヶ月前から入校いただけます（修了検定・卒業検定は18歳の誕生日以降）。',
    keywords: ['年齢', '何歳', '入校', '18歳', '誕生日'],
    published: true,
    sortOrder: 30,
  },
  {
    category: 'SCHOOL',
    question: '入校に必要な持ち物は何ですか？',
    answer:
      '本人確認書類（住民票または運転免許証）、印鑑、筆記用具、教習料金などが必要です。視力・色彩の適性検査もあります。詳しくは入校案内をご確認ください。',
    keywords: ['持ち物', '必要', '準備', '入校', '書類'],
    published: true,
    sortOrder: 40,
  },
  {
    category: 'COURSE',
    question: '最短で何日で卒業できますか？',
    answer:
      '普通車AT限定で最短14日程度が目安です。教習の予約状況やスケジュールにより前後します。短期集中プランもご相談ください。',
    keywords: ['最短', '何日', '短期', '卒業', '期間', '日数'],
    published: true,
    sortOrder: 50,
  },
  {
    category: 'COURSE',
    question: 'ATとMTのどちらがおすすめですか？',
    answer:
      '現在販売されている乗用車の多くはAT車のため、日常利用ではAT限定で十分な方が多いです。仕事でMT車を運転する予定がある方はMTをおすすめします。',
    keywords: ['AT', 'MT', 'おすすめ', '違い', '限定'],
    published: true,
    sortOrder: 60,
  },
  {
    category: 'PAYMENT',
    question: '料金の支払い方法・時期を教えてください。',
    answer:
      '入所日から1週間以内に、銀行振込または窓口でのお支払いをお願いしています。運転免許ローンをご利用の場合は入所日までにお手続きください。',
    keywords: ['支払い', '料金', '振込', 'ローン', '支払方法', '支払い方法'],
    published: true,
    sortOrder: 70,
  },
  {
    category: 'OTHER',
    question: '仕事や学校と両立して通えますか？',
    answer:
      '夜間教習・柔軟なスケジュール・スマホ予約に対応しており、働きながら・通学しながらでも無理なく通えます。',
    keywords: ['仕事', '両立', '働きながら', '学校', 'スケジュール'],
    published: true,
    sortOrder: 80,
  },
  {
    category: 'OTHER',
    question: '視力に条件はありますか？',
    answer:
      '普通車は両眼で0.7以上、片眼でそれぞれ0.3以上が必要です（眼鏡・コンタクト使用可）。基準に満たない場合はご相談ください。',
    keywords: ['視力', '目', '条件', '眼鏡', 'コンタクト'],
    published: true,
    sortOrder: 90,
  },
  {
    category: 'OTHER',
    question: '他府県の住民票でも入校できますか？',
    answer:
      '他府県にお住まいの方でも入校いただけます。卒業後の運転免許試験はお住まいの都道府県の運転免許試験場で受験します。',
    keywords: ['他府県', '住民票', '県外', '他県'],
    published: true,
    sortOrder: 100,
  },
  {
    category: 'OTHER',
    question: '外国籍でも入校できますか？',
    answer:
      '外国籍の方も入校いただけます。入校時に在留カード等で在留資格・氏名・住所を確認させていただきます。',
    keywords: ['外国籍', '在留カード', '外国人', '国籍'],
    published: true,
    sortOrder: 110,
  },
]

// ---------------------------------------------------------------------------
// News データ（カテゴリ IWATAKI/AMINO/DRONE/KENKI/COMMON、published）
// ---------------------------------------------------------------------------
type NewsSeed = Parameters<typeof prisma.news.create>[0]['data']

const news: NewsSeed[] = [
  {
    category: 'COMMON',
    title: '公式サイトをリニューアルしました',
    body: 'このたび岩滝校・網野校の公式サイトをリニューアルしました。お知らせ・料金・FAQをより見やすく、Webからのお申し込みにも対応しています。',
    status: 'PUBLISHED',
    publishedAt: new Date('2026-07-01T09:00:00+09:00'),
  },
  {
    category: 'IWATAKI',
    title: '【岩滝校】春の入校キャンペーンのお知らせ',
    body: '岩滝校では期間限定の入校キャンペーンを実施中です。詳しくは受付までお問い合わせください。',
    status: 'PUBLISHED',
    publishedAt: new Date('2026-04-03T10:00:00+09:00'),
  },
  {
    category: 'AMINO',
    title: '【網野校】普通自動二輪コース 好評受付中',
    body: '網野校では普通自動二輪の教習を受け付けています。網野駅から徒歩5分、通いやすい立地です。',
    status: 'PUBLISHED',
    publishedAt: new Date('2026-05-20T10:00:00+09:00'),
  },
  {
    category: 'DRONE',
    title: 'ドローンスクール 助成金対象コースのご案内',
    body: '国家資格対応のドローン操縦スクールを開講しています。助成金の対象となる場合があります。詳細はお問い合わせください。',
    status: 'PUBLISHED',
    publishedAt: new Date('2026-06-10T10:00:00+09:00'),
  },
  {
    category: 'KENKI',
    title: '建設機械講習 追加日程を公開しました',
    body: '車両系建設機械講習の追加日程を公開しました。企業様のまとめてのお申し込みもご相談ください。',
    status: 'PUBLISHED',
    publishedAt: new Date('2026-06-25T10:00:00+09:00'),
  },
  {
    category: 'COMMON',
    title: '年末年始の休業日のお知らせ',
    body: '誠に勝手ながら、年末年始は休業とさせていただきます。休業期間中のお申し込み・お問い合わせは翌営業日以降の対応となります。',
    status: 'PUBLISHED',
    publishedAt: new Date('2026-07-15T10:00:00+09:00'),
  },
  // F-014: 非公開(UNPUBLISHED)サンプル1件（管理一覧UIの状態バッジ確認用）。
  // 公開クエリからは除外されるため published 件数(=6)は増えない（seed-counts の前提を維持）。
  {
    category: 'IWATAKI',
    title: '【岩滝校】旧・夏期短期プランのご案内（掲載終了）',
    body: '掲載期間が終了したため、現在は非公開にしています。最新のプランは料金ページをご覧ください。',
    status: 'UNPUBLISHED',
    publishedAt: new Date('2026-06-01T10:00:00+09:00'),
  },
]

// ---------------------------------------------------------------------------
// SupplementalChatRule（FAQに載らない料金/アクセス補助のみ, REV-001）
// ---------------------------------------------------------------------------
type ChatRuleSeed = Parameters<typeof prisma.supplementalChatRule.create>[0]['data']

const chatRules: ChatRuleSeed[] = [
  {
    intent: 'price_lookup',
    patterns: ['普通車 料金', '普通車 いくら', '普通免許 値段', 'AT 料金'],
    reply:
      '普通車ATは225,500円〜（最短14日目安）です。MTも同料金帯からご案内しています。最新の料金・キャンペーンは料金ページをご覧ください。',
    sourceType: 'COURSE',
    linkUrl: '/tsugaku/',
  },
  {
    intent: 'price_lookup',
    patterns: ['大型 料金', '大型免許 いくら', '大型 値段'],
    reply: '大型免許は239,800円〜（岩滝校・最短8日目安）です。教育訓練給付金の対象となる場合があります。',
    sourceType: 'COURSE',
    linkUrl: '/heavy/',
  },
  {
    intent: 'access',
    patterns: ['岩滝 アクセス', '岩滝校 行き方', '岩滝口駅', '岩滝 場所'],
    reply:
      '岩滝校は京都府与謝郡与謝野町字弓木1459-1、岩滝口駅から徒歩約20分です。無料送迎バスもご利用いただけます。',
    sourceType: 'ACCESS',
    linkUrl: '/iwataki/',
  },
  {
    intent: 'access',
    patterns: ['網野 アクセス', '網野校 行き方', '網野駅', '網野 場所'],
    reply: '網野校は京都府京丹後市網野町下岡522、網野駅から徒歩約5分です。',
    sourceType: 'ACCESS',
    linkUrl: '/amino/',
  },
  {
    intent: 'bus',
    patterns: ['送迎 範囲', 'バス どこまで', '送迎 エリア', '送迎バス 時刻'],
    reply:
      '無料送迎バスは主要駅・エリアを巡回しています。運行ルート・時刻は校舎により異なりますので、お気軽にお問い合わせください。',
    sourceType: 'ACCESS',
  },
]

// ---------------------------------------------------------------------------
async function main() {
  console.log('seed: start')

  // SEC-012: 本番実行ガードと管理者資格情報の fail-fast。**deleteMany より前**に評価する。
  // 資格情報のハードコードフォールバックは廃止した（未設定なら実行そのものを止める）。
  const admin = assertSeedAllowed(process.env)

  // 冪等化: マスタ系を全削除→再投入（Application/LicensePhoto/UploadToken は保持）
  await prisma.$transaction([
    prisma.supplementalChatRule.deleteMany(),
    prisma.news.deleteMany(),
    prisma.faq.deleteMany(),
    // Course は Application.courseId から onDelete: SetNull 参照。application は seed で作らないため安全。
    prisma.course.deleteMany(),
  ])

  for (const data of allCourses) {
    await prisma.course.create({ data })
  }
  for (const data of faqs) {
    await prisma.faq.create({ data })
  }
  for (const data of news) {
    await prisma.news.create({ data })
  }
  for (const data of chatRules) {
    await prisma.supplementalChatRule.create({ data })
  }

  // SEC-012 修正方針3: update 節に passwordHash を含めない。既存管理者のパスワードを seed の
  // 再実行で黙って上書きしない（正しく運用中のアカウントを .env の値へ降格させないため）。
  // パスワードのローテーションは別コマンドに分離する。
  await prisma.adminUser.upsert({
    where: { email: admin.email },
    update: { name: admin.name, role: 'ADMIN' },
    create: {
      email: admin.email,
      name: admin.name,
      role: 'ADMIN',
      passwordHash: hashPassword(admin.password),
    },
  })

  // 件数検証ログ
  const [courseCount, licenseCount, faqCount, newsCount, chatRuleCount, adminCount] =
    await Promise.all([
      prisma.course.count(),
      prisma.course.count({ where: { category: 'LICENSE' } }),
      prisma.faq.count(),
      prisma.news.count(),
      prisma.supplementalChatRule.count(),
      prisma.adminUser.count(),
    ])

  console.log('seed: done — inserted counts:')
  console.log(`  Course               : ${courseCount} (LICENSE=${licenseCount}, その他=${courseCount - licenseCount})`)
  console.log(`  Faq                  : ${faqCount}`)
  console.log(`  News                 : ${newsCount}`)
  console.log(`  SupplementalChatRule : ${chatRuleCount}`)
  console.log(`  AdminUser            : ${adminCount} (${admin.email})`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
