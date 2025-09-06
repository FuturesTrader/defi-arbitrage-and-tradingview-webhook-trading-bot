// 🚀 ENHANCED nonceManager.ts - Drop-in replacement with automatic drift detection
// Replace your existing nonceManager.ts with this enhanced version

import type { PublicClient, WalletClient } from 'viem';
import { getErrorMessage } from './utils.ts';
import logger from './logger.ts';

interface PendingTransaction {
    nonce: number;
    promise: Promise<any>;
    timestamp: number;
    tradeId?: string;
    webhookId?: string;
}

interface QueuedRequest {
    tradeId?: string;
    webhookId?: string;
    resolve: (nonce: number) => void;
    reject: (error: Error) => void;
    timestamp: number;
}

class NonceManager {
    private static instances: Map<string, NonceManager> = new Map();
    private publicClient: PublicClient;
    private walletClient: WalletClient;
    private account: `0x${string}`;
    private pendingTransactions: Map<number, PendingTransaction> = new Map();
    private nextNonce: number = 0;
    private nonceInitialized: boolean = false;
    private lastSyncTime: number = 0;

    // 🚀 ENHANCED: Additional drift detection properties
    private lastDriftCheck: number = 0;
    private consecutiveDriftDetections: number = 0;
    private readonly CRITICAL_DRIFT_THRESHOLD = 3;
    private readonly DRIFT_CHECK_INTERVAL = 10000; // 10 seconds
    private readonly MAX_CONSECUTIVE_DRIFTS = 2;

    // Concurrency controls
    private isAllocating: boolean = false;
    private allocationQueue: QueuedRequest[] = [];
    private readonly MAX_QUEUE_SIZE = 10;
    private readonly ALLOCATION_TIMEOUT = 30000;

    private readonly NONCE_TIMEOUT = 120000;
    private readonly SYNC_INTERVAL = 30000;
    private readonly WEBHOOK_SYNC_INTERVAL = 5000;
    private cleanupInterval: NodeJS.Timeout;
    private isWebhookContext: boolean = false;

