import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, web3, BN } from "@project-serum/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { WalletState, ICOData, TransactionResult } from "../types/solana";
import { ICOProgramIdl } from "../types/idl";
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

import IDL from "../lib/idl.json";

// Dynamically import WalletMultiButton with SSR disabled
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

const ENV_PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID;
const ENV_ICO_MINT = process.env.NEXT_PUBLIC_ICO_MINT;
const ENV_LAMPORTS_PER_TOKEN = process.env.NEXT_PUBLIC_LAMPORTS_PER_TOKEN;
const ENV_MAX_USER_TOTAL_LIMIT = process.env.NEXT_PUBLIC_MAX_USER_TOTAL_LIMIT;
const ENV_TOKEN_DECIMALS = process.env.NEXT_PUBLIC_TOKEN_DECIMALS;

// Program constants
const PROGRAM_ID = new PublicKey(ENV_PROGRAM_ID!);
const ICO_MINT = new PublicKey(ENV_ICO_MINT!);
const TOKEN_DECIMALS = new BN(ENV_TOKEN_DECIMALS || "1000000000");
const MAX_USER_TOTAL_LIMIT = parseInt(ENV_MAX_USER_TOTAL_LIMIT || "2000"); // Maximum tokens per user total
const LAMPORTS_PER_SOL = 1_000_000_000;
const LAMPORTS_PER_TOKEN = parseInt(ENV_LAMPORTS_PER_TOKEN || "1000000"); // Default to 0.001 SOL if not set

interface ICOState {
  loading: boolean;
  isAdmin: boolean;
  icoData: ICOData | null;
  amount: string;
  userTokenBalance: number | null;
  depositAmount: string;
}

