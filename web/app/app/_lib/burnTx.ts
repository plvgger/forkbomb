// Builds the burn transaction: exactly [burnChecked, memo] and nothing else, so what the wallet shows is
// what burns.ts verifies. The wallet signs and sends it; we never see a key.

import {
  address,
  appendTransactionMessageInstructions,
  type Address,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  blockhash as toBlockhash,
} from "@solana/kit";
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from "@solana-program/memo";
import {
  findAssociatedTokenPda,
  getBurnCheckedInstruction as getBurnCheckedToken,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  getBurnCheckedInstruction as getBurnCheckedToken2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";

export type TokenProgramKind = "token" | "token-2022";

export const TOKEN_PROGRAM_IDS: Record<TokenProgramKind, Address> = {
  token: TOKEN_PROGRAM_ADDRESS,
  "token-2022": TOKEN_2022_PROGRAM_ADDRESS,
};

/**
 * SPL Memo v2 (MemoSq4…). @solana-program/memo now defaults to a newer program id that RPCs don't parse
 * in jsonParsed yet and burns.ts does not accept, so pin the one the verifier reads.
 */
export const BURN_MEMO_PROGRAM: Address = LEGACY_MEMO_PROGRAM_ADDRESS_V3;

const WORKSPACE_RE = /^ws_[A-Za-z0-9]{16,32}$/;
const PREFIX_RE = /^[a-z0-9]+:$/;

export type BurnParams = {
  owner: string;
  mint: string;
  program: TokenProgramKind;
  /** Raw base units. */
  amount: bigint;
  decimals: number;
  workspaceId: string;
  /** From GET /api/token, e.g. "forkbomb:". */
  memoPrefix: string;
};

export function burnMemoFor(memoPrefix: string, workspaceId: string): string {
  if (!PREFIX_RE.test(memoPrefix)) throw new Error(`Bad memo prefix: ${memoPrefix}`);
  if (!WORKSPACE_RE.test(workspaceId)) throw new Error(`Bad workspace id: ${workspaceId}`);
  return `${memoPrefix}${workspaceId}`;
}

/** The owner's associated token account for this mint under the given token program. */
export async function associatedTokenAccount(owner: string, mint: string, program: TokenProgramKind): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_IDS[program],
  });
  return ata;
}

/** [burnChecked(program, ATA, mint, owner, amount, decimals), memo("<prefix><workspaceId>")]. */
export async function buildBurnInstructions(p: BurnParams): Promise<Instruction[]> {
  if (p.amount <= 0n) throw new Error("Amount must be more than zero.");
  const memo = burnMemoFor(p.memoPrefix, p.workspaceId);
  const owner = createNoopSigner(address(p.owner));
  const mint = address(p.mint);
  const account = await associatedTokenAccount(p.owner, p.mint, p.program);
  const input = { account, mint, authority: owner, amount: p.amount, decimals: p.decimals };
  const burn =
    p.program === "token-2022"
      ? getBurnCheckedToken2022(input, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })
      : getBurnCheckedToken(input, { programAddress: TOKEN_PROGRAM_ADDRESS });
  return [burn, getAddMemoInstruction({ memo }, { programAddress: BURN_MEMO_PROGRAM })];
}

export type Lifetime = { blockhash: string; lastValidBlockHeight: bigint };

/** Unsigned wire transaction, owner as fee payer. version 0 unless the wallet only takes legacy. */
export async function buildBurnTransaction(
  p: BurnParams,
  lifetime: Lifetime,
  version: 0 | "legacy" = 0,
): Promise<Uint8Array> {
  const instructions = await buildBurnInstructions(p);
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(address(p.owner)), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash(lifetime.blockhash), lastValidBlockHeight: lifetime.lastValidBlockHeight },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}
