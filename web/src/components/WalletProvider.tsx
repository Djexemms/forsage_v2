"use client";
import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { ConnectionConfig } from '@solana/web3.js';
import '@solana/wallet-adapter-react-ui/styles.css';

const HELIUS_RPC = "https://api.devnet.solana.com";

// Aggressive config to minimize RPC calls
const CONNECTION_CONFIG: ConnectionConfig = {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
  confirmTransactionInitialTimeout: 60000,
};

export const SolanaWalletProvider = ({ children }: { children: React.ReactNode }) => {
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider
      endpoint={HELIUS_RPC}
      config={CONNECTION_CONFIG}
    >
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};