export default function Home() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [state, setState] = useState<ICOState>({
    loading: false,
    isAdmin: false,
    icoData: null,
    amount: "",
    userTokenBalance: null,
    depositAmount: "",
  });

  // Function to get program instance without requiring wallet connection
  const getProgramReadOnly = () => {
    const provider = new AnchorProvider(
      connection,
      {} as any,
      { commitment: "confirmed" }
    );
    return new Program(IDL as ICOProgramIdl, PROGRAM_ID, provider);
  };

  // Separate useEffect for fetching ICO data (no wallet required)
  useEffect(() => {
    fetchIcoData();
  }, []);

  // useEffect for wallet-dependent operations
  useEffect(() => {
    if (wallet.connected) {
      checkIfAdmin();
      fetchUserTokenBalance();
    } else {
      setState(prev => ({
        ...prev,
        isAdmin: false,
        userTokenBalance: null
      }));
    }
  }, [wallet.connected]);

  const getProgram = () => {
    if (!wallet.connected || !wallet.publicKey) return null;
    
    const anchorWallet = {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction!,
      signAllTransactions: wallet.signAllTransactions!,
    };

    const provider = new AnchorProvider(connection, anchorWallet, {
      commitment: "confirmed",
    });
    
    return new Program(IDL as ICOProgramIdl, PROGRAM_ID, provider);
  };

  const fetchIcoData = async () => {
    try {
      const program = getProgramReadOnly();
      const accounts = await program.account.data.all();
      if (accounts.length > 0) {
        setState(prev => ({ ...prev, icoData: accounts[0].account as ICOData }));
      }
    } catch (error) {
      console.error("Error fetching ICO data:", error);
    }
  };

  const checkIfAdmin = async () => {
    try {
      const program = getProgram();
      if (!program) return;

      console.log("Checking admin status for:", wallet.publicKey?.toString());

      const [dataPda] = await PublicKey.findProgramAddress(
        [Buffer.from("data"), wallet.publicKey!.toBuffer()],
        program.programId
      );

      try {
        const data = await program.account.data.fetch(dataPda);
        setState(prev => ({ ...prev, isAdmin: data.admin.equals(wallet.publicKey!) }));
      } catch (_e) {
        const accounts = await program.account.data.all();
        if (accounts.length === 0) {
          setState(prev => ({ ...prev, isAdmin: true })); // First user becomes admin
        } else {
          setState(prev => ({ 
            ...prev, 
            isAdmin: false,
            icoData: accounts[0].account as ICOData
          }));
        }
      }
    } catch (err) {
      console.error("Error checking admin:", err);
      setState(prev => ({ ...prev, isAdmin: false }));
    }
  };

  const createIcoAta = async () => {
    try {
      if (!state.amount || parseInt(state.amount) <= 0) {
        notify("Please enter a valid amount", "error");
        return;
      }

      setState(prev => ({ ...prev, loading: true }));
      const program = getProgram();
      if (!program) return;

      const [icoAtaPda] = await PublicKey.findProgramAddress(
        [ICO_MINT.toBuffer()],
        program.programId
      );

      const [dataPda] = await PublicKey.findProgramAddress(
        [Buffer.from("data"), wallet.publicKey!.toBuffer()],
        program.programId
      );

      const adminIcoAta = await getAssociatedTokenAddress(
        ICO_MINT,
        wallet.publicKey!
      );

      await program.methods
        .createIcoAta(new BN(state.amount))
        .accounts({
          icoAtaForIcoProgram: icoAtaPda,
          data: dataPda,
          icoMint: ICO_MINT,
          icoAtaForAdmin: adminIcoAta,
          admin: wallet.publicKey!,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      notify("ICO initialized successfully!", "success");
      await fetchIcoData();
    } catch (error) {
      console.error("Error initializing ICO:", error);
      notify(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, "error");
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  };

  const depositIco = async () => {
    try {
      if (!state.amount || parseInt(state.amount) <= 0) {
        notify("Please enter a valid amount", "error");
        return;
      }

      setState(prev => ({ ...prev, loading: true }));
      const program = getProgram();
      if (!program) return;

      const [icoAtaPda] = await PublicKey.findProgramAddress(
        [ICO_MINT.toBuffer()],
        program.programId
      );

      const [dataPda] = await PublicKey.findProgramAddress(
        [Buffer.from("data"), wallet.publicKey!.toBuffer()],
        program.programId
      );

      const adminIcoAta = await getAssociatedTokenAddress(
        ICO_MINT,
        wallet.publicKey!
      );

      await program.methods
        .depositIcoInAta(new BN(state.amount))
        .accounts({
          icoAtaForIcoProgram: icoAtaPda,
          data: dataPda,
          icoMint: ICO_MINT,
          icoAtaForAdmin: adminIcoAta,
          admin: wallet.publicKey!,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      notify("Tokens deposited successfully!", "success");
      await fetchIcoData();
    } catch (err) {
      console.error("Error depositing:", err);
      notify(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`, "error");
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  };

  const buyTokens = async () => {
    try {
      if (!state.amount || parseInt(state.amount) <= 0) {
        notify("Please enter a valid amount", "error");
        return;
      }

      const amount = parseInt(state.amount);
      const userTotal = state.userTokenBalance || 0;
      const remainingAllocation = MAX_USER_TOTAL_LIMIT - userTotal;
      
      if (userTotal + amount > MAX_USER_TOTAL_LIMIT) {
        notify(`You can purchase up to ${remainingAllocation} more tokens (${userTotal}/${MAX_USER_TOTAL_LIMIT} owned)`, "error");
        return;
      }

      if (!state.icoData) {
        notify("ICO has not been initialized yet", "error");
        return;
      }

      setState(prev => ({ ...prev, loading: true }));
      const program = getProgram();
      if (!program) return;

      // Calculate cost using fixed token price
      const solCost = amount * (LAMPORTS_PER_TOKEN / LAMPORTS_PER_SOL);
      const balance = await connection.getBalance(wallet.publicKey!);

      if (balance < solCost * LAMPORTS_PER_SOL + 5000) {
        notify(`Insufficient balance. Need ${solCost.toFixed(3)} SOL plus fee`, "error");
        return;
      }

      const [icoAtaPda, bump] = await PublicKey.findProgramAddress(
        [ICO_MINT.toBuffer()],
        program.programId
      );

      const [dataPda] = await PublicKey.findProgramAddress(
        [Buffer.from("data"), state.icoData.admin.toBuffer()],
        program.programId
      );

      const userIcoAta = await getAssociatedTokenAddress(
        ICO_MINT,
        wallet.publicKey!
      );

      // Create transaction
      const transaction = new Transaction();

      // Add ATA creation instruction if needed
      try {
        await getAccount(connection, userIcoAta);
      } catch (_error) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey!,
            userIcoAta,
            wallet.publicKey!,
            ICO_MINT
          )
        );
      }

      // Add buy tokens instruction
      transaction.add(
        await program.methods
          .buyTokens(bump, new BN(amount))
          .accounts({
            icoAtaForIcoProgram: icoAtaPda,
            data: dataPda,
            icoMint: ICO_MINT,
            icoAtaForUser: userIcoAta,
            user: wallet.publicKey!,
            admin: state.icoData.admin,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );

      // Send combined transaction
      const signature = await wallet.sendTransaction(transaction, connection);
      await connection.confirmTransaction(signature, 'confirmed');

      notify("Tokens purchased successfully!", "success");
      await fetchIcoData();
      await fetchUserTokenBalance();
    } catch (error) {
      console.error("Error buying tokens:", error);
      notify(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, "error");
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  };

  const fetchUserTokenBalance = async () => {
    try {
      if (!wallet.publicKey) return;

      const userIcoAta = await getAssociatedTokenAddress(
        ICO_MINT,
        wallet.publicKey
      );

      try {
        const account = await getAccount(connection, userIcoAta);
        setState(prev => ({ 
          ...prev, 
          userTokenBalance: Number(account.amount) / Number(TOKEN_DECIMALS)
        }));
      } catch (error) {
        setState(prev => ({ ...prev, userTokenBalance: 0 }));
      }
    } catch (error) {
      console.error("Error fetching token balance:", error);
    }
  };

  // Add this function to calculate costs
  const calculateCosts = (amount: string) => {
    if (!amount || isNaN(Number(amount))) return null;
    const tokenAmount = Number(amount);
    const solCost = tokenAmount * (LAMPORTS_PER_TOKEN / LAMPORTS_PER_SOL);
    const networkFee = 0.000005;
    const total = solCost + networkFee;
    return { tokenAmount, solCost, networkFee, total };
  };

  // Add this notification helper function
  const notify = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    toast[type](message, {
      position: "bottom-right",
      autoClose: 5000,
      hideProgressBar: false,
      closeOnClick: true,
      pauseOnHover: true,
      draggable: true,
      progress: undefined,
      theme: "dark",
      style: {
        background: type === 'success' ? '#1a472a' : type === 'error' ? '#451a1a' : '#1a1a2f',
        color: '#fff',
        borderRadius: '8px',
        fontSize: '14px',
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
      },
    });
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <div className="w-[500px] max-w-2xl mx-auto py-6">
        <div className="bg-white rounded-2xl shadow-2xl p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold">Solana ICO</h1>
            <WalletMultiButton />
          </div>

          {/* Wallet Info - More Compact */}
          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-600">Wallet:</span>
              <span className="font-medium">
                {wallet.connected && wallet.publicKey 
                  ? `${wallet.publicKey.toString().slice(0, 8)}...${wallet.publicKey.toString().slice(-8)}`
                  : "-"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-600">Status:</span>
              <span className="font-medium text-blue-600">
                {wallet.connected ? (state.isAdmin ? "Admin" : "User") : "-"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-600">Balance:</span>
              <span className="font-medium">
                {state.userTokenBalance !== null 
                  ? `${state.userTokenBalance.toFixed(2)} tokens`
                  : "-"}
              </span>
            </div>
          </div>

          {/* ICO Status Box - More Compact */}
          <div className="bg-gray-50 rounded-xl p-4 mb-6">
            <h2 className="text-lg font-semibold mb-3">ICO Status</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-600">Total Supply</p>
                <p className="text-lg font-semibold">
                  {state.icoData ? `${state.icoData.totalTokens.toString()} tokens` : "-"}
                </p>
              </div>
              <div>
                <p className="text-gray-600">Tokens Sold</p>
                <p className="text-lg font-semibold">
                  {state.icoData ? `${state.icoData.tokensSold.toString()} tokens` : "-"}
                </p>
              </div>
              <div>
                <p className="text-gray-600">Token Price</p>
                <p className="text-lg font-semibold">
                  {state.icoData ? `${(LAMPORTS_PER_TOKEN / LAMPORTS_PER_SOL).toFixed(3)} SOL` : "-"}
                </p>
              </div>
              <div>
                <p className="text-gray-600">Available</p>
                <p className="text-lg font-semibold">
                  {state.icoData 
                    ? `${(state.icoData.totalTokens - state.icoData.tokensSold).toString()} tokens`
                    : "-"}
                </p>
              </div>
            </div>
          </div>

          {/* Buy Tokens Section with Cost Details */}
          <div>
            <div className="mb-2">
              <input
                type="number"
                min="0"
                placeholder={`Amount of tokens to buy (max total ${MAX_USER_TOTAL_LIMIT} per user)`}
                value={state.amount}
                onChange={(e) => setState(prev => ({ ...prev, amount: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
              {state.userTokenBalance !== null && (
                <p className="text-sm text-gray-600 mt-1">
                  Your total purchases: {state.userTokenBalance} tokens
                  {state.userTokenBalance > 0 && ` (${MAX_USER_TOTAL_LIMIT - state.userTokenBalance} remaining)`}
                </p>
              )}
            </div>
            
            {/* Cost Details */}
            {state.amount && calculateCosts(state.amount) && (
              <div className="mb-2">
                <div className="flex justify-between items-center text-sm px-1 text-gray-600 mb-2.5">
                  <span>Tokens: {calculateCosts(state.amount)?.tokenAmount}</span>
                  <span>Cost: {calculateCosts(state.amount)?.solCost} SOL</span>
                  <span>Fee: ~{calculateCosts(state.amount)?.networkFee} SOL</span>
                </div>
                <div className="text-center text-sm font-medium text-gray-700 border-t pt-2">
                  Total: {calculateCosts(state.amount)?.total.toFixed(6)} SOL
                </div>
              </div>
            )}

            <button
              onClick={buyTokens}
              disabled={state.loading || !wallet.connected}
              className="w-full py-2.5 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {state.loading ? "Processing..." : "Buy Tokens"}
            </button>
          </div>

          {/* Admin Controls - More Compact */}
          {state.isAdmin && (
            <div className="mt-6 pt-4 border-t">
              {!state.icoData ? (
                // Show Initialize ICO only when ICO is not initialized
                <div className="space-y-2">
                  <input
                    type="number"
                    min="0"
                    placeholder="Initial token amount"
                    value={state.amount}
                    onChange={(e) => setState(prev => ({ ...prev, amount: e.target.value }))}
                    className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                  <button
                    onClick={createIcoAta}
                    disabled={state.loading}
                    className="w-full py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
                  >
                    {state.loading ? "Processing..." : "Initialize ICO"}
                  </button>
                </div>
              ) : (
                // Show Deposit and Withdraw options when ICO is initialized
                <div>
                  <div className="mb-2">
                    <input
                      type="number"
                      min="0"
                      placeholder="Amount to deposit"
                      value={state.depositAmount}
                      onChange={(e) => setState(prev => ({ ...prev, depositAmount: e.target.value }))}
                      className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                    <button
                      onClick={() => {
                        setState(prev => ({ ...prev, amount: prev.depositAmount || "0" }));
                        depositIco();
                      }}
                      disabled={state.loading}
                      className="w-full mt-2 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50"
                    >
                      {state.loading ? "Processing..." : "Deposit Tokens"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ToastContainer />
    </div>
  );
} 