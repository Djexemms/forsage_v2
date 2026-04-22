"use client";
import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, ParsedTransactionWithMeta } from "@solana/web3.js";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../forsage_v2.json";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

// ─── Constants ───────────────────────────────────────────────────────────────
const PROGRAM_ID       = new PublicKey("DhNMofqKPt5hhUkQCRFHjDC6jPQz5sHhuYR59ZGT8XCX");
const GEM_MINT         = new PublicKey("H2y3xXuZmCXYHgHkgmPr1q6SWBjzW3BjVzEyuEpSHn5e");
const ADMIN_WALLET     = new PublicKey("6oWHZAJs2HACDk6QrZhbb6f9psuJME3FhiAg1kpaKK1Z");
const DECIMALS         = 1_000_000_000;
const REGISTRATION_FEE = 100;
const ONE_DAY_MS       = 86_400_000;

const MATRIX_LEVELS: Record<string, number[]> = {
  x3: [100, 200, 400, 800, 1600, 3200, 6400, 12800],
  x6: [100, 200, 400, 800, 1600, 3200, 6400, 12800],
};

// ─── Stable PDAs ─────────────────────────────────────────────────────────────
const [statsPDA] = PublicKey.findProgramAddressSync([Buffer.from("global_stats")], PROGRAM_ID);
const [vaultPDA] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);

function getAdminPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_account"), ADMIN_WALLET.toBuffer()], PROGRAM_ID
  )[0];
}

function getUserPDA(wallet: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_account"), wallet.toBuffer()], PROGRAM_ID
  )[0];
}

// ─── GEM Price ───────────────────────────────────────────────────────────────
let cachedPrice = 0.05;
let lastFetchTime = 0;
const PRICE_CACHE_MS = 5 * 60 * 1000;

