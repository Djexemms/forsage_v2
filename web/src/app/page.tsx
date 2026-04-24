"use client";
import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../forsage_v2.json";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";

// Constants
const PROGRAM_ID = new PublicKey("6W97AyDjAv4thPh1WohTPkdYwdC2TuP1yfYQy1oakHZe");
const GEM_MINT = new PublicKey("H2y3xXuZmCXYHgHkgmPr1q6SWBjzW3BjVzEyuEpSHn5e");
const ADMIN_WALLET = new PublicKey("6oWHZAJs2HACDk6QrZhbb6f9psuJME3FhiAg1kpaKK1Z");
const DECIMALS = 1_000_000_000;
const REGISTRATION_FEE = 100;
const ONE_DAY_MS = 86_400_000;

const MATRIX_LEVELS: Record<string, number[]> = {
  x3: [100, 200, 400, 800, 1600, 3200, 6400, 12800],
  x6: [100, 200, 400, 800, 1600, 3200, 6400, 12800],
};

// PDAs
const [statsPDA] = PublicKey.findProgramAddressSync([Buffer.from("global_stats")], PROGRAM_ID);
const [vaultPDA] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);

function getAdminPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("forsage_user"), ADMIN_WALLET.toBuffer()], PROGRAM_ID
  )[0];
}

function getUserPDA(wallet: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("forsage_user"), wallet.toBuffer()], PROGRAM_ID
  )[0];
}

// GEM Price Cache
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

// Helpers
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
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Types
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

// Diamond Icon Component
function DiamondIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 2L2 9L12 22L22 9L12 2Z" fill="url(#diamond-gradient)" stroke="url(#diamond-stroke)" strokeWidth="0.5"/>
      <path d="M2 9H22" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5"/>
      <path d="M12 2L8 9L12 22L16 9L12 2Z" fill="rgba(255,255,255,0.1)"/>
      <defs>
        <linearGradient id="diamond-gradient" x1="12" y1="2" x2="12" y2="22">
          <stop offset="0%" stopColor="#c084fc"/>
          <stop offset="50%" stopColor="#a855f7"/>
          <stop offset="100%" stopColor="#7c3aed"/>
        </linearGradient>
        <linearGradient id="diamond-stroke" x1="12" y1="2" x2="12" y2="22">
          <stop offset="0%" stopColor="#e879f9"/>
          <stop offset="100%" stopColor="#a855f7"/>
        </linearGradient>
      </defs>
    </svg>
  );
}

// Slot Component for Matrix Visualization
function MatrixSlot({ 
  filled, 
  index, 
  color 
}: { 
  filled: boolean; 
  index: number;
  color: "purple" | "pink";
}) {
  const baseClasses = "relative flex items-center justify-center rounded-xl transition-all duration-300 font-bold text-sm";
  const filledClasses = color === "purple" 
    ? "bg-gradient-to-br from-purple-500/30 to-violet-600/30 border-2 border-purple-400/60 text-purple-300 shadow-lg shadow-purple-500/20" 
    : "bg-gradient-to-br from-pink-500/30 to-rose-600/30 border-2 border-pink-400/60 text-pink-300 shadow-lg shadow-pink-500/20";
  const emptyClasses = "bg-white/[0.02] border-2 border-white/10 text-white/30";
  
  return (
    <div className={`${baseClasses} ${filled ? filledClasses : emptyClasses} aspect-square`}>
      {filled ? (
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
          <path d="M5 13L9 17L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : (
        <span className="text-lg">{index + 1}</span>
      )}
      {filled && (
        <div className={`absolute inset-0 rounded-xl ${color === "purple" ? "bg-purple-400/10" : "bg-pink-400/10"} animate-pulse`} />
      )}
    </div>
  );
}

