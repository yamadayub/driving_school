/**
 * フォームセッション Cookie の生成・署名・検証（AC-RL-13 (a)(b)(d)）。
 *
 * ------------------------------------------------------------------------
 * この単位で満たす範囲（ここを広げないこと / RV-P3DR-010）
 * ------------------------------------------------------------------------
 * **発行の配線（`GET /apply` の `Set-Cookie`）と発行の流量制限（(c) 30回/10分）は P3-b** である
 * （`/apply` が P3-b の成果物のため）。P3-a で満たすのは**値の生成・署名・検証ロジック**だけである。
 *
 * ------------------------------------------------------------------------
 * この Cookie が担う役割
 * ------------------------------------------------------------------------
 *  - **軸**: `trusted=false`（＝ per-source ゲートが使えない）環境で残る防御の1つ（AC-RL-3）。
 *    Cookie が**無い・壊れている・期限切れ**のリクエストは**素通りさせず Tier B へ降格**する。
 *    「同一 Cookie の4回目が拒否される」だけを守っても、攻撃者は Cookie を送らないので意味が無い。
 *  - **送信間隔下限（AC-RL-6）の基準**: 署名済み `issuedAt` が唯一の信頼できる起点である。
 *    クライアントが送る `formRenderedAt` 相当の値は判定に使わない。
 *
 * 鍵は `FORM_SESSION_SECRET` を **HKDF で用途別に導出**したものを使う（`tech-stack.md` §4.6）。
 * `AUTH_SECRET` をそのまま流用すると、片方の漏えいがセッション JWT とフォーム Cookie の両方に波及する。
 */

