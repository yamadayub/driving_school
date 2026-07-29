/**
 * ストレージ抽象（tech-stack §2.1「将来 S3/R2 へ移行可能な lib/storage 抽象を保つ」）。
 * デモ実装は Vercel Blob（非公開 + 署名付きURL）。免許証写真は公開URLを持たず objectKey のみ保持（F-009/F-018）。
 *
 * ここでは型と関数シグネチャのみ定義するプレースホルダ。実装は F-009/F-018 で行う。
 */

export interface SignedUploadTarget {
  uploadUrl: string
  objectKey: string // ★サーバー生成。クライアントは指定不可（REV-004）
  expiresIn: number
}

export interface CreateUploadParams {
  side: 'front' | 'back'
  contentType: string
  size: number
}

/** サーバーが objectKey を生成し、短期署名付き PUT URL を発行する（F-009）。 */
export async function createSignedUpload(
  _params: CreateUploadParams,
): Promise<SignedUploadTarget> {
  throw new Error('storage.createSignedUpload: not implemented (F-009)')
}

/** 管理者閲覧用の短期署名付き読み取りURLを発行する（F-018, 期限暫定300秒）。 */
export async function createSignedReadUrl(
  _objectKey: string,
  _expiresInSeconds = 300,
): Promise<{ url: string; expiresIn: number }> {
  throw new Error('storage.createSignedReadUrl: not implemented (F-018)')
}

/** オブジェクトを削除する（APPI削除フロー / orphan 回収, REV-004）。 */
export async function deleteObject(_objectKey: string): Promise<void> {
  throw new Error('storage.deleteObject: not implemented')
}
