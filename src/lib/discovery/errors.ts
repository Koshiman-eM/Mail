export class DiscoveryNotFoundError extends Error {
  constructor(what = "探索結果") {
    super(`${what}が見つかりません`);
    this.name = "DiscoveryNotFoundError";
  }
}

/** 連打防止の待ち時間中 (HTTP 429) */
export class DiscoveryCooldownError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super(`この条件は直近に探索しました。${Math.max(1, Math.ceil(retryAfterSec / 60))} 分ほど待ってから再実行してください`);
    this.name = "DiscoveryCooldownError";
  }
}

/** 実行できない操作 (HTTP 422) */
export class DiscoveryActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryActionError";
  }
}
