/**
 * seed 由来の期待件数 — 単一の真実源（TC-02）。
 *
 * integration（Prismaクエリ）と E2E（画面上の件数）双方がここを import し、二重ハードコードを避ける。
 * 値は `prisma/seed.ts` / `docs/dev-database.md` §4 に整合させること（seed変更時はここだけ更新）。
 *
 * 内訳（docs/dev-database.md §4）:
 *   Course=17 → LICENSE=11（通学10 + 合宿1）, DRONE=2, KENKI=1, ADDITIONAL=3（= programs 6）
 *   対応校: 岩滝×通学=9 / 網野×通学=7
 *   News=6（全 PUBLISHED, トップ最新は take 3）
 *   Faq=11（全 published）
 */
export const SEED_COUNTS = {
  course: {
    license: {
      total: 11, // published かつ category=LICENSE
      tsugaku: 10, // うち通学
      gasshuku: 1, // うち合宿
    },
    licenseBySchool: {
      iwatakiTsugaku: 9, // 岩滝 × 通学（普通自動二輪は網野のみ→除外）
      aminoTsugaku: 7, // 網野 × 通学（大型/普通二種/大型二種は岩滝のみ→除外）
    },
    programs: 6, // published かつ category ∈ {DRONE, KENKI, ADDITIONAL}
  },
  news: {
    published: 6, // status=PUBLISHED
    latestTake: 3, // トップ お知らせ最新 N 件
  },
  faq: {
    published: 11, // published=true
  },
} as const
