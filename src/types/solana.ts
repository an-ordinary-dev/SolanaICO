import { PublicKey } from '@solana/web3.js';
import { WalletContextState } from '@solana/wallet-adapter-react';

export interface WalletState extends WalletContextState {
    connected: boolean;
    publicKey: PublicKey | null;
}

export interface ICOData {
    admin: PublicKey;
    totalTokens: number;
    tokensSold: number;
    tokenPrice: number; // Token price in lamports
}

export interface BuyTokensParams {
    amount: number;
    wallet: WalletState;
}

export interface CreateICOATAParams {
    amount: number;
    wallet: WalletState;
}

export interface DepositICOATAParams {
    amount: number;
    wallet: WalletState;
}

export interface TransactionResult {
    signature: string;
    error?: Error;
} 