import { createHash, createHmac, hkdfSync, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Cookie 名。`__Host-` 接頭辞は「Secure かつ Path=/ かつ Domain 無し」をブラウザに強制させる
 * ——サブドメインからの上書き（Cookie tossing）で軸を無効化されないため。
 */
export const FORM_SESSION_COOKIE_NAME = '__Host-fs'

declare const perRequesterKeyBrand: unique symbol

/**
 * **要求元ごとに一意**であることを型で表す（SEC-052 / P3b-1b）。
 *
 * ------------------------------------------------------------------------
 * なぜ「型」でなければならないのか
 * ------------------------------------------------------------------------
 * 監査は `formSessionKey: (request) => request.cookies.get(name)?.value ?? 'anonymous'` という
 * **現実に書かれうる配線**で、`trusted=true` の通常構成でも「攻撃者が3回送ると無関係な利用者が
 * 429」になることを実測した。`formSessionKey` の戻り値が素の `string` である限り、この配線は
 * 型検査も既存テストも通る。
 *
 * SEC-021 → SEC-029 → SEC-030 → SEC-043 と **4 度**、名指しの警告コメントでは止められなかった。
 * したがって**共有キーを返せない型**にする以外に手段がない——`'anonymous'` のようなリテラルは
 * `PerRequesterKey` へ代入できず、`pnpm type-check` で落ちる。
 *
 * **この型を `as` でキャストして回避する経路だけが残る**ため、
 * `tests/unit/applications-route-contract.test.ts` がルートにキャストが無いことをソースで固定する。
 */
export type PerRequesterKey = string & { readonly [perRequesterKeyBrand]: true }

/** 署名部の長さ（base64url(HMAC-SHA256 32B) = 43 文字。パディング無し）。 */
export const FORM_SESSION_SIGNATURE_LENGTH = 43

/** Cookie 値全体の受理上限。これを超える値には軸キーを作らない（P3b-11 / SEC-055）。 */
export const FORM_SESSION_VALUE_MAX_LENGTH = 512

/** `sid` のバイト数（128bit）。hex で 32 文字になる。 */
const SID_BYTES = 16

/** Cookie の寿命（秒）。フォーム入力にかかる現実的な時間を見込んだ 30 分。 */
export const FORM_SESSION_MAX_AGE_SEC = 1_800

const MAX_AGE_MS = FORM_SESSION_MAX_AGE_SEC * 1000

/** HKDF の用途ラベル。**導出元が同じでもラベルが違えば別の鍵になる**（用途分離の実体）。 */
const HKDF_INFO = 'driving-school/form-session/v1'

/**
 * **未検証の印**（SEC-057）を表す HKDF ラベル（SEC-068）。
 *
 * 印は payload に**平文で書かない**——書くと非ブラウザのクライアント（curl / スクリプト）が
 * 自分の `Set-Cookie` をデコードするだけで「無コスト枠を使い切ったか」を確実に判定でき、
 * **SEC-067 の DoS を最小コストで維持できる状態オラクル**になる。
 * さらに「窓内で何枚目から印が付くか」を二分探索すれば
 * **当該 10 分窓の `/apply` 来訪者数を推定**できる（弱いトラフィック量の側路）。
 * Cookie は `HttpOnly` だが、**`HttpOnly` は非ブラウザには効かない。**
 *
 * そこで印を**署名鍵のラベル**へ移した。クライアントに渡る payload は印の有無で
 * **1 バイトも変わらず**、署名部の長さも変わらない（どちらも base64url(HMAC-SHA256) = 43 文字）。
 * サーバーは検証時に**両方のラベルで試す**ことで印を検出できる。
 *
 * この形なら**印の剥離も偽造もできない**（署名は payload 全体を覆ったままで、
 * 印を外すには「検証済みラベルでの正しい署名」＝ 鍵が必要になる）。
 * 既存形式（印なし）の値は `HKDF_INFO` のままなので**後方互換も保たれる**。
 */
const HKDF_INFO_UNVERIFIED = 'driving-school/form-session/unverified/v1'
const HKDF_SALT = 'driving-school/form-session/salt/v1'
const DERIVED_KEY_LENGTH = 32

/**
 * 残りがこの時間を切ったら再発行する（更新窓 / NEW-003）。
 *
 * SEC-067 の是正で「有効な Cookie を持つ再訪には発行しない」ようにした結果、
 * **有効な Cookie がある限り二度と更新されない** ⇒ 初回訪問から
 * `FORM_SESSION_MAX_AGE_SEC`（30 分）で必ず失効し、入力途中の利用者が Tier B に落ちる。
 * 従来は `/apply` を開くたびに新しい Cookie が出ていたので**実質的に更新されていた**。
 *
 * 再監査 §5 申し送り 1 は P3-c2 について
 * 「写真アップロードは申込フォームより**滞在時間が長く、Cookie 寿命との競合が起きやすい**」と
 * 名指ししており、SEC-067（可用性）の修正がその弱点を**強める方向に働く**。
 * そこで「有効」の意味を「**有効かつ失効間近でない**」に限定する。
 */
export const FORM_SESSION_RENEW_BEFORE_MS = 600_000

export interface FormSessionPayload {
  /** フォームセッション識別子。**資格情報的な性質を持つのでログに出さない**（AC-PII-1）。 */
  sid: string
  /** 発行時刻（epoch ms）。AC-RL-6 の送信間隔判定の基準を兼ねる。 */
  issuedAt: number
  /**
   * **無コストで発行された印**（SEC-057）。`true` の値は**検証を通さない**（＝ Tier B へ落ちる）。
   *
   * ------------------------------------------------------------------------
   * なぜ「一意性」ではなく「入手コスト」なのか
   * ------------------------------------------------------------------------
   * P3b-1b は Cookie 軸が要求元ごとに一意であることを型（`PerRequesterKey`）で保証した。
   * しかし監査（SEC-057）が実測したのは、**縮退構成（`trusted=false`）では発行がタダなので、
   * 攻撃者が Cookie を 20 枚取り直すだけで送信側の上限（3回/10分）が丸ごと消える**ことだった:
   *
   * > **軸として機能するために必要なのは「一意であること」ではなく「入手にコストがあること」。**
   *
   * 一意性は型で表せるが、入手コストは型では表せない——**値の形**は書けても
   * **値を得るために攻撃者が払う量**は書けないからである。したがってコストは
   * 「無コスト枠を超えて発行した値には印を付け、その値では本体へ到達させない」という
   * **振る舞い**として実装する（発行そのものは止めない / `lib/form-session-issue.ts`）。
   *
   * ------------------------------------------------------------------------
   * 既定は「検証済み」であること（後方互換 / opt-in）
   * ------------------------------------------------------------------------
   * このフィールドが**無い値は従来どおり検証を通る**。既定を「未検証」にすると、
   * 既存の Cookie（および手組みの Cookie に依存する結合テスト）が一斉に無効化され、
   * 「テストのほうを直す」圧力が生まれる。コストの印は**足す側**に置く。
   */
  unverified?: true
}

export interface FormSessionCookieAttributes {
  httpOnly: true
  secure: true
  sameSite: 'lax'
  path: '/'
  maxAge: number
}

/**
 * Cookie 属性（AC-RL-13(a)）。
 *
 *  - `httpOnly`: XSS で `sid` を読めなくする。
 *  - `secure` + `__Host-`: 平文経路での漏えいとサブドメインからの上書きを塞ぐ。
 *  - `sameSite: 'lax'`: **`'none'` にすると クロスサイトから Cookie 軸を使えてしまい、軸として
 *    機能しなくなる**（攻撃者が自分のサイトから被害者の Cookie を使って送信できる）。
 */
export function formSessionCookieAttributes(): FormSessionCookieAttributes {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: FORM_SESSION_MAX_AGE_SEC,
  }
}

