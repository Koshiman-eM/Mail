export interface SendMessageParams {
  supplierExternalId: string;
  threadId: string;
  text: string;
  /** 冪等キー (ChatMessage.id)。アダプター側で二重送信検知に用いる */
  idempotencyKey: string;
}

export interface SendMessageResult {
  externalMsgId: string;
  sentAt: Date;
}

/** サプライヤーとのメッセージ送受信を抽象化するアダプター */
export interface SupplierAdapter {
  readonly name: string;
  /** 実在のサプライヤーへ外部送信するアダプターか */
  readonly isExternal: boolean;
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
}
