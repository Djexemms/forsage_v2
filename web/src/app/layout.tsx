import "./globals.css";
import { SolanaWalletProvider } from "../components/WalletProvider";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>CoreSage — Decentralized Matrix Protocol</title>
        <meta name="description" content="CoreSage X3 & X6 GEM Matrix Protocol on Solana" />
      </head>
      <body className="font-sans antialiased">
        <SolanaWalletProvider>{children}</SolanaWalletProvider>
      </body>
    </html>
  );
}