/**
 * Cookie 署名鍵を用途別に導出する（`tech-stack.md` §4.6）。
 * 入力シークレットそのものは返さない——返すと `AUTH_SECRET` を直接署名鍵に使う実装と等価になる。
 */
export function deriveFormSessionKey(secret: string): Uint8Array {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, DERIVED_KEY_LENGTH))
}

/** 未検証の印を表す署名鍵（SEC-068）。**同じシークレットから別のラベルで導出する。** */
function deriveUnverifiedFormSessionKey(secret: string): Uint8Array {
  return Buffer.from(
    hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO_UNVERIFIED, DERIVED_KEY_LENGTH),
  )
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function sign(payloadPart: string, secret: string, unverified = false): string {
  const key = unverified ? deriveUnverifiedFormSessionKey(secret) : deriveFormSessionKey(secret)
  return createHmac('sha256', key).update(payloadPart).digest('base64url')
}

/**
 * Cookie 値を生成する。形式は `<base64url(JSON payload)>.<base64url(HMAC)>`。
 *
 * **署名対象は payload 全体**（`sid` と `issuedAt` の両方）である。`issuedAt` を署名対象から外すと、
 * 攻撃者はそれを過去に書き換えるだけで AC-RL-6 の送信間隔下限を回避できる。
 *
 * **未検証の印（SEC-057）は payload に書かず、署名鍵のラベルで表す**（SEC-068 / `HKDF_INFO_UNVERIFIED`）。
 * 印の有無で payload は 1 バイトも変わらず、署名部の長さも変わらないので、
 * **クライアントからは印の有無を判別できない**。
 */
export function createFormSessionValue(payload: FormSessionPayload, secret: string): string {
  // **payload は常に同じ形**（`sid` / `issuedAt` のみ）。印を書き足すと値の長さと中身が変わり、
  // クライアントから読める状態オラクルになる（SEC-068）。既存形式ともバイト単位で一致する。
  const payloadPart = encode(JSON.stringify({ sid: payload.sid, issuedAt: payload.issuedAt }))
  return `${payloadPart}.${sign(payloadPart, secret, payload.unverified === true)}`
}

/**
 * 有効だが**失効間近**か（＝ 再発行すべきか / NEW-003）。
 *
 * **判定はここに置く**（AC-RL-8）。`app/api/form-session/route.ts` に式を書くと判定の複製になり、
 * 更新窓を変えたときに片方だけが残る。
 */
export function isFormSessionRenewable(payload: FormSessionPayload, now: number): boolean {
  return payload.issuedAt + MAX_AGE_MS - now < FORM_SESSION_RENEW_BEFORE_MS
}

/**
 * Cookie 値を検証する。**不正・期限切れは例外ではなく `null`** を返す。
 *
 * 500 にしてしまうと「劣化（Tier B）」ではなく「失敗」になり、正当な利用者が原因不明のエラーに
 * 遭う（Cookie が壊れる経路は攻撃だけではない）。呼び出し側は `null` を Tier B へ落とす。
 */
