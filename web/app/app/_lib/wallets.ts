// Wallet Standard, no adapter kit: find wallets that can sign-and-send Solana transactions, connect, send.
// Browser only (getWallets touches window). Never asks for or handles a private key.

import { getWallets } from "@wallet-standard/app";
import type { IdentifierString, Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  type StandardConnectFeature,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
} from "@solana/wallet-standard-features";
import { getBase58Decoder } from "@solana/kit";

export type Cluster = "mainnet" | "devnet" | "testnet";
export const chainOf = (cluster: Cluster): IdentifierString => `solana:${cluster}`;

/** Has standard:connect and solana:signAndSendTransaction, and lists the chain. */
export function canBurn(wallet: Wallet, chain: IdentifierString): boolean {
  return StandardConnect in wallet.features && SolanaSignAndSendTransaction in wallet.features && wallet.chains.includes(chain);
}

/** Wallets that can burn on `chain` now, and a subscription for wallets that register later. */
export function watchWallets(chain: IdentifierString, onChange: (wallets: Wallet[]) => void): () => void {
  const api = getWallets();
  const emit = () => onChange(api.get().filter((w) => canBurn(w, chain)));
  emit();
  const offs = [api.on("register", emit), api.on("unregister", emit)];
  return () => offs.forEach((off) => off());
}

/** The first account that can sign on `chain`, after asking the wallet to connect. */
export async function connectWallet(wallet: Wallet, chain: IdentifierString): Promise<WalletAccount> {
  const connect = (wallet.features as StandardConnectFeature)[StandardConnect];
  const { accounts } = await connect.connect();
  const account = (accounts.length ? accounts : wallet.accounts).find((a) => a.chains.includes(chain));
  if (!account) throw new Error(`${wallet.name} has no account on ${chain}.`);
  return account;
}

export async function disconnectWallet(wallet: Wallet): Promise<void> {
  const feature = (wallet.features as Partial<StandardDisconnectFeature>)[StandardDisconnect];
  await feature?.disconnect().catch(() => {});
}

/** Calls back when the wallet switches or drops accounts. */
export function onAccountsChange(wallet: Wallet, cb: (accounts: readonly WalletAccount[]) => void): () => void {
  const events = (wallet.features as Partial<StandardEventsFeature>)[StandardEvents];
  if (!events) return () => {};
  return events.on("change", (props) => {
    if (props.accounts) cb(props.accounts);
  });
}

/** v0 when the wallet takes it, else legacy. Null if it supports neither. */
export function txVersionFor(wallet: Wallet): 0 | "legacy" | null {
  const f = (wallet.features as SolanaSignAndSendTransactionFeature)[SolanaSignAndSendTransaction];
  const v = f?.supportedTransactionVersions ?? [];
  return v.includes(0) ? 0 : v.includes("legacy") ? "legacy" : null;
}

/** Hands the unsigned wire transaction to the wallet, which signs and submits it. Returns the base58 signature. */
export async function signAndSend(
  wallet: Wallet,
  account: WalletAccount,
  chain: IdentifierString,
  transaction: Uint8Array,
): Promise<string> {
  const f = (wallet.features as SolanaSignAndSendTransactionFeature)[SolanaSignAndSendTransaction];
  const [out] = await f.signAndSendTransaction({
    account,
    chain,
    transaction,
    options: { preflightCommitment: "confirmed", commitment: "confirmed" },
  });
  if (!out?.signature?.length) throw new Error("The wallet did not return a signature.");
  return getBase58Decoder().decode(out.signature);
}

/** Wallets throw different shapes for "user said no". */
export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (e?.code === 4001) return true;
  const text = `${String(e?.name ?? "")} ${String(e?.message ?? "")}`;
  return /reject|denied|declin|cancel/i.test(text);
}
