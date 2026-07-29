/**
 * 校舎情報（F-007 / F-020）。tech-stack のDB一覧に SchoolInfo は含めず、
 * functional §4.8 の方針どおり定数として保持する（管理編集はスコープ外）。
 * 構造化データ（DrivingSchool / LocalBusiness）の情報源にもなる。
 */

export type SchoolCode = 'IWATAKI' | 'AMINO'

export interface SchoolSns {
  instagram?: string
  x?: string
}

export interface SchoolInfo {
  code: SchoolCode
  name: string
  postalCode: string
  address: string
  phoneTollFree: string
  phoneDirect: string
  access: string
  geo: { lat: number; lng: number } | null
  features: string[]
  licenseTypes: string[]
  sns: SchoolSns
}

// 現行サイトの5特徴（top-page.md §2 / current-site-analysis.md §3）。両校共通の訴求。
const COMMON_FEATURES = [
  '指名制で教官を選べる',
  '女性教習指導員が在籍',
  'スマホから24時間予約',
  '柔軟なスケジュール（夜間教習対応）',
  'YouTubeで予習・復習',
]

export const SCHOOLS: Record<SchoolCode, SchoolInfo> = {
  IWATAKI: {
    code: 'IWATAKI',
    name: '岩滝校',
    postalCode: '629-2263',
    address: '京都府与謝郡与謝野町字弓木1459-1',
    phoneTollFree: '0120-46-4163',
    phoneDirect: '0772-46-4131',
    access: '岩滝口駅から徒歩20分',
    // geo は現行調査に緯度経度の記載が無いため住所ベースのプレースホルダ（構造化データはP5で確定）。
    geo: { lat: 35.5606, lng: 135.1573 },
    features: COMMON_FEATURES,
    licenseTypes: [
      '普通車',
      '準中型',
      '中型',
      '大型',
      '普通二種',
      '大型二種',
      'けん引',
      '大型特殊',
    ],
    sns: { instagram: 'iwatakidrivingschool', x: 'iwakyoiwakyo' },
  },
  AMINO: {
    code: 'AMINO',
    name: '網野校',
    postalCode: '629-3102',
    address: '京都府京丹後市網野町下岡522',
    phoneTollFree: '0120-07-2633',
    phoneDirect: '0772-72-2633',
    access: '網野駅から徒歩5分',
    geo: { lat: 35.6738, lng: 135.0286 },
    features: COMMON_FEATURES,
    licenseTypes: ['普通車', '準中型', '中型', 'けん引', '大型特殊', '普通自動二輪'],
    sns: { instagram: 'amikyo.6125', x: 'amikyoamikyo' },
  },
}