export function verifyFormSessionValue(
  value: string | null | undefined,
  secret: string,
  now: number,
): FormSessionPayload | null {
  if (!value) return null

  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [payloadPart, providedSignature] = parts
  if (payloadPart.length === 0 || providedSignature.length === 0) return null

  // 長さが違うと `timingSafeEqual` が throw するため、先に長さで弾く（長さは秘密ではない）。
  //
  // **判定は「JS 文字列長」ではなく「バイト長」で行う**（SEC-042 / `lib/cron-auth.ts` と同じ形）。
  // `String.prototype.length` は UTF-16 コードユニット数、`timingSafeEqual` が見るのは UTF-8 バイト数で、
  // 攻撃者が Cookie の 1 文字をマルチバイト文字（`é` / `あ` / 絵文字 / 孤立サロゲート）に置き換えるだけで
  // 両者はずれる。ずれたまま比較へ入ると `RangeError: Input buffers must have the same byte length` が
  // 投げられ、**未認証の攻撃者が任意に 500 を起こせる**（Tier B へ降格すべきリクエストが失敗になる）。
  // `try/catch` で握り潰さないのは、比較に到達しなかった入力と「署名不一致」を区別できなくなるため。
  const provided = Buffer.from(providedSignature, 'utf8')
  const signatureMatches = (expected: string): boolean => {
    const expectedBytes = Buffer.from(expected, 'utf8')
    if (provided.length !== expectedBytes.length) return false
    return timingSafeEqual(provided, expectedBytes)
  }

  if (!signatureMatches(sign(payloadPart, secret))) {
    // **無コストで発行された値は「検証済み」ではない**（SEC-057）。署名も期限も正しいが、
    // この値は「入手にコストを払った」ことを何も示さないので Tier B へ落とす。
    //
    // 印は payload ではなく**署名鍵のラベル**で表されている（SEC-068）ため、
    // 検証済みラベルで一致しない値は「**印の付いた正規の値**」か
    // 「**偽造・改ざん・鍵違い**」のどちらかである。
    //
    // ⚠️ **両者を区別していない。** `sign(payloadPart, secret, true)`（未検証ラベル）での
    // 再検証は**行わない**——どちらも Tier B へ落とすので区別する必要が無く、
    // **区別しないこと自体が「攻撃者に応答から状態を読ませない」ことでもある**。
    // したがって「印の付いた正規の値だけを識別する」用途（例: Tier B の内訳メトリクス）は
    // **現状の実装では成立しない。** 必要になったらここに未検証ラベルでの再検証を足すことになるが、
    // その時点で**状態オラクルを作らないか**（SEC-068）を再評価すること。
    //
    // ここが `null` を返すことが「コストを課す」ことの実体である。**429 ではなく Tier B**
    // にするのは、課してよいコストが**回復可能なもの**に限るためである
    //（共有バケットの枯渇を硬い拒否にする形は SEC-021 → SEC-029 → SEC-030 → SEC-043 と
    //  4 度再発した欠陥そのもので、第三者が枠を使い切るだけで全利用者が窓明けまで詰む）。
    // **印の付いていない値は従来どおり通る。**
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    // 署名は通ったが本文が壊れている（鍵漏えい時などの異常系）。例外を投げず Tier B へ落とす。
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const { sid, issuedAt } = parsed as Partial<FormSessionPayload>
  if (typeof sid !== 'string' || sid.length === 0) return null
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null

  // ⚠️ **印を payload から読むコードをここに戻さないこと**（SEC-068）。
  // 印は署名鍵のラベルで表されており、上の署名検証で既に落ちている。
  // payload に書くとクライアントから読める状態オラクルになる。

  // 未来の `issuedAt` は時計を進める偽装。ちょうど Max-Age は有効、1ms でも超えたら無効。
  if (issuedAt > now) return null
  if (now - issuedAt > MAX_AGE_MS) return null

  return { sid, issuedAt }
}

/* ------------------------------------------------------------------------- *
 * 発行（P3-b で `GET /apply` から使う）
 * ------------------------------------------------------------------------- */

/**
 * 新しいフォームセッションのペイロードを作る。
 *
 * **`sid` は 32 桁の小文字 hex**（SEC-056）。base64url を材料にすると、
 * `lib/rate-limit.ts` の `rateLimitKey` が行う `toLowerCase()`（IPv6 の表記ゆれを畳むための正規化）
 * によって**キー空間が縮む**（1 文字あたり log2(64) → log2(38)）。hex なら畳んでも情報が落ちない。
 *
 * **Request を受け取らない**設計にしてあるのは、`issuedAt` にリクエスト由来の値が入り込む経路を
 * 型の形で狭めるため（P3b-4 / SEC-048）。
 */
export function newFormSessionPayload(options: {
  now?: number
  randomBytes?: (size: number) => Uint8Array
  /** 無コスト枠を超えて発行する場合に `true`（SEC-057）。既定は「検証済み」。 */
  unverified?: boolean
} = {}): FormSessionPayload {
  const source = options.randomBytes ?? ((size: number) => new Uint8Array(cryptoRandomBytes(size)))
  const sid = Buffer.from(source(SID_BYTES)).toString('hex')
  const payload: FormSessionPayload = { sid, issuedAt: options.now ?? Date.now() }
  if (options.unverified === true) payload.unverified = true
  return payload
}

/* ------------------------------------------------------------------------- *
 * Tier D のフォームセッション軸（P3b-1b / P3b-11）
 * ------------------------------------------------------------------------- */

/**
 * Cookie ヘッダから `__Host-fs` の値を取り出す。**同名 Cookie が複数あるときは最初を採る。**
 *
 * どちらを採るかを実装ごとに揺らすと、**検証に使う値と計数に使う値が食い違う**
 * （Cookie shadowing で軸を割られる）。「最初」に固定し、`formSessionAxisKey` と
 * `verifyFormSessionValue` が同じ関数を通ることで一致を保証する。
 */
export function readFormSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== FORM_SESSION_COOKIE_NAME) continue
    const value = part.slice(separator + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

/** `<base64url>.<base64url>` の形式検査。**署名は検証しない。** */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/

/**
 * Tier D のフォームセッション軸キー。**署名は検証せず形式だけを見る。**
 *
 * ------------------------------------------------------------------------
 * なぜ形式検査だけなのか（順序の意図 / SEC-055 の読み方）
 * ------------------------------------------------------------------------
 * SEC-055 が指摘したのは「**キーが検証されていない値そのもの**である」ことであって、
 * 「検証前に計数すること」ではない。署名検証まで行うと**偽造 Cookie の試行そのものを絞る**
 * という Tier D 軸の目的が失われる。したがって:
 *  - 形式不正 → `null`（＝軸を作らない＝新しいバケットを作らせない）
 *  - 形式は正しいが署名不正 → 軸を作る（試行を計数し、その後 Tier B へ落ちる）
 *
 * ------------------------------------------------------------------------
 * 閉じるもの / 閉じないもの（過大報告の防止）
 * ------------------------------------------------------------------------
 * 閉じるのは「**形式不正な値でもバケットが作れる**」経路だけである。形式を満たす値は
 * 攻撃者にも作れるため**残余リスクは残る**。閉じ切るのは P3b-2（KV store = TTL ベースで
 * 退避の概念が無い）である。
 *
 * ------------------------------------------------------------------------
 * 戻り値をハッシュにする理由
 * ------------------------------------------------------------------------
 * `sid` を含む生値をレート制限キーの材料にすると、キーが KV・ログ・メトリクスに現れる
 * （AC-PII-1 は `sid` を禁止項目に含む）。64 文字の小文字 hex なら `rateLimitKey` の
 * `toLowerCase()` でも情報が落ちず、`MAX_RAW_KEY_LENGTH`(64) の範囲に収まるので二重ハッシュにもならない。
 *
 * **例外を投げない。** 材料（Cookie）は攻撃者が完全に制御するため、例外は失敗ではなく劣化にする。
 */
export function formSessionAxisKeyFromValue(
  value: string | null | undefined,
): PerRequesterKey | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > FORM_SESSION_VALUE_MAX_LENGTH) return null

  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [payloadPart, signaturePart] = parts
  if (payloadPart.length === 0) return null
  if (signaturePart.length !== FORM_SESSION_SIGNATURE_LENGTH) return null
  if (!BASE64URL_SEGMENT.test(payloadPart)) return null
  if (!BASE64URL_SEGMENT.test(signaturePart)) return null

  // 軸の同一性は「同じ `sid` か」で決まるので payload 部だけを材料にする
  // （署名だけを変えた値で新しいバケットを作らせない）。
  const digest = createHash('sha256').update(payloadPart, 'utf8').digest('hex')
  return digest as PerRequesterKey
}

/** `formSessionAxisKeyFromValue` を Cookie から呼ぶだけ（ラッパへ渡す配線用）。 */
export function formSessionAxisKey(request: Request): PerRequesterKey | null {
  return formSessionAxisKeyFromValue(readFormSessionCookie(request))
}
