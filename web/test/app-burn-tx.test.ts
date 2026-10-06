import {
  AccountRole,
  address,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { getAddMemoInstructionDataDecoder } from "@solana-program/memo";
import { findAssociatedTokenPda, getBurnCheckedInstructionDataDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import {
  associatedTokenAccount,
  BURN_MEMO_PROGRAM,
  buildBurnInstructions,
  buildBurnTransaction,
  burnMemoFor,
  type BurnParams,
  TOKEN_PROGRAM_IDS,
} from "../app/app/_lib/burnTx";
import {
  MEMO_V2_PROGRAM,
  parseBurnTransaction,
  type ParsedInstruction,
  type ParsedTransaction,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "../lib/server/burns";
import { burnTx, MINT as FIXTURE_MINT, randomSignature } from "./fixtures/transactions";

// Public, well-known addresses: no wallet or key is involved in building an unsigned transaction.
const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WS = "ws_AbCdEfGhIjKlMnOpQrSt";
const BLOCKHASH = { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 123n };

const params = (over: Partial<BurnParams> = {}): BurnParams => ({
  owner: OWNER,
  mint: MINT,
  program: "token",
  amount: 1_234_567n,
  decimals: 6,
  workspaceId: WS,
  memoPrefix: "forkbomb:",
  ...over,
});

describe("buildBurnInstructions", () => {
  for (const [program, programId] of [
    ["token", TOKEN_PROGRAM_ADDRESS],
    ["token-2022", TOKEN_2022_PROGRAM_ADDRESS],
  ] as const) {
    it(`is exactly [burnChecked, memo] for ${program}`, async () => {
      const ixs = await buildBurnInstructions(params({ program }));
      expect(ixs).toHaveLength(2);
      const [burn, memo] = ixs as [(typeof ixs)[number], (typeof ixs)[number]];

      // burnChecked on the owner's ATA under the same token program
      const [ata] = await findAssociatedTokenPda({ owner: address(OWNER), mint: address(MINT), tokenProgram: programId });
      expect(burn.programAddress).toBe(programId);
      expect(burn.accounts).toEqual([
        { address: ata, role: AccountRole.WRITABLE },
        { address: MINT, role: AccountRole.WRITABLE },
        expect.objectContaining({ address: OWNER, role: AccountRole.READONLY_SIGNER }),
      ]);
      expect(getBurnCheckedInstructionDataDecoder().decode(burn.data!)).toEqual({
        discriminator: 15,
        amount: 1_234_567n,
        decimals: 6,
      });

      // memo "forkbomb:<id>" on the memo program the verifier reads, no extra accounts
      expect(memo.programAddress).toBe(BURN_MEMO_PROGRAM);
      expect(memo.accounts ?? []).toEqual([]);
      expect(getAddMemoInstructionDataDecoder().decode(memo.data!)).toEqual({ memo: `forkbomb:${WS}` });
    });
  }

  it("uses a different ATA per token program", async () => {
    const a = await associatedTokenAccount(OWNER, MINT, "token");
    const b = await associatedTokenAccount(OWNER, MINT, "token-2022");
    expect(a).not.toBe(b);
  });

  it("pins the program ids burns.ts verifies", () => {
    expect(BURN_MEMO_PROGRAM).toBe(MEMO_V2_PROGRAM);
    expect(TOKEN_PROGRAM_IDS.token).toBe(TOKEN_PROGRAM);
    expect(TOKEN_PROGRAM_IDS["token-2022"]).toBe(TOKEN_2022_PROGRAM);
  });

  it("rejects a zero amount, a bad workspace id and a bad prefix", async () => {
    await expect(buildBurnInstructions(params({ amount: 0n }))).rejects.toThrow(/more than zero/);
    await expect(buildBurnInstructions(params({ workspaceId: "ws_short" }))).rejects.toThrow(/workspace/);
    await expect(buildBurnInstructions(params({ workspaceId: `${WS} extra` }))).rejects.toThrow(/workspace/);
    await expect(buildBurnInstructions(params({ memoPrefix: "forkbomb" }))).rejects.toThrow(/prefix/);
    await expect(buildBurnInstructions(params({ owner: "not-an-address" }))).rejects.toThrow();
  });

  it("writes a memo the verifier parses back to the same workspace", () => {
    const memo = burnMemoFor("forkbomb:", WS);
    const tx = burnTx({ signature: randomSignature(), blockTime: 1_760_000_000, burns: [{ amount: "5", checked: true }], memo });
    expect(parseBurnTransaction(tx, FIXTURE_MINT, "forkbomb").workspaceId).toBe(WS);
  });
});

describe("buildBurnTransaction", () => {
  for (const version of [0, "legacy"] as const) {
    it(`compiles a ${version} transaction with only the two instructions and the owner as fee payer`, async () => {
      const wire = await buildBurnTransaction(params({ program: "token-2022" }), BLOCKHASH, version);
      const tx = getTransactionDecoder().decode(wire);
      expect(Object.keys(tx.signatures)).toEqual([OWNER]); // one unsigned slot, for the wallet
      expect(Object.values(tx.signatures)).toEqual([null]);
      const msg = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
      expect(msg.version).toBe(version);
      expect(msg.feePayer.address).toBe(OWNER);
      const programs = (msg.instructions as readonly { programAddress: string }[]).map((i) => i.programAddress);
      expect(programs).toEqual([TOKEN_2022_PROGRAM_ADDRESS, BURN_MEMO_PROGRAM]);
    });
  }
});

/**
 * What getTransaction(sig, {encoding: "jsonParsed"}) returns for a wire transaction once it lands:
 * the token program's burnChecked parsed into info, the memo parsed to its text, and the burned
 * account's balance falling by the amount. Program ids are carried over untouched from the wire bytes.
 */
function landAsJsonParsed(wire: Uint8Array, startBalance: bigint): ParsedTransaction {
  const tx = getTransactionDecoder().decode(wire);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const msg = decompileTransactionMessage(compiled);
  const keys = compiled.staticAccounts.map(String);
  const pre: ParsedTransaction["meta"] & {} = { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] };
  const instructions: ParsedInstruction[] = (
    msg.instructions as readonly { programAddress: string; accounts?: readonly { address: string }[]; data?: Uint8Array }[]
  ).map((ix) => {
    if (ix.programAddress === BURN_MEMO_PROGRAM) {
      return { programId: ix.programAddress, program: "spl-memo", parsed: getAddMemoInstructionDataDecoder().decode(ix.data!).memo };
    }
    const { amount, decimals } = getBurnCheckedInstructionDataDecoder().decode(ix.data!);
    const [account, mint, authority] = (ix.accounts ?? []).map((a) => a.address) as [string, string, string];
    const balance = (raw: bigint) => ({
      accountIndex: keys.indexOf(account),
      mint,
      owner: authority,
      programId: ix.programAddress,
      uiTokenAmount: { amount: raw.toString(), decimals },
    });
    pre.preTokenBalances!.push(balance(startBalance));
    pre.postTokenBalances!.push(balance(startBalance - amount));
    return {
      programId: ix.programAddress,
      parsed: { type: "burnChecked", info: { account, authority, mint, tokenAmount: { amount: amount.toString(), decimals } } },
    };
  });
  return {
    slot: 1,
    blockTime: 1_760_000_000,
    meta: pre,
    transaction: { signatures: [randomSignature()], message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions } },
  };
}

describe("built transaction against the verifier", () => {
  for (const program of ["token", "token-2022"] as const) {
    it(`a ${program} burn built for the wallet passes parseBurnTransaction`, async () => {
      const wire = await buildBurnTransaction(params({ program }), BLOCKHASH);
      const burn = parseBurnTransaction(landAsJsonParsed(wire, 10_000_000n), MINT, "forkbomb");
      expect(burn).toMatchObject({ workspaceId: WS, owner: OWNER, mint: MINT, amountRaw: 1_234_567n, decimals: 6 });
    });
  }
});
