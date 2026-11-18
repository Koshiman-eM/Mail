import type { SendMessageParams, SendMessageResult, SupplierAdapter } from "./adapter";

/**
 * Alibaba.com メッセンジャーへの実送信アダプター (未実装)。
 *
 * 実送信は規約・アカウント停止リスクが高いため、公式 API / 正式な連携手段が確定するまで
 * 意図的に未実装としている。誤って有効化されても外部送信は発生しない。
 */
export class AlibabaSupplierAdapter implements SupplierAdapter {
  readonly name = "alibaba";
  readonly isExternal = true;

  async sendMessage(_params: SendMessageParams): Promise<SendMessageResult> {
    throw new Error("AlibabaSupplierAdapter は未実装です。正式な送信手段の確定後に実装してください。");
  }
}
