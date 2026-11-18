import type { SendMessageParams, SendMessageResult, SupplierAdapter } from "./adapter";

/**
 * 外部送信を一切行わないモックアダプター。
 * 開発・テスト・ローカル実行では必ずこれを使用する。
 */
export class MockSupplierAdapter implements SupplierAdapter {
  readonly name = "mock";
  readonly isExternal = false;
  readonly sent: (SendMessageParams & SendMessageResult)[] = [];
  private failNext: Error | null = null;

  /** 次回送信を失敗させる (テスト用) */
  failNextWith(err: Error) {
    this.failNext = err;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const dup = this.sent.find((s) => s.idempotencyKey === params.idempotencyKey);
    if (dup) return { externalMsgId: dup.externalMsgId, sentAt: dup.sentAt };
    const result = { externalMsgId: `mock-${this.sent.length + 1}-${params.idempotencyKey}`, sentAt: new Date() };
    this.sent.push({ ...params, ...result });
    return result;
  }
}
