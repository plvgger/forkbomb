// Builders for getTransaction(..., {encoding: "jsonParsed"}) results, shaped like real mainnet responses.

// Program ids come from the Solana program libraries, not from burns.ts, so a wrong id in the verifier fails the tests.
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from "@solana-program/memo";
import { TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS as TOKEN_2022_PROGRAM } from "@solana-program/token-2022";
import type { ParsedTransaction } from "../../lib/server/burns";

const MEMO_V1_PROGRAM = LEGACY_MEMO_PROGRAM_ADDRESS_V1;
const MEMO_V2_PROGRAM = LEGACY_MEMO_PROGRAM_ADDRESS_V3; // MemoSq4…, the "v2" memo program burns.ts reads

export const MINT = "FORKBOMBxKJ7cS1tm5XoUeAbQ9vUEDRrdRiLNd5Ux7Ppump";
export const OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const ATA = "3N7xNrAgyCBYGBcSwpqLzSW5qmyTvYLpyAzfYWiK1nkY";
export const ATA_2 = "Bz4MhmVRQENiCou7ZpJ575wpjNFjBjVBSiVhuNg1QGfw";
export const OTHER_ATA = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
const ROUTER_PROGRAM = "BurnRoutr1111111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A random 88-char base58 string shaped like a transaction signature. */
export function randomSignature(): string {
  let s = "";
  for (let i = 0; i < 88; i++) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
}

export type BurnSpec = {
  amount: string;
  mint?: string;
  account?: string;
  /** burnChecked (has tokenAmount + decimals) instead of burn. */
  checked?: boolean;
  /** Token-2022 instead of the classic Token program. */
  token2022?: boolean;
  /** Emit as an inner (CPI) instruction of a router program instead of top-level. */
  inner?: boolean;
  decimals?: number;
};

export type TxSpec = {
  signature: string;
  blockTime: number;
  burns: BurnSpec[];
  /** One memo, several, or none. */
  memo?: string | string[] | null;
  memoV1?: boolean;
  err?: unknown;
  slot?: number;
  /** Override the post balance of an account (to fake a mismatch). */
  postOverride?: Record<string, string>;
};

const START_BALANCE = 5_000_000_000_000n;

export function burnTx(spec: TxSpec): ParsedTransaction {
  const burns = spec.burns.map((b) => ({
    mint: MINT,
    account: b.mint && b.mint !== MINT ? OTHER_ATA : ATA,
    decimals: 6,
    ...b,
  }));
  const memos = spec.memo === undefined || spec.memo === null ? [] : Array.isArray(spec.memo) ? spec.memo : [spec.memo];
  const accounts = [...new Set(burns.map((b) => b.account))];
  const mints = [...new Set(burns.map((b) => b.mint))];
  const keys = [
    { pubkey: OWNER, signer: true, source: "transaction", writable: true },
    ...accounts.map((pubkey) => ({ pubkey, signer: false, source: "transaction", writable: true })),
    ...mints.map((pubkey) => ({ pubkey, signer: false, source: "transaction", writable: true })),
    { pubkey: COMPUTE_BUDGET, signer: false, source: "transaction", writable: false },
    { pubkey: TOKEN_PROGRAM, signer: false, source: "transaction", writable: false },
    { pubkey: TOKEN_2022_PROGRAM, signer: false, source: "transaction", writable: false },
    { pubkey: spec.memoV1 ? MEMO_V1_PROGRAM : MEMO_V2_PROGRAM, signer: false, source: "transaction", writable: false },
    { pubkey: ROUTER_PROGRAM, signer: false, source: "transaction", writable: false },
  ];
  const index = (pubkey: string) => keys.findIndex((k) => k.pubkey === pubkey);

  const burnIx = (b: (typeof burns)[number], stackHeight: number) => {
    const programId = b.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    const info = b.checked
      ? {
          account: b.account,
          authority: OWNER,
          mint: b.mint,
          tokenAmount: {
            amount: b.amount,
            decimals: b.decimals,
            uiAmount: Number(b.amount) / 10 ** b.decimals,
            uiAmountString: String(Number(b.amount) / 10 ** b.decimals),
          },
        }
      : { account: b.account, amount: b.amount, authority: OWNER, mint: b.mint };
    return {
      parsed: { info, type: b.checked ? "burnChecked" : "burn" },
      program: b.token2022 ? "spl-token-2022" : "spl-token",
      programId,
      stackHeight,
    };
  };

  const instructions: ParsedTransaction["transaction"]["message"]["instructions"] = [
    { accounts: [], data: "3DdGGhkhJbjm", programId: COMPUTE_BUDGET, stackHeight: null },
  ];
  const innerInstructions: { index: number; instructions: ParsedTransaction["transaction"]["message"]["instructions"] }[] = [];
  const innerBurns = burns.filter((b) => b.inner);
  for (const b of burns.filter((x) => !x.inner)) instructions.push(burnIx(b, 1));
  if (innerBurns.length) {
    instructions.push({
      accounts: [OWNER, ...innerBurns.map((b) => b.account), ...innerBurns.map((b) => b.mint)],
      data: "2Ym4V7Q2Lw4K",
      programId: ROUTER_PROGRAM,
      stackHeight: null,
    });
    innerInstructions.push({ index: instructions.length - 1, instructions: innerBurns.map((b) => burnIx(b, 2)) });
  }
  for (const text of memos) {
    instructions.push({ parsed: text, program: "spl-memo", programId: spec.memoV1 ? MEMO_V1_PROGRAM : MEMO_V2_PROGRAM, stackHeight: null });
  }

  const balances = (post: boolean) =>
    accounts.map((account) => {
      const b = burns.find((x) => x.account === account)!;
      const burned = burns.filter((x) => x.account === account).reduce((a, x) => a + BigInt(x.amount), 0n);
      const amount = post ? (spec.postOverride?.[account] ?? (START_BALANCE - burned).toString()) : START_BALANCE.toString();
      return {
        accountIndex: index(account),
        mint: b.mint,
        owner: OWNER,
        programId: b.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
        uiTokenAmount: {
          amount,
          decimals: b.decimals,
          uiAmount: Number(amount) / 10 ** b.decimals,
          uiAmountString: String(Number(amount) / 10 ** b.decimals),
        },
      };
    });

  return {
    blockTime: spec.blockTime,
    meta: {
      computeUnitsConsumed: 18_734,
      err: spec.err ?? null,
      fee: 5_000,
      innerInstructions,
      loadedAddresses: { readonly: [], writable: [] },
      logMessages: [`Program ${TOKEN_PROGRAM} invoke [1]`, `Program ${TOKEN_PROGRAM} success`],
      postBalances: keys.map(() => 2_039_280),
      postTokenBalances: balances(true),
      preBalances: keys.map(() => 2_039_280),
      preTokenBalances: balances(false),
      rewards: [],
      status: spec.err ? { Err: spec.err } : { Ok: null },
    },
    slot: spec.slot ?? 371_204_118,
    transaction: {
      message: {
        accountKeys: keys,
        addressTableLookups: [],
        instructions,
        recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
      },
      signatures: [spec.signature],
    },
    version: 0,
  } as ParsedTransaction;
}
