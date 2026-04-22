import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const GEM_MINT = new PublicKey("H2y3xXuZmCXYHgHkgmPr1q6SWBjzW3BjVzEyuEpSHn5e");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ForsageV2 as Program<any>;

  const [statsPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_stats")],
    program.programId
  );
  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );

  console.log("Global Stats PDA:", statsPDA.toBase58());
  console.log("Vault PDA:       ", vaultPDA.toBase58());

  const statsInfo = await provider.connection.getAccountInfo(statsPDA);
  const vaultInfo = await provider.connection.getAccountInfo(vaultPDA);

  // ── Step 1: Initialize global stats if needed ────────────────────────────
  if (!statsInfo) {
    console.log("Initializing global stats...");
    await (program.methods as any)
      .initializeGlobal()
      .accounts({
        globalStats:   statsPDA,
        authority:     provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("✅ Global stats initialized.");
  } else {
    console.log("✅ Global stats already exists — skipping.");
  }

  // ── Step 2: Initialize vault if needed ───────────────────────────────────
  if (!vaultInfo) {
    console.log("Initializing vault...");
    await (program.methods as any)
      .initializeVault()
      .accounts({
        vaultGemToken: vaultPDA,
        gemMint:       GEM_MINT,
        authority:     provider.wallet.publicKey,
        tokenProgram:  anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("✅ Vault initialized at:", vaultPDA.toBase58());
  } else {
    console.log("✅ Vault already exists — skipping.");
  }

  console.log("\n🎉 CoreSage fully initialized!");
  console.log("   Stats:", statsPDA.toBase58());
  console.log("   Vault:", vaultPDA.toBase58());
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});