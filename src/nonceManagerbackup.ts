// 🔧 COMPLETE CONCURRENT-SAFE nonceManager.ts - All Methods Included
// Replace the entire nonceManager.ts with this complete version

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

    // 🚀 CONCURRENCY CONTROLS
    private isAllocating: boolean = false;  // Mutex for nonce allocation
    private allocationQueue: QueuedRequest[] = []; // Queue for concurrent requests
    private readonly MAX_QUEUE_SIZE = 10; // Prevent memory issues
    private readonly ALLOCATION_TIMEOUT = 30000; // 30 seconds max wait

    private readonly NONCE_TIMEOUT = 120000; // 2 minutes timeout
    private readonly SYNC_INTERVAL = 30000; // 30 seconds between sync checks
    private readonly WEBHOOK_SYNC_INTERVAL = 5000; // 5 seconds for webhook context
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

        // Schedule cleanup of stale transactions
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleTransactions();
            this.cleanupStaleQueue();
        }, 30000);
    }

    /**
     * Get or create singleton instance per account
     */
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

    /**
     * Mark this instance as being used in webhook context
     */
    public setWebhookContext(isWebhook: boolean = true): void {
        this.isWebhookContext = isWebhook;
        logger.debug('Nonce manager context updated', {
            account: this.account,
            isWebhookContext: this.isWebhookContext
        });
    }

    /**
     * Initialize or refresh nonce from blockchain with smart sync detection
     */
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
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: 'pending'
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

    /**
     * Smart nonce validation
     */
    private async validateAndSyncNonce(): Promise<void> {
        try {
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: 'latest'
            });

            if (blockchainNonce > this.nextNonce) {
                logger.warn('🚨 Nonce validation failed - blockchain ahead', {
                    account: this.account,
                    localNonce: this.nextNonce,
                    blockchainNonce,
                    context: this.isWebhookContext ? 'webhook' : 'cli'
                });

                await this.initializeOrSyncNonce(true);
            }
        } catch (error) {
            logger.warn('⚠️ Nonce validation check failed', {
                account: this.account,
                currentNonce: this.nextNonce,
                error: getErrorMessage(error)
            });
        }
    }

    /**
     * 🚀 ATOMIC NONCE ALLOCATION - Thread-safe for concurrent webhooks
     */
    public async getNextNonce(tradeId?: string, webhookId?: string): Promise<number> {
        // If allocation is in progress, queue this request
        if (this.isAllocating) {
            return this.queueAllocationRequest(tradeId, webhookId);
        }

        return this.allocateNonceAtomic(tradeId, webhookId);
    }

    /**
     * Queue allocation request for concurrent processing
     */
    private async queueAllocationRequest(tradeId?: string, webhookId?: string): Promise<number> {
        // Check queue size to prevent memory issues
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

            // Set timeout for queued request
            setTimeout(() => {
                const index = this.allocationQueue.indexOf(queuedRequest);
                if (index !== -1) {
                    this.allocationQueue.splice(index, 1);
                    reject(new Error('Nonce allocation timeout - request took too long'));
                }
            }, this.ALLOCATION_TIMEOUT);
        });
    }

    /**
     * Atomic nonce allocation with immediate reservation
     */
    private async allocateNonceAtomic(tradeId?: string, webhookId?: string): Promise<number> {
        // 🔒 LOCK: Set allocation mutex
        this.isAllocating = true;

        try {
            // 🚀 STEP 1: Ensure we're synchronized
            await this.initializeOrSyncNonce();
            await this.validateAndSyncNonce();

            // 🚀 STEP 2: Clean up completed transactions
            await this.cleanupCompletedTransactions();

            // 🚀 STEP 3: Find next available nonce atomically
            while (this.pendingTransactions.has(this.nextNonce)) {
                this.nextNonce++;
            }

            const allocatedNonce = this.nextNonce;

            // 🚀 STEP 4: IMMEDIATELY reserve the nonce (critical for concurrency)
            const placeholder: PendingTransaction = {
                nonce: allocatedNonce,
                promise: Promise.resolve(), // Placeholder promise
                timestamp: Date.now(),
                tradeId,
                webhookId
            };
            this.pendingTransactions.set(allocatedNonce, placeholder);

            // 🚀 STEP 5: Increment for next allocation
            this.nextNonce++;

            logger.debug('🔢 Nonce allocated atomically', {
                account: this.account,
                nonce: allocatedNonce,
                tradeId,
                webhookId,
                pendingCount: this.pendingTransactions.size,
                context: this.isWebhookContext ? 'webhook' : 'cli'
            });

            return allocatedNonce;

        } finally {
            // 🔓 UNLOCK: Release allocation mutex
            this.isAllocating = false;

            // 🚀 PROCESS QUEUE: Handle next queued request
            this.processNextQueuedRequest();
        }
    }

    /**
     * Process the next queued allocation request
     */
    private async processNextQueuedRequest(): Promise<void> {
        if (this.allocationQueue.length === 0) {
            return; // No queued requests
        }

        const nextRequest = this.allocationQueue.shift();
        if (!nextRequest) {
            return;
        }

        try {
            const nonce = await this.allocateNonceAtomic(
                nextRequest.tradeId,
                nextRequest.webhookId
            );

            nextRequest.resolve(nonce);

            logger.debug('✅ Queued nonce allocation completed', {
                account: this.account,
                nonce,
                tradeId: nextRequest.tradeId,
                webhookId: nextRequest.webhookId,
                remainingQueue: this.allocationQueue.length
            });

        } catch (error) {
            logger.error('❌ Queued nonce allocation failed', {
                account: this.account,
                tradeId: nextRequest.tradeId,
                webhookId: nextRequest.webhookId,
                error: getErrorMessage(error)
            });

            nextRequest.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * 🔄 ENHANCED: Register transaction with real promise (replaces placeholder)
     */
    public registerTransaction(
        nonce: number,
        transactionPromise: Promise<any>,
        tradeId?: string,
        webhookId?: string
    ): void {
        // Replace placeholder with real transaction promise
        const pendingTx: PendingTransaction = {
            nonce,
            promise: transactionPromise,
            timestamp: Date.now(),
            tradeId,
            webhookId
        };

        this.pendingTransactions.set(nonce, pendingTx);

        logger.debug('📝 Transaction registered', {
            account: this.account,
            nonce,
            tradeId,
            webhookId,
            context: this.isWebhookContext ? 'webhook' : 'cli'
        });

        // Enhanced transaction completion handling
        transactionPromise
            .then(() => {
                logger.debug('✅ Transaction completed successfully', {
                    account: this.account,
                    nonce,
                    tradeId,
                    webhookId,
                    context: this.isWebhookContext ? 'webhook' : 'cli'
                });
            })
            .catch((error) => {
                const errorMsg = getErrorMessage(error);
                logger.error('❌ Transaction failed', {
                    account: this.account,
                    nonce,
                    tradeId,
                    webhookId,
                    error: errorMsg,
                    isNonceError: errorMsg.includes('nonce'),
                    context: this.isWebhookContext ? 'webhook' : 'cli'
                });

                // Auto-recovery for nonce errors
                if (errorMsg.includes('nonce')) {
                    logger.warn('🔄 Nonce error detected - will force sync on next request', {
                        account: this.account,
                        nonce,
                        tradeId,
                        webhookId
                    });
                    this.lastSyncTime = 0; // Force sync next time
                }
            })
            .finally(() => {
                // Remove from pending after completion
                setTimeout(() => {
                    this.pendingTransactions.delete(nonce);
                    logger.debug('🧹 Transaction removed from pending', {
                        account: this.account,
                        nonce,
                        tradeId,
                        webhookId,
                        context: this.isWebhookContext ? 'webhook' : 'cli'
                    });
                }, 5000);
            });
    }

    /**
     * Clean up completed transactions
     */
    private async cleanupCompletedTransactions(): Promise<void> {
        const completedNonces: number[] = [];

        for (const [nonce, pendingTx] of this.pendingTransactions) {
            try {
                // Check if transaction is completed (resolved or rejected)
                const result = await Promise.race([
                    pendingTx.promise.then(() => 'completed'),
                    Promise.resolve('pending')
                ]);

                if (result === 'completed') {
                    completedNonces.push(nonce);
                }
            } catch {
                // Transaction failed, mark for cleanup
                completedNonces.push(nonce);
            }
        }

        // Remove completed transactions
        for (const nonce of completedNonces) {
            this.pendingTransactions.delete(nonce);
        }

        if (completedNonces.length > 0) {
            logger.debug('🧹 Cleaned up completed transactions', {
                account: this.account,
                cleanedNonces: completedNonces,
                remainingPending: this.pendingTransactions.size,
                context: this.isWebhookContext ? 'webhook' : 'cli'
            });
        }
    }

    /**
     * Clean up stale transactions (timeout handling)
     */
    private cleanupStaleTransactions(): void {
        const now = Date.now();
        const staleNonces: number[] = [];

        for (const [nonce, pendingTx] of this.pendingTransactions) {
            if (now - pendingTx.timestamp > this.NONCE_TIMEOUT) {
                staleNonces.push(nonce);
                logger.warn('🧹 Cleaning up stale transaction', {
                    account: this.account,
                    nonce,
                    tradeId: pendingTx.tradeId,
                    webhookId: pendingTx.webhookId,
                    age: now - pendingTx.timestamp,
                    context: this.isWebhookContext ? 'webhook' : 'cli'
                });
            }
        }

        // Remove stale transactions and force sync next time
        for (const nonce of staleNonces) {
            this.pendingTransactions.delete(nonce);
        }

        if (staleNonces.length > 0) {
            this.lastSyncTime = 0; // Force sync next time
        }
    }

    /**
     * Clean up stale queue requests
     */
    private cleanupStaleQueue(): void {
        const now = Date.now();

        // ✅ IMPROVED: Filter and reject stale requests in one pass
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
    /**
     * Clear all queued requests (emergency cleanup)
     */
    public clearQueue(): void {
        const queueSize = this.allocationQueue.length;

        // Reject all pending requests
        this.allocationQueue.forEach(req => {
            req.reject(new Error('Queue cleared - system reset'));
        });

        // Clear the queue
        this.allocationQueue.length = 0;

        if (queueSize > 0) {
            logger.warn('🧹 Emergency queue clear completed', {
                account: this.account,
                clearedRequests: queueSize
            });
        }
    }
    /**
     * Force refresh nonce from blockchain (emergency recovery)
     */
    public async refreshNonce(): Promise<number> {
        logger.info('🔄 Force refreshing nonce from blockchain', {
            account: this.account,
            currentNonce: this.nextNonce,
            context: this.isWebhookContext ? 'webhook' : 'cli'
        });

        await this.initializeOrSyncNonce(true);
        return this.nextNonce;
    }

    /**
     * Get enhanced status for debugging concurrent scenarios
     */
    public getStatus(): {
        account: string;
        nextNonce: number;
        pendingCount: number;
        pendingNonces: number[];
        queueLength: number;
        isAllocating: boolean;
        lastSyncTime: number;
        isWebhookContext: boolean;
    } {
        return {
            account: this.account,
            nextNonce: this.nextNonce,
            pendingCount: this.pendingTransactions.size,
            pendingNonces: Array.from(this.pendingTransactions.keys()).sort(),
            queueLength: this.allocationQueue.length,
            isAllocating: this.isAllocating,
            lastSyncTime: this.lastSyncTime,
            isWebhookContext: this.isWebhookContext
        };
    }

    /**
     * Cleanup when shutting down
     */
    public cleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        // ✅ FIX: Use array methods instead of .clear()
        this.pendingTransactions.clear(); // Map has .clear() method - this is fine
        this.allocationQueue.length = 0;  // ✅ Array cleanup - set length to 0
        // Alternative: this.allocationQueue.splice(0); // Also works

        logger.info('🧹 Nonce manager cleaned up', {
            account: this.account,
            context: this.isWebhookContext ? 'webhook' : 'cli'
        });
    }
}

export { NonceManager };