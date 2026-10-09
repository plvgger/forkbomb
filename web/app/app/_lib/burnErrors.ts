// Human copy for every outcome of POST /api/burns/verify (codes from lib/server/burns.ts), and whether
// the poller should keep trying. Finalization takes ~15-40 s, so "not yet" codes retry until a deadline.
// Also the copy for a wallet that refused to send the burn.

import { fmtMicroUsd, fmtPrice, fmtUsd } from "@/app/burns/format";
import type { BurnRecord } from "./api";

export const VERIFY_POLL_MS = 4_000;
/** Give up polling after this long; the burn is still on chain and can be re-checked by signature. */
export const VERIFY_DEADLINE_MS = 3 * 60_000;

export type VerifyCopy = { retry: boolean; title: string; body: string };

const CONTACT = "Keep the signature and open an issue with it so a human can look.";

export function verifyCopy(code: string, ticker: string): VerifyCopy {
  switch (code) {
    case "not_found":
      return { retry: true, title: "Waiting for the transaction", body: "Solana hasn't shown this transaction yet. Checking again every 4 seconds." };
    case "not_finalized":
      return { retry: true, title: "Finalizing", body: "Your burn landed. Solana finalizes it in about 15 to 40 seconds, then it's credited." };
    case "rpc_error":
    case "rpc_unavailable":
    case "rpc_busy":
      return { retry: true, title: "Solana RPC is slow", body: "Couldn't read the chain just now. Retrying." };
    case "price_unavailable":
      return { retry: true, title: "Price feed is down", body: "The burn is fine. Pricing it as soon as the feed answers." };
    case "rate_limited":
      return { retry: true, title: "Checking too often", body: "The server asked us to slow down. Retrying shortly." };
    case "network":
      return { retry: true, title: "Connection dropped", body: "Couldn't reach the server. Retrying." };
    case "invalid_signature":
      return { retry: false, title: "Not a signature", body: "That isn't a Solana transaction signature. Paste the full signature from your wallet or Solscan." };
    case "not_configured":
      return { retry: false, title: "Burns open at launch", body: `${ticker} isn't live yet, so nothing can be credited.` };
    case "failed_tx":
      return { retry: false, title: "Transaction failed", body: "It failed on chain, so nothing was burned. Your tokens are still in your wallet." };
    case "wrong_mint":
      return { retry: false, title: "Wrong token", body: `This transaction burns a different token, not ${ticker}. No credit.` };
    case "no_burn":
      return { retry: false, title: "No burn found", body: "This transaction doesn't burn any tokens, so there is nothing to credit." };
    case "bad_memo":
      return { retry: false, title: "Memo missing or wrong", body: `The burn has no valid workspace memo, so it can't be matched to a workspace. ${CONTACT}` };
    case "balance_mismatch":
      return { retry: false, title: "Amounts don't add up", body: `The burned amount doesn't match the token account's change. ${CONTACT}` };
    case "unknown_workspace":
      return { retry: false, title: "Unknown workspace", body: `The memo names a workspace that doesn't exist. ${CONTACT}` };
    case "too_old_for_price":
      return { retry: false, title: "Can't price this burn", body: `No price sample was recorded close enough to the burn time. ${CONTACT}` };
    default:
      return { retry: false, title: "Verification failed", body: `The server couldn't verify this burn (${code}). ${CONTACT}` };
  }
}

/** 5xx answers without a known code are worth retrying too. */
export function shouldRetry(code: string, status: number): boolean {
  return verifyCopy(code, "").retry || (status >= 500 && code !== "not_configured");
}

/** The sentence under a verified burn's badge. A replay of a credited burn says nothing new was added. */
export function doneCopy(r: BurnRecord): string {
  if (r.status === "review") {
    return `Burned ${r.amountUi} worth ${fmtUsd(r.usdValue)}. Over the per-burn limit, so a human reviews it before it's credited.`;
  }
  if (r.status === "already_credited") {
    return `This burn of ${r.amountUi} was already credited (${fmtMicroUsd(r.creditMicroUsd)} at ${fmtPrice(r.priceUsd)}). Nothing new was added.`;
  }
  return `Burned ${r.amountUi} at ${fmtPrice(r.priceUsd)}: ${fmtMicroUsd(r.creditMicroUsd)} credit added.`;
}

export const SHORT_BALANCE = "Your wallet holds less than this now. Refresh and try a smaller amount.";
const SHORT_SOL = "This wallet needs a little SOL (about 0.00001) to pay the network fee. Add some and try again.";

/**
 * Copy for a send the wallet didn't complete (not a user rejection). Simulation errors arrive raw; the two a burn
 * hits in practice get plain words: instruction 0 is the burn, so its "custom program error: 0x1" is the token
 * program's InsufficientFunds. Anything else is shown as the wallet said it.
 */
export function walletSendCopy(message: string): string {
  if (/insufficient (funds for (fee|rent)|lamports)|no record of a prior credit/i.test(message)) return SHORT_SOL;
  if (/instruction 0: custom program error: 0x1\b|insufficient funds/i.test(message)) return SHORT_BALANCE;
  return message || "Unknown error.";
}