async function fetchGemPrice(): Promise<number> {
  const now = Date.now();
  if (now - lastFetchTime < PRICE_CACHE_MS) return cachedPrice;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=gemstones&vs_currencies=usd"
    );
    if (res.status === 429) return cachedPrice;
    if (!res.ok) throw new Error();
    const json = await res.json();
    cachedPrice = json?.gemstones?.usd ?? 0.05;
    lastFetchTime = now;
    return cachedPrice;
  } catch { return cachedPrice; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function gemToUsd(gem: number, price: number) {
  return (gem * price).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function formatCountdown(ms: number) {
  if (ms <= 0) return "Ready";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${h}h ${m}m ${s}s`;
}
function shortKey(key: string) {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface UserState {
  x3Level: number; x6Level: number;
  x3SlotsFilled: number; x6SlotsFilled: number;
  x3MatrixCount: number; x6MatrixCount: number;
  totalGemSpent: number; totalEarned: number;
  lastClaimTime: number;
  isBlockedX3: boolean; isBlockedX6: boolean;
  directReferrals: number; totalReferrals: number;
  referrer: string;
  initialized: boolean;
}

interface TxRecord {
  signature: string;
  type: string;
  amount: string;
  time: string;
  status: "success" | "failed";
}

// ─── Inner component (uses useSearchParams) ───────────────────────────────────
function HomeInner() {
  const searchParams = useSearchParams();
  const { connection } = useConnection();
  const { publicKey, wallet } = useWallet();

  const [isMounted, setIsMounted]                 = useState(false);
  const [userState, setUserState]                 = useState<UserState | null>(null);
  const [gemPrice, setGemPrice]                   = useState(0.05);
  const [totalGemCollected, setTotalGemCollected] = useState(0);
  const [totalUsers, setTotalUsers]               = useState(0);
  const [totalReferrals, setTotalReferrals]       = useState(0);
  const [loading, setLoading]                     = useState(false);
  const [claimLoading, setClaimLoading]           = useState(false);
  const [statusMsg, setStatusMsg]                 = useState("");
  const [statusType, setStatusType]               = useState<"success"|"error"|"info">("info");
  const [now, setNow]                             = useState(Date.now());
  const [txHistory, setTxHistory]                 = useState<TxRecord[]>([]);
  const [copied, setCopied]                       = useState(false);
  const [referralLink, setReferralLink]           = useState("");

  // Read ?ref= from URL
  const refParam = searchParams.get("ref");
  const referrerFromUrl = refParam ? (() => {
    try { return new PublicKey(refParam); } catch { return null; }
  })() : null;

  useEffect(() => {
    setIsMounted(true);
    if (typeof window !== "undefined" && publicKey) {
      setReferralLink(`${window.location.origin}?ref=${publicKey.toBase58()}`);
    }
  }, [publicKey]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const getProgram = useCallback(() => {
    if (!wallet?.adapter) throw new Error("Wallet not connected");
    const provider = new AnchorProvider(connection, wallet.adapter as any, { commitment: "confirmed" });
    return new Program(idl as unknown as Idl, provider);
  }, [connection, wallet]);

  // ── Fetch on-chain data ───────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const program = getProgram();
      try {
        const stats: any = await (program.account as any).globalStats.fetch(statsPDA);
        setTotalGemCollected((stats.totalGemCollected?.toNumber() ?? 0) / DECIMALS);
        setTotalUsers(stats.totalUsers?.toNumber() ?? 0);
        setTotalReferrals(stats.totalReferrals?.toNumber() ?? 0);
      } catch { }

      if (publicKey) {
        const userPDA = getUserPDA(publicKey);
        try {
          const account: any = await (program.account as any).userState.fetch(userPDA);
          setUserState({
            x3Level:        account.x3Level ?? 0,
            x6Level:        account.x6Level ?? 0,
            x3SlotsFilled:  account.x3SlotsFilled ?? 0,
            x6SlotsFilled:  account.x6SlotsFilled ?? 0,
            x3MatrixCount:  account.x3MatrixCount ?? 0,
            x6MatrixCount:  account.x6MatrixCount ?? 0,
            totalGemSpent:  (account.totalGemSpent?.toNumber() ?? 0) / DECIMALS,
            totalEarned:    (account.totalEarned?.toNumber() ?? 0) / DECIMALS,
            lastClaimTime:  account.lastClaimTime?.toNumber() ?? 0,
            isBlockedX3:    account.isBlockedX3 ?? false,
            isBlockedX6:    account.isBlockedX6 ?? false,
            directReferrals: account.directReferrals ?? 0,
            totalReferrals:  account.totalReferrals ?? 0,
            referrer:        account.referrer?.toBase58() ?? "",
            initialized:    true,
          });
        } catch {
          setUserState({ x3Level:0,x6Level:0,x3SlotsFilled:0,x6SlotsFilled:0,x3MatrixCount:0,x6MatrixCount:0,totalGemSpent:0,totalEarned:0,lastClaimTime:0,isBlockedX3:false,isBlockedX6:false,directReferrals:0,totalReferrals:0,referrer:"",initialized:false });
        }

        // Fetch transaction history
        try {
          const sigs = await connection.getSignaturesForAddress(userPDA, { limit: 10 });
          const records: TxRecord[] = sigs.map((s) => ({
            signature: s.signature,
            type:      s.memo ?? "Transaction",
            amount:    "—",
            time:      s.blockTime ? new Date(s.blockTime * 1000).toLocaleString() : "—",
            status:    s.err ? "failed" : "success",
          }));
          setTxHistory(records);
        } catch { }
      }
    } catch (e) { console.error(e); }
  }, [getProgram, publicKey, connection]);

  useEffect(() => {
    fetchGemPrice().then(setGemPrice);
    const i = setInterval(() => fetchGemPrice().then(setGemPrice), PRICE_CACHE_MS);
    return () => clearInterval(i);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!publicKey) return;
    fetchData();
    const i = setInterval(fetchData, 30_000);
    return () => clearInterval(i);
  }, [publicKey]);

  useEffect(() => {
    if (publicKey && typeof window !== "undefined") {
      setReferralLink(`${window.location.origin}?ref=${publicKey.toBase58()}`);
    }
  }, [publicKey]);

  const setStatus = (msg: string, type: "success"|"error"|"info" = "info") => {
    setStatusMsg(msg); setStatusType(type);
  };

  const copyReferralLink = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Check if connected wallet is the Admin
  const isAdmin = publicKey?.toBase58() === ADMIN_WALLET.toBase58();

  // ── Genesis Admin Register ──────────────────────────────────────────────
  const handleGenesisRegister = async () => {
    if (!publicKey) return;
    setLoading(true); setStatus("Initializing Genesis Admin...", "info");
    try {
      const program = getProgram();
      const userPDA = getUserPDA(publicKey);
      
      await (program.methods as any).registerAdmin().accounts({
        userAccount: userPDA,
        user: publicKey,
        systemProgram: SystemProgram.programId,
      }).rpc();
      
      setStatus("Genesis Admin registered! Platform is now open.", "success");
      await fetchData();
    } catch (err: any) {
      setStatus(err?.message ?? "Genesis failed", "error");
    } finally { setLoading(false); }
  };

  // ── Register ──────────────────────────────────────────────────────────────
  const handleRegister = async () => {
    if (!publicKey) return;
    setLoading(true); setStatus("Registering…", "info");
    try {
      const program    = getProgram();
      const userPDA    = getUserPDA(publicKey);
      const userGemAta = await getAssociatedTokenAddress(GEM_MINT, publicKey);

      // Use referrer from URL or fallback to admin
      const referrerKey   = referrerFromUrl ?? ADMIN_WALLET;
      const referrerPDA   = getUserPDA(referrerKey);
      const referrerGemAta = await getAssociatedTokenAddress(GEM_MINT, referrerKey);

      await (program.methods as any)
        .register(referrerKey)
        .accounts({
          userAccount:       userPDA,
          referrerAccount:   referrerPDA,
          user:              publicKey,
          globalStats:       statsPDA,
          userGemToken:      userGemAta,
          referrerGemToken:  referrerGemAta,
          vaultGemToken:     vaultPDA,
          tokenProgram:      TOKEN_PROGRAM_ID,
          systemProgram:     SystemProgram.programId,
        })
        .rpc();

      setStatus("Registered successfully! 60 GEM sent to your referrer.", "success");
      await fetchData();
    } catch (err: any) {
      setStatus(err?.message ?? "Registration failed", "error");
    } finally { setLoading(false); }
  };

  // ── Upgrade ───────────────────────────────────────────────────────────────
  const handleUpgrade = async (matrix: "x3" | "x6") => {
    if (!publicKey || !userState) return;
    const currentLevel = matrix === "x3" ? userState.x3Level : userState.x6Level;
    const nextLevel    = currentLevel + 1;
    if (nextLevel > 8) return;
    const matrixArg    = matrix === "x3" ? 0 : 1;

    setLoading(true); setStatus(`Upgrading ${matrix.toUpperCase()} → Level ${nextLevel}…`, "info");
    try {
      const program      = getProgram();
      const userPDA      = getUserPDA(publicKey);
      const userGemAta   = await getAssociatedTokenAddress(GEM_MINT, publicKey);
      const referrerKey  = userState.referrer ? new PublicKey(userState.referrer) : ADMIN_WALLET;
      const referrerPDA  = getUserPDA(referrerKey);
      const referrerGemAta = await getAssociatedTokenAddress(GEM_MINT, referrerKey);

      await (program.methods as any)
        .upgradeLevel(matrixArg, nextLevel)
        .accounts({
          userAccount:      userPDA,
          referrerAccount:  referrerPDA,
          user:             publicKey,
          globalStats:      statsPDA,
          userGemToken:     userGemAta,
          referrerGemToken: referrerGemAta,
          vaultGemToken:    vaultPDA,
          tokenProgram:     TOKEN_PROGRAM_ID,
        })
        .rpc();

      setStatus(`Level ${nextLevel} unlocked! 60% sent to your referrer.`, "success");
      await fetchData();
    } catch (err: any) {
      setStatus(err?.message ?? "Upgrade failed", "error");
    } finally { setLoading(false); }
  };

  // ── Claim ─────────────────────────────────────────────────────────────────
  const handleClaim = async () => {
    if (!publicKey || !userState) return;
    setClaimLoading(true); setStatus("Claiming…", "info");
    try {
      const program    = getProgram();
      const userPDA    = getUserPDA(publicKey);
      const userGemAta = await getAssociatedTokenAddress(GEM_MINT, publicKey);

      await (program.methods as any).claim().accounts({
        userAccount:   userPDA,
        user:          publicKey,
        userGemToken:  userGemAta,
        vaultGemToken: vaultPDA,
        tokenProgram:  TOKEN_PROGRAM_ID,
      }).rpc();

      setStatus(`Claimed ${(userState.totalGemSpent / 100).toFixed(2)} GEM!`, "success");
      await fetchData();
    } catch (err: any) {
      setStatus(err?.message ?? "Claim failed", "error");
    } finally { setClaimLoading(false); }
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const isRegistered  = userState?.initialized ?? false;
  const totalGemSpent = userState?.totalGemSpent ?? 0;
  const claimAmount   = totalGemSpent / 100;
  const msUntilClaim  = Math.max(0, (userState?.lastClaimTime ?? 0) * 1_000 + ONE_DAY_MS - now);
  const canClaim      = isRegistered && msUntilClaim === 0 && claimAmount > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#080810] text-white">
      {/* Grid bg */}
      <div className="fixed inset-0 bg-[linear-gradient(rgba(99,102,241,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.025)_1px,transparent_1px)] bg-[size:64px_64px] pointer-events-none" />
      <div className="fixed top-0 left-1/3 w-[500px] h-[500px] bg-indigo-600/8 rounded-full blur-[140px] pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-[400px] h-[400px] bg-cyan-600/6 rounded-full blur-[120px] pointer-events-none" />

      {/* Navbar */}
      <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#080810]/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center font-black text-xs">G</div>
            <span className="font-black text-lg tracking-tight">GEM FORSAGE</span>
            <Badge variant="outline" className="text-[10px] border-indigo-500/30 text-indigo-400 hidden sm:flex">DEVNET</Badge>
          </div>
          <div className="flex items-center gap-3">
            {isRegistered && <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs hidden sm:flex">● ACTIVE</Badge>}
            {isMounted && <WalletMultiButton />}
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-5">

        {/* Referral banner — show if URL has ?ref= and user not registered */}
        {referrerFromUrl && !isRegistered && (
          <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 px-4 py-3 flex items-center gap-3">
            <span className="text-indigo-400 text-lg">🔗</span>
            <div>
              <p className="text-sm font-bold text-white">You were referred by {shortKey(referrerFromUrl.toBase58())}</p>
              <p className="text-xs text-zinc-500">Register below — 60 GEM will go directly to your referrer.</p>
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Protocol Revenue", value: totalGemCollected.toLocaleString(), sub: "GEM collected", color: "text-white" },
            { label: "USD Value", value: gemToUsd(totalGemCollected, gemPrice), sub: "Live value", color: "text-emerald-400" },
            { label: "Total Members", value: totalUsers.toLocaleString(), sub: "Registered users", color: "text-indigo-400" },
            { label: "Total Referrals", value: totalReferrals.toLocaleString(), sub: "Referral joins", color: "text-cyan-400" },
          ].map((s) => (
            <Card key={s.label} className="bg-white/[0.025] border-white/6 backdrop-blur-sm">
              <CardContent className="p-4">
                <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1.5">{s.label}</p>
                <p className={`text-xl font-black font-mono ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-zinc-600 mt-0.5">{s.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Status */}
        {statusMsg && (
          <div className={`rounded-xl px-4 py-3 text-sm font-medium border ${
            statusType === "success" ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
            : statusType === "error" ? "bg-red-500/10 border-red-500/20 text-red-400"
            : "bg-indigo-500/10 border-indigo-500/20 text-indigo-400"
          }`}>
            {statusType === "success" ? "✓ " : statusType === "error" ? "✗ " : "· "}{statusMsg}
          </div>
        )}

        {!publicKey ? (
          <Card className="bg-white/[0.025] border-white/6">
            <CardContent className="py-16 flex flex-col items-center gap-4 text-center">
              <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-3xl">💎</div>
              <div>
                <p className="text-xl font-black mb-1">Connect Your Wallet</p>
                <p className="text-zinc-500 text-sm">Connect to access GEM FORSAGE matrix protocol</p>
              </div>
              {isMounted && <WalletMultiButton />}
            </CardContent>
          </Card>
        ) : !isRegistered ? (
          /* Registration card */
          <Card className="bg-white/[0.025] border-white/6 overflow-hidden">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-xl">🚀</div>
                <div>
                  <CardTitle className="text-white text-lg">Register to GEM FORSAGE</CardTitle>
                  <CardDescription className="text-zinc-500">
                    {referrerFromUrl ? `Referred by ${shortKey(referrerFromUrl.toBase58())}` : "No referrer — admin receives your entry fee"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <Separator className="bg-white/5" />
            <CardContent className="pt-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
                <div className="rounded-xl bg-white/[0.02] border border-white/5 p-4">
                  <p className="text-xs text-zinc-600 mb-1">Entry Fee</p>
                  <p className="text-2xl font-black text-white">100 <span className="text-sm text-zinc-500">GEM</span></p>
                  <p className="text-xs text-emerald-500 mt-0.5">≈ {gemToUsd(100, gemPrice)}</p>
                </div>
                <div className="rounded-xl bg-white/[0.02] border border-white/5 p-4">
                  <p className="text-xs text-zinc-600 mb-1">Payment Split</p>
                  <p className="text-sm font-bold text-white">60 GEM → Referrer</p>
                  <p className="text-xs text-zinc-600 mt-0.5">40 GEM → Protocol vault</p>
                </div>
                <div className="rounded-xl bg-white/[0.02] border border-white/5 p-4">
                  <p className="text-xs text-zinc-600 mb-1">You Get</p>
                  <p className="text-sm font-bold text-white">X3 + X6 Level 0</p>
                  <p className="text-xs text-zinc-600 mt-0.5">+ Daily 1% GEM reward</p>
                </div>
              </div>
              {isAdmin ? (
                <button onClick={handleGenesisRegister} disabled={loading}
                  className="w-full py-4 rounded-xl bg-yellow-600 hover:bg-yellow-500 font-black text-lg transition-all text-black shadow-lg shadow-yellow-600/20">
                  {loading ? "Processing…" : "Initialize Genesis Admin Account"}
                </button>
              ) : (
                <button onClick={handleRegister} disabled={loading}
                  className="w-full py-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-black text-lg transition-all disabled:opacity-50 shadow-lg shadow-indigo-600/20">
                  {loading ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Processing…</span> : "Register · 100 GEM"}
                </button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-5">

            {/* Referral card */}
            <Card className="bg-white/[0.025] border-white/6">
              <CardContent className="p-5">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <p className="text-xs text-zinc-600 uppercase tracking-widest mb-1">Your Referral Link</p>
                    <p className="text-sm font-mono text-zinc-400 break-all">{referralLink || "Loading…"}</p>
                    <p className="text-xs text-zinc-600 mt-1">
                      Share this link · You earn <span className="text-emerald-400 font-bold">60 GEM</span> per referral
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 min-w-[120px]">
                    <button onClick={copyReferralLink}
                      className="px-5 py-2.5 rounded-xl bg-white/[0.04] border border-white/8 hover:bg-white/[0.07] font-bold text-sm transition-all">
                      {copied ? "✓ Copied!" : "Copy Link"}
                    </button>
                    <div className="text-center">
                      <p className="text-xs text-zinc-600">{userState?.directReferrals ?? 0} direct</p>
                      <p className="text-xs text-zinc-600">{userState?.totalReferrals ?? 0} total</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Stats row for user */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "Total Spent", value: `${(userState?.totalGemSpent ?? 0).toLocaleString()} GEM`, color: "text-white" },
                { label: "Total Earned", value: `${(userState?.totalEarned ?? 0).toFixed(2)} GEM`, color: "text-emerald-400" },
                { label: "X3 Cycles", value: userState?.x3MatrixCount ?? 0, color: "text-indigo-400" },
                { label: "X6 Cycles", value: userState?.x6MatrixCount ?? 0, color: "text-cyan-400" },
              ].map((s) => (
                <Card key={s.label} className="bg-white/[0.025] border-white/6">
                  <CardContent className="p-4">
                    <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1">{s.label}</p>
                    <p className={`text-lg font-black font-mono ${s.color}`}>{s.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Daily claim */}
            <Card className={`border-white/6 overflow-hidden ${canClaim ? "bg-yellow-500/5 border-yellow-500/20" : "bg-white/[0.025]"}`}>
              <CardContent className="p-5">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${canClaim ? "bg-yellow-500/10 border border-yellow-500/20" : "bg-white/[0.02] border border-white/5"}`}>💎</div>
                    <div>
                      <p className="text-xs text-zinc-600 uppercase tracking-widest mb-1">Daily Reward</p>
                      <p className="text-2xl font-black font-mono text-white">{claimAmount.toFixed(2)} <span className="text-sm text-zinc-500">GEM</span></p>
                      <p className="text-xs text-zinc-600">1% of {totalGemSpent.toLocaleString()} GEM spent · <span className="text-emerald-500">{gemToUsd(claimAmount, gemPrice)}</span></p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <button onClick={handleClaim} disabled={!canClaim || claimLoading}
                      className={`px-8 py-3 rounded-xl font-black text-sm transition-all ${canClaim ? "bg-yellow-500 hover:bg-yellow-400 text-black shadow-lg shadow-yellow-500/20" : "bg-white/[0.03] border border-white/8 text-zinc-600 cursor-not-allowed"}`}>
                      {claimLoading ? "Claiming…" : canClaim ? "Claim Now" : "Claim"}
                    </button>
                    {msUntilClaim > 0 && <p className="text-xs text-zinc-600 font-mono">{formatCountdown(msUntilClaim)}</p>}
                    {(userState?.lastClaimTime ?? 0) === 0 && <p className="text-xs text-emerald-500">Available now</p>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Matrix levels */}
            <Card className="bg-white/[0.025] border-white/6">
              <CardHeader className="pb-0">
                <CardTitle className="text-white text-base">Matrix Levels</CardTitle>
                <CardDescription className="text-zinc-500 text-xs">60% of each payment flows directly to your referrer's wallet</CardDescription>
              </CardHeader>
              <CardContent className="pt-4">
                <Tabs defaultValue="x3">
                  <TabsList className="bg-white/[0.03] border border-white/8 mb-5 w-full sm:w-auto">
                    <TabsTrigger value="x3" className="data-[state=active]:bg-indigo-600 data-[state=active]:text-white font-bold flex-1 sm:flex-none">
                      X3 Matrix
                      {userState?.isBlockedX3 && <span className="ml-2 text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">BLOCKED</span>}
                    </TabsTrigger>
                    <TabsTrigger value="x6" className="data-[state=active]:bg-cyan-600 data-[state=active]:text-white font-bold flex-1 sm:flex-none">
                      X6 Matrix
                      {userState?.isBlockedX6 && <span className="ml-2 text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">BLOCKED</span>}
                    </TabsTrigger>
                  </TabsList>

                  {(["x3", "x6"] as const).map((matrix) => {
                    const currentLevel  = matrix === "x3" ? (userState?.x3Level ?? 0) : (userState?.x6Level ?? 0);
                    const slotsFilled   = matrix === "x3" ? (userState?.x3SlotsFilled ?? 0) : (userState?.x6SlotsFilled ?? 0);
                    const matrixCount   = matrix === "x3" ? (userState?.x3MatrixCount ?? 0) : (userState?.x6MatrixCount ?? 0);
                    const totalSlots    = matrix === "x3" ? 3 : 6;
                    const isBlocked     = matrix === "x3" ? userState?.isBlockedX3 : userState?.isBlockedX6;
                    const nextLevel     = currentLevel + 1;
                    const costs         = MATRIX_LEVELS[matrix];
                    const slotProgress  = (slotsFilled / totalSlots) * 100;

                    return (
                      <TabsContent key={matrix} value={matrix} className="mt-0">

                        {/* Matrix slot visualization */}
                        <div className="rounded-xl bg-white/[0.02] border border-white/5 p-4 mb-5">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <p className="text-xs text-zinc-600 uppercase tracking-widest">Current Matrix</p>
                              <p className="text-sm font-bold text-white mt-0.5">
                                Cycle #{matrixCount + 1} · {slotsFilled}/{totalSlots} slots filled
                              </p>
                            </div>
                            <Badge className={`${matrix === "x3" ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" : "bg-cyan-500/10 text-cyan-400 border-cyan-500/20"} font-black`}>
                              {matrix.toUpperCase()}
                            </Badge>
                          </div>
                          <Progress value={slotProgress} className="h-2 bg-white/5 mb-2" />
                          <div className="flex gap-2 mt-3">
                            {Array.from({ length: totalSlots }).map((_, i) => (
                              <div key={i} className={`flex-1 h-8 rounded-lg flex items-center justify-center text-xs font-bold transition-all ${
                                i < slotsFilled
                                  ? matrix === "x3" ? "bg-indigo-500/20 border border-indigo-500/40 text-indigo-400" : "bg-cyan-500/20 border border-cyan-500/40 text-cyan-400"
                                  : "bg-white/[0.02] border border-white/5 text-zinc-700"
                              }`}>
                                {i < slotsFilled ? "✓" : i + 1}
                              </div>
                            ))}
                          </div>
                          {isBlocked && (
                            <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
                              ⚠ You are blocked at this level. Upgrade to continue earning — incoming payments are bypassing you to your upline.
                            </div>
                          )}
                        </div>

                        {/* Level grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
                          {costs.map((cost, i) => {
                            const lvl      = i + 1;
                            const isActive = lvl <= currentLevel;
                            const isNext   = lvl === nextLevel;
                            return (
                              <div key={lvl} className={`relative rounded-xl p-3 border transition-all ${
                                isActive
                                  ? matrix === "x3" ? "bg-indigo-500/10 border-indigo-500/30" : "bg-cyan-500/10 border-cyan-500/30"
                                  : isNext ? "bg-white/[0.04] border-white/20" : "bg-white/[0.01] border-white/5 opacity-35"
                              }`}>
                                {isActive && <div className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full ${matrix === "x3" ? "bg-indigo-400" : "bg-cyan-400"}`} />}
                                {isNext && <Badge className="absolute -top-2 -right-2 text-[9px] bg-white text-black border-0 px-1.5 py-0 font-black">NEXT</Badge>}
                                <p className="text-[10px] text-zinc-600 uppercase tracking-widest">LVL {lvl}</p>
                                <p className="text-sm font-black text-white font-mono mt-0.5">{cost >= 1000 ? `${cost/1000}K` : cost}</p>
                                <p className="text-[10px] text-zinc-600">GEM</p>
                                <p className="text-[10px] text-emerald-600 mt-0.5">{gemToUsd(cost, gemPrice)}</p>
                              </div>
                            );
                          })}
                        </div>

                        <Separator className="bg-white/5 mb-4" />

                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm text-zinc-400">Level <span className="text-white font-bold">{currentLevel}</span> active</p>
                            {nextLevel <= 8 && (
                              <p className="text-xs text-zinc-600 mt-0.5">
                                Upgrade cost: {costs[nextLevel-1]?.toLocaleString()} GEM
                                {" · "}60% to your referrer
                              </p>
                            )}
                          </div>
                          {nextLevel <= 8 ? (
                            <button onClick={() => handleUpgrade(matrix)} disabled={loading}
                              className={`px-6 py-3 rounded-xl font-black text-sm transition-all disabled:opacity-50 ${
                                matrix === "x3" ? "bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-600/20" : "bg-cyan-600 hover:bg-cyan-500 shadow-lg shadow-cyan-600/20"
                              }`}>
                              {loading ? <span className="flex items-center gap-2"><span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"/>Processing…</span> : `Upgrade → LVL ${nextLevel}`}
                            </button>
                          ) : (
                            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-black">🏆 MAX LEVEL</Badge>
                          )}
                        </div>
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </CardContent>
            </Card>

            {/* Transaction history */}
            <Card className="bg-white/[0.025] border-white/6">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-base">Transaction History</CardTitle>
                <CardDescription className="text-zinc-500 text-xs">Last 10 on-chain transactions for your account</CardDescription>
              </CardHeader>
              <Separator className="bg-white/5" />
              <CardContent className="pt-4">
                {txHistory.length === 0 ? (
                  <p className="text-center text-zinc-600 text-sm py-6">No transactions yet</p>
                ) : (
                  <div className="space-y-2">
                    {txHistory.map((tx) => (
                      <div key={tx.signature} className="flex items-center justify-between rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${tx.status === "success" ? "bg-emerald-400" : "bg-red-400"}`} />
                          <div>
                            <p className="text-xs font-mono text-zinc-400">{shortKey(tx.signature)}</p>
                            <p className="text-[10px] text-zinc-600">{tx.time}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className={`text-[10px] ${tx.status === "success" ? "border-emerald-500/20 text-emerald-500" : "border-red-500/20 text-red-500"}`}>
                            {tx.status}
                          </Badge>
                          <a
                            href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[10px] text-indigo-400 hover:text-indigo-300 underline"
                          >
                            View ↗
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

          </div>
        )}
      </main>

      <footer className="border-t border-white/5 mt-12 py-6">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between text-xs text-zinc-700">
          <span>GEM FORSAGE Protocol · Powered by Solana</span>
          <span>60% direct · 40% vault</span>
        </div>
      </footer>
    </div>
  );
}

// ─── Root export wrapped in Suspense for useSearchParams ─────────────────────
export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#080810] flex items-center justify-center text-white">Loading…</div>}>
      <HomeInner />
    </Suspense>
  );
}