import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const ADMIN_PUBKEY = new PublicKey("6oWHZAJs2HACDk6QrZhbb6f9psuJME3FhiAg1kpaKK1Z");
const GEM_MINT     = new PublicKey("H2y3xXuZmCXYHgHkgmPr1q6SWBjzW3BjVzEyuEpSHn5e");
const NO_REFERRER  = new PublicKey("11111111111111111111111111111111"); // Pubkey::default()

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ForsageV2 as Program<any>;
  const admin   = provider.wallet.publicKey;

  // ── Derive PDAs ──────────────────────────────────────────────────────────
  const [statsPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_stats")],
    program.programId
  );
  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const [adminUserPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_account"), admin.toBuffer()],
    program.programId
  );

  console.log("Global Stats PDA:", statsPDA.toBase58());
  console.log("Vault PDA:       ", vaultPDA.toBase58());
  console.log("Admin User PDA:  ", adminUserPDA.toBase58());

  // ── Step 1: Global stats ─────────────────────────────────────────────────
  const statsInfo = await provider.connection.getAccountInfo(statsPDA);
  if (!statsInfo) {
    console.log("\nInitializing global stats...");
    await (program.methods as any)
      .initializeGlobal()
      .accounts({
        globalStats:   statsPDA,
        authority:     admin,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("✅ Global stats initialized.");
  } else {
    console.log("✅ Global stats already exists.");
  }

  // ── Step 2: Vault ────────────────────────────────────────────────────────
  const vaultInfo = await provider.connection.getAccountInfo(vaultPDA);
  if (!vaultInfo) {
    console.log("\nInitializing vault...");
    await (program.methods as any)
      .initializeVault()
      .accounts({
        vaultGemToken: vaultPDA,
        gemMint:       GEM_MINT,
        authority:     admin,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("✅ Vault initialized.");
  } else {
    console.log("✅ Vault already exists.");
  }

  // ── Step 3: Admin user account (root referrer) ───────────────────────────
  // Uses the dedicated `registerAdmin` instruction — no fee, no referrer PDA needed.
  // This is the root node of the entire referral tree.
  const adminUserInfo = await provider.connection.getAccountInfo(adminUserPDA);
  if (!adminUserInfo) {
    console.log("\nCreating admin user account (root referrer)...");
    await (program.methods as any)
      .registerAdmin()
      .accounts({
        userAccount:   adminUserPDA,
        admin:         admin,
        globalStats:   statsPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("✅ Admin user account created as root referrer.");
  } else {
    console.log("✅ Admin user account already exists.");
  }

  console.log("\n🎉 CoreSage fully initialized!");
  console.log("   Users can register with referral link: ?ref=" + admin.toBase58());
  console.log("   Users without a referral link will have their 60% fee routed to admin.");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});


// ─── Helper exported for your frontend / registration handler ────────────────
//
// Call this when a new user registers. Pass referrerWallet from the URL param,
// or null if no ref link was detected.
//
// Usage:
//   import { registerUser } from "./initialize";
//   await registerUser(program, provider, null);              // no referrer → admin gets 60%
//   await registerUser(program, provider, referrerPublicKey); // referrer gets 60%
//
export async function registerUser(
  program: Program<any>,
  provider: anchor.AnchorProvider,
  referrerWallet: PublicKey | null  // null = no referral link detected
) {
  const user = provider.wallet.publicKey;

  // If no referrer detected, use NO_REFERRER (all-zeros) so the program
  // routes the 60% to admin's token account
  const referrerKey  = referrerWallet ?? NO_REFERRER;
  const isNoReferrer = !referrerWallet || referrerWallet.equals(NO_REFERRER);

  // ── Derive PDAs ────────────────────────────────────────────────────────
  const [statsPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_stats")], program.programId
  );
  const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")], program.programId
  );
  const [userPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_account"), user.toBuffer()], program.programId
  );

  // When no referrer: referrerAccount = admin's UserState PDA (passed but not mutated)
  // When referrer exists: referrerAccount = referrer's UserState PDA
  const referrerAccountOwner = isNoReferrer ? ADMIN_PUBKEY : referrerWallet!;
  const [referrerPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_account"), referrerAccountOwner.toBuffer()], program.programId
  );

  // ── Token accounts ─────────────────────────────────────────────────────
  const userGemAta = await getAssociatedTokenAddress(GEM_MINT, user);

  // When no referrer: 60% goes directly to admin's ATA
  // When referrer exists: 60% goes to referrer's ATA
  const referrerGemAta = await getAssociatedTokenAddress(
    GEM_MINT,
    isNoReferrer ? ADMIN_PUBKEY : referrerWallet!
  );

  console.log(
    isNoReferrer
      ? "No referral link detected — 60% fee will be routed to admin."
      : `Referrer: ${referrerWallet!.toBase58()}`
  );

  await (program.methods as any)
    .register(referrerKey)
    .accounts({
      userAccount:      userPDA,
      referrerAccount:  referrerPDA,    // admin's PDA if no referrer (not mutated on-chain)
      user:             user,
      globalStats:      statsPDA,
      userGemToken:     userGemAta,
      referrerGemToken: referrerGemAta, // admin's ATA if no referrer → 60% lands in admin wallet
      vaultGemToken:    vaultPDA,
      tokenProgram:     TOKEN_PROGRAM_ID,
      systemProgram:    anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`✅ User ${user.toBase58()} registered successfully.`);
}