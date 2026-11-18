/** localStorage は無効化・容量超過・プライベートモードで例外になり得るため必ず try/catch で包む */
export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value = true) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export const INSTALL_CARD_DISMISSED = "sedori.pwa.installCardDismissed";
export const PUSH_CARD_DISMISSED = "sedori.pwa.pushCardDismissed";
