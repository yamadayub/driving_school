/**
 * 変更系 HTTP ハンドラの共通ガード（SEC-011 / RV-P2-005）。
 *
 * 管理UI は Server Action ではなく**ネイティブ form POST** を採用しており（保存直後の遷移で
 * コミットが中断されないための設計判断）、その代償として Next.js の Server Action が標準で行う
 * Origin 検証を持たない。防御が Auth.js セッション Cookie の `sameSite` 既定値のみに依存する
 * 状態を解消するため、同一オリジン検証を明示的なコードとして置く。
 *
 * P3 の変更系エンドポイント（申込・免許証アップロード・チャット）でも本ヘルパを再利用する
 * （security-audit.md「P3 着手前の必須前提 B」）。
 */

/**
 * 変更系リクエストが同一オリジンから送られたかを判定する（CSRF 防御）。
 *
 * scheme / host / port のいずれかが違えば別オリジン（RFC 6454）。サブドメイン違いも false に
 * するのが要点で、`SameSite=Lax` は同一サイト扱いで Cookie を送るため、サブドメインに XSS や
 * 任意コンテンツが置かれた場合の経路を塞ぐ。
 *
 * `Origin` 欠落は **false（fail-closed）**。クロスサイトのネイティブ form POST は Origin を必ず
 * 送るため、欠落を許すと防御が無意味になる。`Origin: 'null'`（sandbox iframe 等）も一致しない。
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return origin === new URL(request.url).origin
  } catch {
    // request.url が解析不能（通常あり得ない）な場合も拒否側に倒す。
    return false
  }
}

/* ------------------------------------------------------------------------- *
 * 発信元 IP の解決（SEC-022 / RV-P2R-003）
 * ------------------------------------------------------------------------- */

export type ClientIpSource =
  | 'x-vercel-forwarded-for'
  | 'x-forwarded-for'
  | 'x-real-ip'
  | 'unknown'

export interface ClientIpResolution {
  /** レート制限キーに使う値。信頼できない場合も必ず非空・有界な値を返す（制限を緩めない）。 */
  key: string
  /** 値がプラットフォーム由来か（＝クライアントが偽装できないか）。 */
  trusted: boolean
  source: ClientIpSource
}

export interface ResolveClientIpOptions {
  /**
   * 既定は `TRUST_PROXY`（明示されていれば）→ `process.env.VERCEL === '1'`
   *（どちらも無ければ false＝fail-closed）。
   *
   * ⚠️ **本番ルートはこのオプションを渡さないこと。** 明示引数は「呼び出し側が構成を
   * 宣言している」扱いでプラットフォームと同じヘッダ優先順位（`x-vercel-forwarded-for` を含む）に
   * なるため、`resolveClientIp(req, { trustProxy: env.TRUST_PROXY })` と書くと
   * 下の provenance による限定が丸ごと消える。テストの継ぎ目としてのみ使う。
   */
  trustProxy?: boolean
}

/**
 * 信頼の**出所**（provenance）。有効化の経路ごとに「何を信頼してよいか」が違う。
 *
 * - `platform`: `VERCEL === '1'` を検出した。Vercel の転送ヘッダの性質が保証される。
 * - `env`: `TRUST_PROXY` で有効化した。**非 Vercel 本番が唯一の用途**であり、前段は
 *   nginx / ALB / Cloudflare なので Vercel 固有ヘッダの保証は**一切成立しない**。
 * - `explicit`: 呼び出し側が `options.trustProxy` を渡した（構成の宣言とみなす）。
 */
type TrustProvenance = 'platform' | 'env' | 'explicit'

/**
 * 信頼できるプロキシ配下でのみ採用するヘッダ（優先順）。
 *
 * Vercel 公式 Request headers リファレンス（2025-12-13 更新）より:
 *  - `x-vercel-forwarded-for`: x-forwarded-for と同一だが、**Vercel の手前に自前プロキシを
 *    置いた構成でも上書きされない**。最も信頼できるため最優先。
 *  - `x-forwarded-for`: Vercel がクライアントの公開 IP で**上書きする**（IP spoofing 防止のため
 *    外部 IP を転送しない）。クライアント指定値を通せるのは Enterprise の Trusted Proxy のみ。
 *  - `x-real-ip`: 同上。最後の手段。
 */
const PLATFORM_IP_HEADERS: readonly Exclude<ClientIpSource, 'unknown'>[] = [
  'x-vercel-forwarded-for',
  'x-forwarded-for',
  'x-real-ip',
]