    private constructor(
        publicClient: PublicClient,
        walletClient: WalletClient,
        account: `0x${string}`
    ) {
        this.publicClient = publicClient;
        this.walletClient = walletClient;
        this.account = account;

        // Enhanced cleanup with drift detection
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleTransactions();
            this.cleanupStaleQueue();
            this.performDriftCheck(); // 🚀 NEW: Automatic drift checking
        }, 30000);
    }

    public static getInstance(
        publicClient: PublicClient,
        walletClient: WalletClient,
        account: `0x${string}`
    ): NonceManager {
        const key = account.toLowerCase();
        if (!NonceManager.instances.has(key)) {
            NonceManager.instances.set(key, new NonceManager(publicClient, walletClient, account));
        }
        return NonceManager.instances.get(key)!;
    }

    public setWebhookContext(isWebhook: boolean = true): void {
        this.isWebhookContext = isWebhook;
        logger.debug('Nonce manager context updated', {
            account: this.account,
            isWebhookContext: this.isWebhookContext
        });
    }

    // 🚀 ENHANCED: Smart getNextNonce with automatic drift detection and recovery
    public async getNextNonce(tradeId?: string, webhookId?: string): Promise<number> {
        // Automatic drift detection before allocation
        await this.checkAndRecoverFromDrift();

        // If allocation is in progress, queue this request
        if (this.isAllocating) {
            return this.queueAllocationRequest(tradeId, webhookId);
        }

        return this.allocateNonceAtomic(tradeId, webhookId);
    }

    // 🚀 NEW: Automatic drift detection and recovery
    private async checkAndRecoverFromDrift(): Promise<void> {
        const now = Date.now();

        // Check if we need to perform drift detection
        if (now - this.lastDriftCheck < this.DRIFT_CHECK_INTERVAL) {
            return;
        }

        this.lastDriftCheck = now;

        try {
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: 'latest'
            });

            const drift = this.nextNonce - blockchainNonce;

            if (drift >= this.CRITICAL_DRIFT_THRESHOLD) {
                this.consecutiveDriftDetections++;

                logger.warn('🚨 Critical nonce drift detected', {
                    account: this.account,
                    localNonce: this.nextNonce,
                    blockchainNonce,
                    drift,
                    consecutiveDetections: this.consecutiveDriftDetections,
                    threshold: this.CRITICAL_DRIFT_THRESHOLD
                });

                // Auto-recovery if drift persists
                if (this.consecutiveDriftDetections >= this.MAX_CONSECUTIVE_DRIFTS) {
                    await this.emergencyNonceReset();
                    this.consecutiveDriftDetections = 0;
                }
            } else {
                // Reset consecutive drift counter if no drift detected
                if (this.consecutiveDriftDetections > 0) {
                    logger.info('✅ Nonce drift resolved', {
                        account: this.account,
                        localNonce: this.nextNonce,
                        blockchainNonce,
                        drift
                    });
                    this.consecutiveDriftDetections = 0;
                }
            }

        } catch (error) {
            logger.warn('⚠️ Drift check failed', {
                account: this.account,
                error: getErrorMessage(error)
            });
        }
    }

    // 🚀 NEW: Emergency nonce reset method
    private async emergencyNonceReset(): Promise<void> {
        logger.warn('🚨 Emergency nonce reset initiated', {
            account: this.account,
            currentLocalNonce: this.nextNonce,
            pendingTxCount: this.pendingTransactions.size,
            queueSize: this.allocationQueue.length
        });

        try {
            // Clear all pending state
            this.clearQueue();
            this.pendingTransactions.clear();

            // Force fresh sync from blockchain
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: 'latest'
            });

            // Reset local state
            this.nextNonce = blockchainNonce;
            this.nonceInitialized = true;
            this.lastSyncTime = Date.now();
            this.isAllocating = false;

            logger.info('✅ Emergency nonce reset completed', {
                account: this.account,
                resetNonce: this.nextNonce,
                blockchainNonce
            });

        } catch (error) {
            logger.error('❌ Emergency nonce reset failed', {
                account: this.account,
                error: getErrorMessage(error)
            });
            throw error;
        }
    }

    // 🚀 NEW: Periodic drift check (called by cleanup interval)
    private async performDriftCheck(): Promise<void> {
        if (!this.nonceInitialized) return;

        try {
            await this.checkAndRecoverFromDrift();
        } catch (error) {
            logger.debug('Periodic drift check failed', {
                account: this.account,
                error: getErrorMessage(error)
            });
        }
    }

    // Enhanced initialization with better drift handling
    private async initializeOrSyncNonce(force: boolean = false): Promise<void> {
        const now = Date.now();
        const syncInterval = this.isWebhookContext ? this.WEBHOOK_SYNC_INTERVAL : this.SYNC_INTERVAL;

        const shouldSync = force ||
            !this.nonceInitialized ||
            (now - this.lastSyncTime > syncInterval);

        if (!shouldSync) {
            return;
        }

        try {
            // 🚀 ENHANCED: Use 'latest' for more reliable sync
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: this.nonceInitialized ? 'latest' : 'pending'
            });

            if (this.nonceInitialized && blockchainNonce > this.nextNonce) {
                logger.warn('🔄 Nonce drift detected - auto-correcting', {
                    account: this.account,
                    localNonce: this.nextNonce,
                    blockchainNonce,
                    drift: blockchainNonce - this.nextNonce,
                    context: this.isWebhookContext ? 'webhook' : 'cli'
                });
            }

            this.nextNonce = Math.max(blockchainNonce, this.nextNonce);
            this.nonceInitialized = true;
            this.lastSyncTime = now;

            logger.info('🔄 Nonce synchronized with blockchain', {
                account: this.account,
                currentNonce: this.nextNonce,
                blockchainNonce,
                pendingTxCount: this.pendingTransactions.size,
                queueLength: this.allocationQueue.length,
                context: this.isWebhookContext ? 'webhook' : 'cli'
            });

        } catch (error) {
            logger.error('❌ Failed to sync nonce with blockchain', {
                account: this.account,
                error: getErrorMessage(error),
                context: this.isWebhookContext ? 'webhook' : 'cli'
            });
            throw error;
        }
    }

    private async queueAllocationRequest(tradeId?: string, webhookId?: string): Promise<number> {
        if (this.allocationQueue.length >= this.MAX_QUEUE_SIZE) {
            logger.error('🚨 Nonce allocation queue full - rejecting request', {
                account: this.account,
                queueSize: this.allocationQueue.length,
                maxSize: this.MAX_QUEUE_SIZE,
                tradeId,
                webhookId
            });
            throw new Error('Nonce allocation queue full - too many concurrent requests');
        }

        return new Promise<number>((resolve, reject) => {
            const queuedRequest: QueuedRequest = {
                tradeId,
                webhookId,
                resolve,
                reject,
                timestamp: Date.now()
            };

            this.allocationQueue.push(queuedRequest);

            logger.debug('🔄 Nonce allocation request queued', {
                account: this.account,
                queuePosition: this.allocationQueue.length,
                tradeId,
                webhookId
            });

            setTimeout(() => {
                const index = this.allocationQueue.indexOf(queuedRequest);
                if (index !== -1) {
                    this.allocationQueue.splice(index, 1);
                    reject(new Error('Nonce allocation timeout - request took too long'));
                }
            }, this.ALLOCATION_TIMEOUT);
        });
    }

    private async allocateNonceAtomic(tradeId?: string, webhookId?: string): Promise<number> {
        this.isAllocating = true;

        try {
            await this.initializeOrSyncNonce();

            const allocatedNonce = this.nextNonce;
            this.nextNonce++;

            logger.debug('🎯 Nonce allocated atomically', {
                account: this.account,
                allocatedNonce,
                nextNonce: this.nextNonce,
                tradeId,
                webhookId,
                pendingTxCount: this.pendingTransactions.size
            });

            // Process next queued request if any
            this.processNextQueuedRequest();

            return allocatedNonce;

        } finally {
            this.isAllocating = false;
        }
    }

    private processNextQueuedRequest(): void {
        if (this.allocationQueue.length === 0) return;

        const nextRequest = this.allocationQueue.shift()!;

        // Process the next request asynchronously
        setImmediate(async () => {
            try {
                const nonce = await this.allocateNonceAtomic(
                    nextRequest.tradeId,
                    nextRequest.webhookId
                );
                nextRequest.resolve(nonce);
            } catch (error) {
                nextRequest.reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    public registerTransaction(
        nonce: number,
        transactionPromise: Promise<any>,
        tradeId?: string,
        webhookId?: string
    ): void {
        const pendingTx: PendingTransaction = {
            nonce,
            promise: transactionPromise,
            timestamp: Date.now(),
            tradeId,
            webhookId
        };

        this.pendingTransactions.set(nonce, pendingTx);

        logger.debug('📝 Transaction registered for nonce tracking', {
            account: this.account,
            nonce,
            tradeId,
            webhookId,
            totalPending: this.pendingTransactions.size
        });

        transactionPromise
            .then(() => {
                this.pendingTransactions.delete(nonce);
                logger.debug('✅ Transaction completed and removed from pending', {
                    account: this.account,
                    nonce,
                    tradeId,
                    webhookId
                });
            })
            .catch(() => {
                this.pendingTransactions.delete(nonce);
                logger.debug('❌ Transaction failed and removed from pending', {
                    account: this.account,
                    nonce,
                    tradeId,
                    webhookId
                });
            });
    }

    public async refreshNonce(): Promise<number> {
        logger.info('🔄 Force refreshing nonce from blockchain', {
            account: this.account,
            currentNonce: this.nextNonce,
            context: this.isWebhookContext ? 'webhook' : 'cli'
        });

        await this.initializeOrSyncNonce(true);
        return this.nextNonce;
    }

    private cleanupStaleTransactions(): void {
        const now = Date.now();
        const staleNonces: number[] = [];

        for (const [nonce, tx] of this.pendingTransactions.entries()) {
            if (now - tx.timestamp > this.NONCE_TIMEOUT) {
                staleNonces.push(nonce);
                logger.warn('🧹 Removing stale transaction', {
                    account: this.account,
                    nonce,
                    age: now - tx.timestamp,
                    tradeId: tx.tradeId,
                    webhookId: tx.webhookId,
                    context: this.isWebhookContext ? 'webhook' : 'cli'
                });
            }
        }

        for (const nonce of staleNonces) {
            this.pendingTransactions.delete(nonce);
        }

        if (staleNonces.length > 0) {
            this.lastSyncTime = 0; // Force sync next time
        }
    }

    private cleanupStaleQueue(): void {
        const now = Date.now();
        const staleCount = this.allocationQueue.length;

        this.allocationQueue = this.allocationQueue.filter(req => {
            const isStale = now - req.timestamp > this.ALLOCATION_TIMEOUT;
            if (isStale) {
                req.reject(new Error('Allocation request timed out'));
            }
            return !isStale;
        });

        const removedCount = staleCount - this.allocationQueue.length;
        if (removedCount > 0) {
            logger.warn('🧹 Cleaned up stale queue requests', {
                account: this.account,
                staleCount: removedCount,
                remainingQueue: this.allocationQueue.length
            });
        }
    }

    private clearQueue(): void {
        const queueSize = this.allocationQueue.length;

        this.allocationQueue.forEach(req => {
            req.reject(new Error('Queue cleared - system reset'));
        });

        this.allocationQueue.length = 0;

        if (queueSize > 0) {
            logger.warn('🧹 Emergency queue clear completed', {
                account: this.account,
                clearedRequests: queueSize
            });
        }
    }

    // 🚀 COMPATIBILITY: Add missing methods expected by existing code
    public cleanup(): void {
        this.cleanupStaleTransactions();
        this.cleanupStaleQueue();

        logger.debug('🧹 Manual cleanup completed', {
            account: this.account,
            pendingTxCount: this.pendingTransactions.size,
            queueLength: this.allocationQueue.length
        });
    }

    public getStatus(): {
        account: string;
        nextNonce: number;
        pendingCount: number;
        pendingNonces: number[];
    } {
        // Get array of pending nonce numbers
        const pendingNonces = Array.from(this.pendingTransactions.keys()).sort((a, b) => a - b);

        return {
            account: this.account,
            nextNonce: this.nextNonce,
            pendingCount: this.pendingTransactions.size,
            pendingNonces: pendingNonces
        };
    }

    public destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.clearQueue();
        this.pendingTransactions.clear();

        logger.info('🔄 Nonce manager destroyed', {
            account: this.account
        });
    }
}

export { NonceManager };