import type { SendMessageParams, SendMessageResult, SupplierAdapter } from "./adapter";

/**
 * 「手渡し送信」アダプター。
 *
 * Alibaba / 1688 / AliExpress には公式のメッセージ送信 API がなく、自動送信はアカウント停止の
 * リスクがあるため、本番ではアプリから外部送信しない。承認済み本文をユーザーが業者アプリへ
 * コピー/共有して自分で送り、「送信しました」と報告した時点で sendApprovedMessage を通して記録する。
 * このアダプターはその「報告」を表すもので、ネットワーク I/O は一切行わない。
 */
export class HandoffSupplierAdapter implements SupplierAdapter {
  readonly name = "handoff";
  readonly isExternal = false;

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    return { externalMsgId: `handoff:${params.idempotencyKey}`, sentAt: new Date() };
  }
}