/**
 * `TRUST_PROXY`（env）で有効化したときに採用するヘッダ（優先順）。**上とは順序も集合も違う。**
 *
 * 1. `x-vercel-forwarded-for` を**採用しない**（REV-P3C1-003）。
 *    このヘッダを最優先にしてよい根拠は「Vercel の手前に自前プロキシを置いても上書きされない」
 *    という **Vercel 上でのみ成立する性質**である。非 Vercel の前段はこのヘッダを知らないので
 *    **剥がさない**。採用すると攻撃者は `X-Vercel-Forwarded-For:` を付けるだけで
 *    `trusted: true` かつ自分で選んだ key を得る ⇒ 発信元軸のバケット無限生成 /
 *    `lib/form-session-issue.ts` の `!clientIp.trusted` ガードが外れて **SEC-057 の是正が
 *    丸ごと無効化される** / `auth.ts` のログイン IP 軸で被害者を騙り管理者を締め出せる（SEC-030 の再来）。
 *
 * 2. `x-real-ip` を `x-forwarded-for` より**優先する**（NEW-005）。
 *    `resolveClientIp` は XFF の**左端**を採るが、左端が信頼できるのは前段が XFF を
 *    **上書きする**構成に限る。ところが nginx で最も普及したレシピは
 *
 *        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # append（上書きではない）
 *
 *    であり、**append 構成ではクライアントが名乗った値が左端に残る**。
 *    同レシピの `X-Real-IP $remote_addr` は単一値で設定され append されないため、
 *    env 由来の信頼では `x-real-ip` を先に見る。`x-real-ip` を**必須**にはしない
 *    ——上書き構成（正しく設定された前段）で XFF しか送らない環境を永久に縮退させないため、
 *    採用可能な集合は狭めず順序だけを変える。
 */
const ENV_TRUSTED_IP_HEADERS: readonly Exclude<ClientIpSource, 'unknown'>[] = [
  'x-real-ip',
  'x-forwarded-for',
]

/** 信頼境界の外・解決不能時に寄せる単一バケット（「IP 不明だから無制限」にはしない）。 */
export const UNKNOWN_CLIENT_IP = 'unknown'

/** IPv6 リテラルの最大長（`::ffff:` 付き IPv4 射影を含む最長ケース）。 */
const MAX_IP_LITERAL_LENGTH = 45

/**
 * レート制限キーの元になる発信元 IP を解決する。
 *
 * `X-Forwarded-For` は各プロキシが右へ追記するヘッダで、**左端はクライアントが自由に名乗れる**。
 * 信頼できるプロキシ配下だと分かっているときにだけ採用し、そうでなければ単一の `unknown`
 * バケットへ寄せる（偽装で上限を回避されるより、全員が同じバケットを共有するほうが安全）。
 *
 * **`trusted: false` は呼び出し側で必ず見ること（SEC-030）。**
 * 以前ここには「正規管理者は SEC-021 の是正＝『成功は常に通す』により締め出されない」と書いて
 * あったが、**これは事実に反していた**。「成功は常に通す」が適用されていたのはアカウント軸だけで、
 * IP 軸（＝この `unknown` バケット）は照合前ゲートのままだった。実測では、他者が 10 分間に 10 回
 * 失敗させるだけで、正しいパスワードを持つ管理者が `rate-limited` / `verified=false` になった
 * （攻撃コストは元の SEC-021 より安い）。
 * 現在は `lib/login-guard.ts` が `trusted === false` のとき共有バケットを**計数のみに使い、
 * 照合前ゲートには使わない**ことでこの経路を塞いでいる。したがって `key` だけを取り出して
 * `trusted` を捨てる呼び出しは、この防御を無効化する。
 *
 * その代償として、縮退時は「発信元あたりの推測回数を縛る」ことが定義上できなくなり、
 * ブルートフォース耐性はキー非依存のグローバル軸（+ 予約枠）の上限まで低下する。
 * **Vercel 以外へ配置する場合は環境変数 `TRUST_PROXY=1` を設定すること**
 *（`docs/tech-stack.md` §4.5 / SEC-061 / SEC-069）。
 *
 * ⚠️ **`TRUST_PROXY=1` にする前に、前段プロキシの XFF の扱いを必ず確認すること。**
 * nginx の最も普及したレシピ `X-Forwarded-For $proxy_add_x_forwarded_for` は
 * **append（追記）であって上書きではない**ため、クライアントが名乗った値が左端に残る。
 * 本実装は env 由来の信頼では `x-real-ip`（単一値で設定され append されない）を優先することで
 * この構成でも偽装を採らないようにしているが、`x-real-ip` を設定していない append 構成では
 * 攻撃者が任意の発信元を名乗れる——その場合 SEC-057 の是正（`!clientIp.trusted` ガード）ごと
 * 無効化される。**append 構成なら `X-Real-IP $remote_addr` を必ず併設すること。**
 *
 * 採用する値は必ず IP リテラルとして検証する。攻撃者が任意長・任意内容の文字列をレート制限キーに
 * できる経路を断ち、store のメモリ増幅（SEC-023）の増幅要因を消す。
 */