// Matrix Card Component
function MatrixCard({
  matrix,
  currentLevel,
  slotsFilled,
  matrixCount,
  isBlocked,
  costs,
  gemPrice,
  loading,
  onUpgrade,
}: {
  matrix: "x3" | "x6";
  currentLevel: number;
  slotsFilled: number;
  matrixCount: number;
  isBlocked: boolean;
  costs: number[];
  gemPrice: number;
  loading: boolean;
  onUpgrade: () => void;
}) {
  const totalSlots = matrix === "x3" ? 3 : 6;
  const nextLevel = currentLevel + 1;
  const color = matrix === "x3" ? "purple" : "pink";
  const colorClasses = matrix === "x3" 
    ? { bg: "from-purple-500/20 to-violet-600/20", border: "border-purple-500/30", text: "text-purple-400", glow: "shadow-purple-500/20" }
    : { bg: "from-pink-500/20 to-rose-600/20", border: "border-pink-500/30", text: "text-pink-400", glow: "shadow-pink-500/20" };

  return (
    <Card className={`bg-gradient-to-br ${colorClasses.bg} ${colorClasses.border} border-2 backdrop-blur-xl overflow-hidden`}>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${matrix === "x3" ? "from-purple-500 to-violet-600" : "from-pink-500 to-rose-600"} flex items-center justify-center shadow-lg ${colorClasses.glow}`}>
              <span className="font-black text-white text-lg">{matrix.toUpperCase()}</span>
            </div>
            <div>
              <CardTitle className="text-white text-xl font-black">{matrix.toUpperCase()} Matrix</CardTitle>
              <CardDescription className={colorClasses.text}>
                Level {currentLevel} Active | Cycle #{matrixCount + 1}
              </CardDescription>
            </div>
          </div>
          {isBlocked && (
            <Badge className="bg-red-500/20 text-red-400 border border-red-500/40">
              BLOCKED
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Slot Visualization */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/60">Matrix Slots</span>
            <span className={`font-bold ${colorClasses.text}`}>{slotsFilled}/{totalSlots} Filled</span>
          </div>
          <div className={`grid ${matrix === "x3" ? "grid-cols-3" : "grid-cols-6"} gap-3`}>
            {Array.from({ length: totalSlots }).map((_, i) => (
              <MatrixSlot key={i} filled={i < slotsFilled} index={i} color={color} />
            ))}
          </div>
          <Progress 
            value={(slotsFilled / totalSlots) * 100} 
            className={`h-2 bg-white/5`}
          />
        </div>

        {/* Level Grid */}
        <div className="space-y-3">
          <span className="text-sm text-white/60">Level Progress</span>
          <div className="grid grid-cols-4 gap-2">
            {costs.map((cost, i) => {
              const lvl = i + 1;
              const isActive = lvl <= currentLevel;
              const isNext = lvl === nextLevel;
              return (
                <div 
                  key={lvl} 
                  className={`relative rounded-xl p-3 border-2 transition-all ${
                    isActive
                      ? `bg-gradient-to-br ${colorClasses.bg} ${colorClasses.border}`
                      : isNext 
                        ? "bg-white/[0.05] border-white/30 ring-2 ring-white/20" 
                        : "bg-white/[0.01] border-white/5 opacity-40"
                  }`}
                >
                  {isActive && (
                    <div className={`absolute top-2 right-2 w-2 h-2 rounded-full ${matrix === "x3" ? "bg-purple-400" : "bg-pink-400"} animate-pulse`} />
                  )}
                  {isNext && (
                    <Badge className="absolute -top-2 -right-2 text-[9px] bg-white text-black border-0 px-2 py-0.5 font-black shadow-lg">
                      NEXT
                    </Badge>
                  )}
                  <p className="text-[10px] text-white/40 uppercase tracking-widest">LVL {lvl}</p>
                  <p className="text-sm font-black text-white font-mono">{cost >= 1000 ? `${cost/1000}K` : cost}</p>
                  <p className="text-[10px] text-emerald-400">{gemToUsd(cost, gemPrice)}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Blocked Warning */}
        {isBlocked && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
            Upgrade required - payments are bypassing to your upline.
          </div>
        )}

        {/* Upgrade Button */}
        <div className="flex items-center justify-between pt-2">
          <div>
            {nextLevel <= 8 && (
              <p className="text-sm text-white/50">
                Upgrade: <span className="text-white font-bold">{costs[nextLevel-1]?.toLocaleString()} GEM</span>
              </p>
            )}
          </div>
          {nextLevel <= 8 ? (
            <button 
              onClick={onUpgrade} 
              disabled={loading}
              className={`px-6 py-3 rounded-xl font-black text-sm transition-all disabled:opacity-50 
                ${matrix === "x3" 
                  ? "bg-gradient-to-r from-purple-500 to-violet-600 hover:from-purple-400 hover:to-violet-500 shadow-lg shadow-purple-500/30" 
                  : "bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 hover:to-rose-500 shadow-lg shadow-pink-500/30"
                } text-white`}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"/>
                  Processing
                </span>
              ) : (
                `Upgrade to LVL ${nextLevel}`
              )}
            </button>
          ) : (
            <Badge className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-4 py-2 text-sm font-black">
              MAX LEVEL
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Main Component
function HomeInner() {
  const searchParams = useSearchParams();
  const { connection } = useConnection();
  const { publicKey, wallet } = useWallet();

  const [isMounted, setIsMounted] = useState(false);
  const [userState, setUserState] = useState<UserState | null>(null);
  const [gemPrice, setGemPrice] = useState(0.05);
  const [totalGemCollected, setTotalGemCollected] = useState(0);
  const [totalUsers, setTotalUsers] = useState(0);
  const [totalReferrals, setTotalReferrals] = useState(0);
  const [loading, setLoading] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [statusType, setStatusType] = useState<"success"|"error"|"info">("info");
  const [now, setNow] = useState(Date.now());
  const [txHistory, setTxHistory] = useState<TxRecord[]>([]);
  const [copied, setCopied] = useState(false);
  const [referralLink, setReferralLink] = useState("");

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
            x3Level: account.x3Level ?? 0,
            x6Level: account.x6Level ?? 0,
            x3SlotsFilled: account.x3SlotsFilled ?? 0,
            x6SlotsFilled: account.x6SlotsFilled ?? 0,
            x3MatrixCount: account.x3MatrixCount ?? 0,
            x6MatrixCount: account.x6MatrixCount ?? 0,
            totalGemSpent: (account.totalGemSpent?.toNumber() ?? 0) / DECIMALS,
            totalEarned: (account.totalEarned?.toNumber() ?? 0) / DECIMALS,
            lastClaimTime: account.lastClaimTime?.toNumber() ?? 0,
            isBlockedX3: account.isBlockedX3 ?? false,
            isBlockedX6: account.isBlockedX6 ?? false,
            directReferrals: account.directReferrals ?? 0,
            totalReferrals: account.totalReferrals ?? 0,
            referrer: account.referrer?.toBase58() ?? "",
            initialized: true,
          });
        } catch {
          setUserState({ x3Level:0,x6Level:0,x3SlotsFilled:0,x6SlotsFilled:0,x3MatrixCount:0,x6MatrixCount:0,totalGemSpent:0,totalEarned:0,lastClaimTime:0,isBlockedX3:false,isBlockedX6:false,directReferrals:0,totalReferrals:0,referrer:"",initialized:false });
        }

        try {
          const sigs = await connection.getSignaturesForAddress(userPDA, { limit: 10 });
          const records: TxRecord[] = sigs.map((s) => ({
            signature: s.signature,
            type: s.memo ?? "Transaction",
            amount: "-",
            time: s.blockTime ? new Date(s.blockTime * 1000).toLocaleString() : "-",
            status: s.err ? "failed" : "success",
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

  useEffect(() => {
    if (!publicKey) return;
    fetchData();
    const i = setInterval(fetchData, 30_000);
    return () => clearInterval(i);
  }, [publicKey, fetchData]);

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

  const isAdmin = publicKey?.toBase58() === ADMIN_WALLET.toBase58();

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

  const handleRegister = async () => {
    if (!publicKey) return;
    setLoading(true); setStatus("Registering...", "info");
    try {
      const program = getProgram();
      const userPDA = getUserPDA(publicKey);
      const userGemAta = await getAssociatedTokenAddress(GEM_MINT, publicKey);

      const referrerKey = referrerFromUrl ?? ADMIN_WALLET;
      const referrerPDA = getUserPDA(referrerKey);
      const referrerGemAta = await getAssociatedTokenAddress(GEM_MINT, referrerKey);

      await (program.methods as any)
        .register(referrerKey)
        .accounts({
          userAccount: userPDA,
          referrerAccount: referrerPDA,
          user: publicKey,
          globalStats: statsPDA,
          userGemToken: userGemAta,
          referrerGemToken: referrerGemAta,
          vaultGemToken: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setStatus("Registered successfully! 60 GEM sent to your referrer.", "success");
      await fetchData();
    } catch (err: any) {
      setStatus(err?.message ?? "Registration failed", "error");
    } finally { setLoading(false); }
  };

  const handleUpgrade = async (matrix: "x3" | "x6") => {
    if (!publicKey || !userState) return;
    const currentLevel = matrix === "x3" ? userState.x3Level : userState.x6Level;
    const nextLevel = currentLevel + 1;
    if (nextLevel > 8) return;
    const matrixArg = matrix === "x3" ? 0 : 1;

    setLoading(true); setStatus(`Upgrading ${matrix.toUpperCase()} to Level ${nextLevel}...`, "info");
    try {
      const program = getProgram();
      const userPDA = getUserPDA(publicKey);
      const userGemAta = await getAssociatedTokenAddress(GEM_MINT, publicKey);
      const referrerKey = userState.referrer ? new PublicKey(userState.referrer) : ADMIN_WALLET;
      const referrerPDA = getUserPDA(referrerKey);
      const referrerGemAta = await getAssociatedTokenAddress(GEM_MINT, referrerKey);

      await (program.methods as any)
        .upgradeLevel(matrixArg, nextLevel)
        .accounts({
          userAccount: userPDA,
          referrerAccount: referrerPDA,
          user: publicKey,
          globalStats: statsPDA,
          userGemToken: userGemAta,
          referrerGemToken: referrerGemAta,
          vaultGemToken: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      setStatus(`Level ${nextLevel} unlocked! 60% sent to your referrer.`, "success");
      await fetchData();
    } catch (err: any) {
      setStatus(err?.message ?? "Upgrade failed", "error");
    } finally { setLoading(false); }
  };

  const handleClaim = async () => {
    if (!publicKey || !userState) return;
    setClaimLoading(true); setStatus("Claiming...", "info");
    try {
      const program = getProgram();
      const userPDA = getUserPDA(publicKey);
      const userGemAta = await getAssociatedTokenAddress(GEM_MINT, publicKey);

      await (program.methods as any).claim().accounts({
        userAccount: userPDA,
        user: publicKey,
        userGemToken: userGemAta,
        vaultGemToken: vaultPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

      setStatus(`Claimed ${(userState.totalGemSpent / 100).toFixed(2)} GEM!`, "success");
      await fetchData();
    } catch (err: any) {
      setStatus(err?.message ?? "Claim failed", "error");
    } finally { setClaimLoading(false); }
  };

  const isRegistered = userState?.initialized ?? false;
  const totalGemSpent = userState?.totalGemSpent ?? 0;
  const claimAmount = totalGemSpent / 100;
  const msUntilClaim = Math.max(0, (userState?.lastClaimTime ?? 0) * 1_000 + ONE_DAY_MS - now);
  const canClaim = isRegistered && msUntilClaim === 0 && claimAmount > 0;

  return (
    <div className="min-h-screen bg-[#0a0612] text-white overflow-x-hidden">
      {/* Background Effects */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(168,85,247,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(168,85,247,0.03)_1px,transparent_1px)] bg-[size:60px_60px]" />
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-purple-600/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-pink-600/10 rounded-full blur-[150px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-violet-600/5 rounded-full blur-[200px]" />
      </div>

      {/* Navbar */}
      <nav className="sticky top-0 z-50 border-b border-purple-500/10 bg-[#0a0612]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 via-pink-500 to-violet-600 flex items-center justify-center shadow-lg shadow-purple-500/30">
                <DiamondIcon className="w-7 h-7" />
              </div>
              <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-purple-500 via-pink-500 to-violet-600 blur-lg opacity-50" />
            </div>
            <div>
              <span className="font-black text-2xl tracking-tight bg-gradient-to-r from-purple-400 via-pink-400 to-violet-400 bg-clip-text text-transparent">
                GEMSAGE
              </span>
              <div className="flex items-center gap-2 mt-0.5">
                <Badge variant="outline" className="text-[10px] border-purple-500/40 text-purple-400 px-2 py-0">
                  SOLANA
                </Badge>
                <Badge variant="outline" className="text-[10px] border-pink-500/40 text-pink-400 px-2 py-0">
                  DEVNET
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {isRegistered && (
              <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1 hidden sm:flex">
                <span className="w-2 h-2 bg-emerald-400 rounded-full mr-2 animate-pulse" />
                ACTIVE
              </Badge>
            )}
            {isMounted && <WalletMultiButton />}
          </div>
        </div>
      </nav>

      <main className="relative max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">

        {/* Referral Banner */}
        {referrerFromUrl && !isRegistered && (
          <div className="rounded-2xl bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/20 px-6 py-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </div>
            <div>
              <p className="text-base font-bold text-white">Referred by {shortKey(referrerFromUrl.toBase58())}</p>
              <p className="text-sm text-purple-300/70">Register below - 60 GEM goes directly to your referrer</p>
            </div>
          </div>
        )}

        {/* Stats Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Protocol Revenue", value: totalGemCollected.toLocaleString(), sub: "GEM Collected", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z", color: "purple" },
            { label: "USD Value", value: gemToUsd(totalGemCollected, gemPrice), sub: "Live Value", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z", color: "emerald" },
            { label: "Total Members", value: totalUsers.toLocaleString(), sub: "Registered Users", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z", color: "pink" },
            { label: "Total Referrals", value: totalReferrals.toLocaleString(), sub: "Network Growth", icon: "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1", color: "violet" },
          ].map((s) => (
            <Card key={s.label} className="bg-white/[0.02] border-white/5 backdrop-blur-sm hover:bg-white/[0.04] transition-all">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    s.color === "purple" ? "bg-purple-500/10 text-purple-400" :
                    s.color === "emerald" ? "bg-emerald-500/10 text-emerald-400" :
                    s.color === "pink" ? "bg-pink-500/10 text-pink-400" :
                    "bg-violet-500/10 text-violet-400"
                  }`}>
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={s.icon} />
                    </svg>
                  </div>
                </div>
                <p className="text-xs text-white/40 uppercase tracking-widest mb-1">{s.label}</p>
                <p className={`text-2xl font-black font-mono ${
                  s.color === "purple" ? "text-white" :
                  s.color === "emerald" ? "text-emerald-400" :
                  s.color === "pink" ? "text-pink-400" :
                  "text-violet-400"
                }`}>{s.value}</p>
                <p className="text-xs text-white/30 mt-1">{s.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Status Message */}
        {statusMsg && (
          <div className={`rounded-2xl px-5 py-4 text-sm font-medium border flex items-center gap-3 ${
            statusType === "success" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
            : statusType === "error" ? "bg-red-500/10 border-red-500/30 text-red-400"
            : "bg-purple-500/10 border-purple-500/30 text-purple-400"
          }`}>
            {statusType === "success" ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : statusType === "error" ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            {statusMsg}
          </div>
        )}

        {!publicKey ? (
          /* Connect Wallet Card */
          <Card className="bg-gradient-to-br from-purple-500/5 to-pink-500/5 border-purple-500/20 backdrop-blur-xl">
            <CardContent className="py-20 flex flex-col items-center gap-6 text-center">
              <div className="relative">
                <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/30 flex items-center justify-center">
                  <DiamondIcon className="w-12 h-12" />
                </div>
                <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-purple-500 to-pink-500 blur-2xl opacity-20 animate-pulse" />
              </div>
              <div>
                <p className="text-3xl font-black mb-2 bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                  Connect Your Wallet
                </p>
                <p className="text-white/50 text-lg max-w-md">
                  Connect to access the GEMSAGE matrix protocol and start earning GEM tokens
                </p>
              </div>
              {isMounted && <WalletMultiButton />}
            </CardContent>
          </Card>
        ) : !isRegistered ? (
          /* Registration Card */
          <Card className="bg-gradient-to-br from-purple-500/5 to-pink-500/5 border-purple-500/20 backdrop-blur-xl overflow-hidden">
            <CardHeader className="pb-6">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/30 flex items-center justify-center">
                  <svg className="w-7 h-7 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                  </svg>
                </div>
                <div>
                  <CardTitle className="text-white text-2xl font-black">Join GEMSAGE</CardTitle>
                  <CardDescription className="text-purple-300/70 text-base">
                    {referrerFromUrl ? `Referred by ${shortKey(referrerFromUrl.toBase58())}` : "Start your matrix journey today"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <Separator className="bg-purple-500/10" />
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-5">
                  <p className="text-xs text-white/40 uppercase tracking-widest mb-2">Entry Fee</p>
                  <p className="text-3xl font-black text-white">100 <span className="text-sm text-white/40">GEM</span></p>
                  <p className="text-sm text-emerald-400 mt-1">{gemToUsd(100, gemPrice)}</p>
                </div>
                <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-5">
                  <p className="text-xs text-white/40 uppercase tracking-widest mb-2">Payment Split</p>
                  <p className="text-lg font-bold text-white">60 GEM to Referrer</p>
                  <p className="text-sm text-white/40 mt-1">40 GEM to Protocol</p>
                </div>
                <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-5">
                  <p className="text-xs text-white/40 uppercase tracking-widest mb-2">You Unlock</p>
                  <p className="text-lg font-bold text-white">X3 + X6 Level 0</p>
                  <p className="text-sm text-white/40 mt-1">+ Daily 1% Rewards</p>
                </div>
              </div>
              {isAdmin ? (
                <button onClick={handleGenesisRegister} disabled={loading}
                  className="w-full py-5 rounded-2xl bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 font-black text-xl transition-all text-black shadow-lg shadow-yellow-500/30">
                  {loading ? "Processing..." : "Initialize Genesis Admin"}
                </button>
              ) : (
                <button onClick={handleRegister} disabled={loading}
                  className="w-full py-5 rounded-2xl bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-400 hover:to-pink-400 font-black text-xl transition-all disabled:opacity-50 shadow-lg shadow-purple-500/30 text-white">
                  {loading ? (
                    <span className="flex items-center justify-center gap-3">
                      <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"/>
                      Processing...
                    </span>
                  ) : (
                    "Register - 100 GEM"
                  )}
                </button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">

            {/* Referral Card */}
            <Card className="bg-gradient-to-r from-purple-500/5 to-pink-500/5 border-purple-500/20 backdrop-blur-xl">
              <CardContent className="p-6">
                <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
                  <div className="flex-1">
                    <p className="text-xs text-white/40 uppercase tracking-widest mb-2">Your Referral Link</p>
                    <p className="text-sm font-mono text-purple-300 break-all bg-white/[0.02] rounded-xl px-4 py-3 border border-purple-500/20">
                      {referralLink || "Loading..."}
                    </p>
                    <p className="text-sm text-white/40 mt-2">
                      Earn <span className="text-emerald-400 font-bold">60 GEM</span> for each referral
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 min-w-[160px]">
                    <button onClick={copyReferralLink}
                      className="px-6 py-3 rounded-xl bg-gradient-to-r from-purple-500/20 to-pink-500/20 border border-purple-500/40 hover:from-purple-500/30 hover:to-pink-500/30 font-bold text-sm transition-all text-white">
                      {copied ? "Copied!" : "Copy Link"}
                    </button>
                    <div className="flex justify-between text-sm px-2">
                      <span className="text-white/40">{userState?.directReferrals ?? 0} direct</span>
                      <span className="text-white/40">{userState?.totalReferrals ?? 0} total</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* User Stats & Daily Claim Combined */}
            <Card className="bg-gradient-to-br from-purple-500/5 via-transparent to-pink-500/5 border-purple-500/20 backdrop-blur-xl overflow-hidden">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/30 flex items-center justify-center">
                    <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle className="text-white text-xl font-black">Your Dashboard</CardTitle>
                    <CardDescription className="text-purple-300/70">Account statistics and daily rewards</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Stats Grid */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rounded-2xl bg-gradient-to-br from-white/[0.03] to-white/[0.01] border-2 border-white/10 p-5 hover:border-purple-500/30 transition-all">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                        <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2" />
                        </svg>
                      </div>
                      <p className="text-xs text-white/50 uppercase tracking-wider font-bold">Total Spent</p>
                    </div>
                    <p className="text-3xl font-black text-white font-mono">{(userState?.totalGemSpent ?? 0).toLocaleString()}</p>
                    <p className="text-sm text-purple-400 font-medium">GEM</p>
                    <p className="text-xs text-emerald-400 mt-1">{gemToUsd(userState?.totalGemSpent ?? 0, gemPrice)}</p>
                  </div>
                  
                  <div className="rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-2 border-emerald-500/20 p-5 hover:border-emerald-500/40 transition-all">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                        <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                        </svg>
                      </div>
                      <p className="text-xs text-white/50 uppercase tracking-wider font-bold">Total Earned</p>
                    </div>
                    <p className="text-3xl font-black text-emerald-400 font-mono">{(userState?.totalEarned ?? 0).toFixed(2)}</p>
                    <p className="text-sm text-emerald-400/70 font-medium">GEM</p>
                    <p className="text-xs text-emerald-400 mt-1">{gemToUsd(userState?.totalEarned ?? 0, gemPrice)}</p>
                  </div>
                  
                  <div className="rounded-2xl bg-gradient-to-br from-purple-500/10 to-purple-500/5 border-2 border-purple-500/20 p-5 hover:border-purple-500/40 transition-all">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                        <span className="text-xs font-black text-purple-400">X3</span>
                      </div>
                      <p className="text-xs text-white/50 uppercase tracking-wider font-bold">X3 Cycles</p>
                    </div>
                    <p className="text-3xl font-black text-purple-400 font-mono">{userState?.x3MatrixCount ?? 0}</p>
                    <p className="text-sm text-purple-400/70 font-medium">Completed</p>
                  </div>
                  
                  <div className="rounded-2xl bg-gradient-to-br from-pink-500/10 to-pink-500/5 border-2 border-pink-500/20 p-5 hover:border-pink-500/40 transition-all">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-8 h-8 rounded-lg bg-pink-500/10 flex items-center justify-center">
                        <span className="text-xs font-black text-pink-400">X6</span>
                      </div>
                      <p className="text-xs text-white/50 uppercase tracking-wider font-bold">X6 Cycles</p>
                    </div>
                    <p className="text-3xl font-black text-pink-400 font-mono">{userState?.x6MatrixCount ?? 0}</p>
                    <p className="text-sm text-pink-400/70 font-medium">Completed</p>
                  </div>
                </div>

                <Separator className="bg-white/5" />

                {/* Daily Claim Section */}
                <div className={`rounded-2xl p-6 border-2 transition-all ${canClaim ? "bg-gradient-to-r from-yellow-500/10 via-orange-500/10 to-yellow-500/10 border-yellow-500/30 shadow-lg shadow-yellow-500/10" : "bg-white/[0.02] border-white/10"}`}>
                  <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
                    <div className="flex items-center gap-5">
                      <div className={`w-20 h-20 rounded-2xl flex items-center justify-center relative ${canClaim ? "bg-gradient-to-br from-yellow-500/30 to-orange-500/30 border-2 border-yellow-500/50" : "bg-white/[0.03] border-2 border-white/10"}`}>
                        <DiamondIcon className="w-10 h-10" />
                        {canClaim && (
                          <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-yellow-500/20 to-orange-500/20 animate-pulse" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm text-white/50 uppercase tracking-widest font-bold mb-1">Daily Reward</p>
                        <p className="text-4xl font-black font-mono text-white">{claimAmount.toFixed(2)} <span className="text-xl text-white/40">GEM</span></p>
                        <div className="flex items-center gap-3 mt-2">
                          <p className="text-sm text-white/50">1% of {totalGemSpent.toLocaleString()} GEM spent</p>
                          <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs">{gemToUsd(claimAmount, gemPrice)}</Badge>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-start lg:items-end gap-3 w-full lg:w-auto">
                      <button onClick={handleClaim} disabled={!canClaim || claimLoading}
                        className={`w-full lg:w-auto px-10 py-4 rounded-2xl font-black text-lg transition-all ${canClaim ? "bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 text-black shadow-xl shadow-yellow-500/30 hover:scale-105" : "bg-white/[0.03] border-2 border-white/10 text-white/30 cursor-not-allowed"}`}>
                        {claimLoading ? (
                          <span className="flex items-center justify-center gap-2">
                            <span className="w-5 h-5 border-2 border-black/30 border-t-black rounded-full animate-spin"/>
                            Claiming...
                          </span>
                        ) : canClaim ? "Claim Now" : "Claim"}
                      </button>
                      {msUntilClaim > 0 && (
                        <div className="flex items-center gap-2 text-white/50">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <p className="text-sm font-mono">{formatCountdown(msUntilClaim)}</p>
                        </div>
                      )}
                      {(userState?.lastClaimTime ?? 0) === 0 && (
                        <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1">
                          <span className="w-2 h-2 bg-emerald-400 rounded-full mr-2 animate-pulse inline-block" />
                          Available now
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Matrix Cards - X3 on top, X6 below */}
            <div className="space-y-6">
              <MatrixCard
                matrix="x3"
                currentLevel={userState?.x3Level ?? 0}
                slotsFilled={userState?.x3SlotsFilled ?? 0}
                matrixCount={userState?.x3MatrixCount ?? 0}
                isBlocked={userState?.isBlockedX3 ?? false}
                costs={MATRIX_LEVELS.x3}
                gemPrice={gemPrice}
                loading={loading}
                onUpgrade={() => handleUpgrade("x3")}
              />
              <MatrixCard
                matrix="x6"
                currentLevel={userState?.x6Level ?? 0}
                slotsFilled={userState?.x6SlotsFilled ?? 0}
                matrixCount={userState?.x6MatrixCount ?? 0}
                isBlocked={userState?.isBlockedX6 ?? false}
                costs={MATRIX_LEVELS.x6}
                gemPrice={gemPrice}
                loading={loading}
                onUpgrade={() => handleUpgrade("x6")}
              />
            </div>

            {/* Transaction History */}
            <Card className="bg-white/[0.02] border-white/5">
              <CardHeader className="pb-4">
                <CardTitle className="text-white text-xl font-black">Transaction History</CardTitle>
                <CardDescription className="text-white/40">Last 10 on-chain transactions</CardDescription>
              </CardHeader>
              <Separator className="bg-white/5" />
              <CardContent className="pt-5">
                {txHistory.length === 0 ? (
                  <p className="text-center text-white/30 py-10">No transactions yet</p>
                ) : (
                  <div className="space-y-3">
                    {txHistory.map((tx) => (
                      <div key={tx.signature} className="flex items-center justify-between rounded-xl bg-white/[0.02] border border-white/5 px-5 py-4 hover:bg-white/[0.04] transition-all">
                        <div className="flex items-center gap-4">
                          <div className={`w-3 h-3 rounded-full ${tx.status === "success" ? "bg-emerald-400" : "bg-red-400"}`} />
                          <div>
                            <p className="text-sm font-mono text-white/70">{shortKey(tx.signature)}</p>
                            <p className="text-xs text-white/30">{tx.time}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <Badge variant="outline" className={`text-xs ${tx.status === "success" ? "border-emerald-500/30 text-emerald-400" : "border-red-500/30 text-red-400"}`}>
                            {tx.status}
                          </Badge>
                          <a
                            href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-purple-400 hover:text-purple-300 underline"
                          >
                            View
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

      {/* Contacts Section */}
      <section className="border-t border-purple-500/10 mt-16 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex flex-col items-center gap-6">
            <h2 className="text-lg font-bold text-white/60 uppercase tracking-widest">Connect With Us</h2>
            <div className="flex items-center gap-6">
              {/* Twitter/X */}
              <a
                href="YOUR_TWITTER_LINK_HERE"
                target="_blank"
                rel="noopener noreferrer"
                className="group w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center hover:bg-purple-500/20 hover:border-purple-500/40 transition-all"
                title="Twitter/X"
              >
                <svg className="w-6 h-6 text-white/50 group-hover:text-purple-400 transition-colors" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
              </a>
              
              {/* Telegram */}
              <a
                href="https://t.me/gemdotfun"
                target="_blank"
                rel="noopener noreferrer"
                className="group w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center hover:bg-pink-500/20 hover:border-pink-500/40 transition-all"
                title="Telegram"
              >
                <svg className="w-6 h-6 text-white/50 group-hover:text-pink-400 transition-colors" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                </svg>
              </a>
              
              {/* Contract Address */}
              <a
                href="YOUR_CA_EXPLORER_LINK_HERE"
                target="_blank"
                rel="noopener noreferrer"
                className="group w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center hover:bg-violet-500/20 hover:border-violet-500/40 transition-all"
                title="Contract Address"
              >
                <svg className="w-6 h-6 text-white/50 group-hover:text-violet-400 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="20" height="12" rx="2"/>
                  <path d="M12 12h.01"/>
                  <path d="M17 12h.01"/>
                  <path d="M7 12h.01"/>
                </svg>
              </a>
            </div>
            <p className="text-sm text-white/30 text-center max-w-md">
              Join our community for updates, support, and to connect with fellow GEM holders
              Contract Address: HP2CkBUBPXhWkAUfjPhjRjuh28649byiwyfZw3fLGQtp
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-purple-500/10 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <div className="flex items-center gap-3">
            <DiamondIcon className="w-5 h-5" />
            <span>GEMSAGE Protocol</span>
            <span className="text-white/10">|</span>
            <span>Powered by Solana</span>
          </div>
          <span>60% Direct Referral | 40% Protocol Vault</span>
        </div>
      </footer>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#0a0612] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
          <span className="text-purple-400 font-medium">Loading GEMSAGE...</span>
        </div>
      </div>
    }>
      <HomeInner />
    </Suspense>
  );
}