export function resolveClientIp(
  request: Request,
  options: ResolveClientIpOptions = {},
): ClientIpResolution {
  const untrusted: ClientIpResolution = {
    key: UNKNOWN_CLIENT_IP,
    trusted: false,
    source: 'unknown',
  }

  const { trusted, provenance } = resolveTrust(options.trustProxy)
  if (!trusted) return untrusted

  // **どのヘッダを信頼するかは provenance で決まる**（何を信頼するかを固定しないと、
  // fail-closed な既定値をいくら pin しても意味が無い——誰も既定のままでは使わない）。
  const headers = provenance === 'env' ? ENV_TRUSTED_IP_HEADERS : PLATFORM_IP_HEADERS
  for (const source of headers) {
    const raw = request.headers.get(source)
    if (!raw) continue
    // 単一のクライアント IP を期待するヘッダなので、複数値なら先頭のみを採る。
    const candidate = raw.split(',', 1)[0].trim()
    if (isIpLiteral(candidate)) return { key: candidate, trusted: true, source }
  }
  return untrusted
}

/**
 * 信頼するか / その出所はどこか を決める。
 *
 * 決定順:
 *  1. `options.trustProxy`（明示引数が最優先。呼び出し側の構成宣言）
 *  2. `TRUST_PROXY` が**明示されていれば**その値（`'1'|'true'` 以外は false ＝ fail-closed）
 *  3. どちらも無ければ `process.env.VERCEL === '1'`
 *
 * ⚠️ `process.env` を直読みしているのは、`getServerEnv()` が初回 parse をキャッシュするため
 *（`lib/env.ts`）。つまり**検証（zod / 起動時 fail-fast）と使用（ここ）が別経路**になる。
 * 解釈できない値は zod 側で起動を止めるが、それは「起動時の検証が実際に走る経路」に限った保証なので、
 * **ここでも安全側（false）に倒す**（REV-P3C1-009）。
 *
 * 有効化されていても**出所は保持する**: `VERCEL === '1'` を検出しているなら、
 * `TRUST_PROXY=1` を併せて立てていてもプラットフォームの意味論
 *（`x-vercel-forwarded-for` 最優先）を失わせない。
 */
function resolveTrust(explicit: boolean | undefined): {
  trusted: boolean
  provenance: TrustProvenance
} {
  const onPlatform = process.env.VERCEL === '1'
  if (explicit !== undefined) {
    return { trusted: explicit, provenance: onPlatform ? 'platform' : 'explicit' }
  }

  const raw = process.env.TRUST_PROXY
  if (raw !== undefined) {
    const trusted = raw === '1' || raw === 'true'
    // 出所は「プラットフォームを検出しているか」で決める。env で **無効化**した場合
    //（`TRUST_PROXY=0`）は trusted=false なので provenance は使われない。
    return { trusted, provenance: onPlatform ? 'platform' : 'env' }
  }

  return { trusted: onPlatform, provenance: 'platform' }
}

/** IPv4 / IPv6 リテラルとして妥当か。長さを先に切って正規表現に長大な入力を渡さない。 */
function isIpLiteral(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IP_LITERAL_LENGTH) return false
  return isIpv4Literal(value) || isIpv6Literal(value)
}

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`)
const IPV6_GROUP_PATTERN = /^[0-9a-f]{1,4}$/i

function isIpv4Literal(value: string): boolean {
  return IPV4_PATTERN.test(value)
}

/**
 * IPv6 リテラル判定。`::` の省略と末尾の IPv4 記法（`::ffff:192.0.2.1`）に対応する。
 * バックトラッキングを避けるため、正規表現は 1 グループ単位の固定長パターンだけに使う。
 */
function isIpv6Literal(value: string): boolean {
  if (!value.includes(':')) return false
  if (!/^[0-9a-f:.]+$/i.test(value)) return false

  const halves = value.split('::')
  if (halves.length > 2) return false

  /** セグメントが占める 16bit グループ数。不正なら null。 */
  const countGroups = (segment: string, allowIpv4Tail: boolean): number | null => {
    if (segment === '') return 0
    const groups = segment.split(':')
    let count = 0
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      if (allowIpv4Tail && i === groups.length - 1 && group.includes('.')) {
        if (!isIpv4Literal(group)) return null
        count += 2 // IPv4 記法は 2 グループ分
        continue
      }
      if (!IPV6_GROUP_PATTERN.test(group)) return null
      count += 1
    }
    return count
  }

  if (halves.length === 1) {
    return countGroups(halves[0], true) === 8
  }
  const head = countGroups(halves[0], false)
  const tail = countGroups(halves[1], true)
  if (head === null || tail === null) return false
  // `::` は 1 グループ以上を省略した記法なので、両側の合計は 7 以下。
  return head + tail <= 7
}
