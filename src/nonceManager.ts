// 🚀 COMPLETE NONCEMANAGER v3.0 - Production-Ready with All Methods
// Fixes the critical Math.max() bug

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

interface DriftRecord {
    timestamp: number;
    localNonce: number;
    blockchainNonce: number;
    drift: number;
    action: 'detected' | 'resolved' | 'reset';
}

interface NonceManagerStatus {
    account: string;
    nextNonce: number;
    pendingCount: number;
    pendingNonces: number[];
    queueLength: number;
    consecutiveDrifts: number;
    lastSyncTime: number;
    isHealthy: boolean;
    driftHistory: DriftRecord[];
    stats: {
        totalAllocations: number;
        successfulTx: number;
        failedTx: number;
        emergencyResets: number;
        averageAllocationTime: number;
    };
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

    // Enhanced drift tracking
    private lastDriftCheck: number = 0;
    private consecutiveDriftDetections: number = 0;
    private driftHistory: DriftRecord[] = [];
    private readonly CRITICAL_DRIFT_THRESHOLD = 2; // Reduced for faster recovery
    private readonly DRIFT_CHECK_INTERVAL = 10000; // 10 seconds
    private readonly MAX_CONSECUTIVE_DRIFTS = 1; // Immediate recovery
    private readonly MAX_DRIFT_HISTORY = 20;

    // Concurrency controls
    private isAllocating: boolean = false;
    private allocationQueue: QueuedRequest[] = [];
    private readonly MAX_QUEUE_SIZE = 10;
    private readonly ALLOCATION_TIMEOUT = 30000;

    // Performance tracking
    private stats = {
        totalAllocations: 0,
        successfulTx: 0,
        failedTx: 0,
        emergencyResets: 0,
        allocationTimes: [] as number[]
    };

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
            this.performDriftCheck();
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

    // 🚀 MAIN ALLOCATION METHOD with enhanced error recovery
    public async getNextNonce(tradeId?: string, webhookId?: string): Promise<number> {
        const startTime = Date.now();

        try {
            // Automatic drift detection before allocation
            await this.checkAndRecoverFromDrift();

            // If allocation is in progress, queue this request
            if (this.isAllocating) {
                return await this.queueAllocationRequest(tradeId, webhookId);
            }

            const nonce = await this.allocateNonceAtomic(tradeId, webhookId);

            // Track performance
            this.stats.totalAllocations++;
            this.stats.allocationTimes.push(Date.now() - startTime);
            if (this.stats.allocationTimes.length > 100) {
                this.stats.allocationTimes.shift(); // Keep only last 100
            }

            return nonce;

        } catch (error) {
            logger.error('❌ Nonce allocation failed', {
                account: this.account,
                tradeId,
                webhookId: webhookId || 'cli',
                error: getErrorMessage(error),
                duration: Date.now() - startTime
            });
            throw error;
        }
    }

    // 🚨 NEW: Specific handler for "nonce too high" errors
    public async handleNonceTooHighError(
        failedNonce: number,
        tradeId?: string,
        webhookId?: string
    ): Promise<void> {
        this.stats.failedTx++;

        logger.warn('🚨 Handling "nonce too high" error with forced reset', {
            account: this.account,
            failedNonce,
            currentNextNonce: this.nextNonce,
            tradeId,
            webhookId: webhookId || 'cli'
        });

        // Record drift event
        try {
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: 'latest'
            });

            this.recordDriftEvent(this.nextNonce, blockchainNonce, 'reset');
        } catch (error) {
            logger.warn('Failed to record drift event during error handling', {
                error: getErrorMessage(error)
            });
        }

        // Remove the failed transaction from pending
        this.pendingTransactions.delete(failedNonce);

        // 🔧 CRITICAL: Force immediate blockchain sync and reset
        await this.forceBlockchainSync();

        logger.info('✅ "Nonce too high" error recovery completed', {
            account: this.account,
            newNextNonce: this.nextNonce,
            failedNonce,
            tradeId,
            webhookId: webhookId || 'cli'
        });
    }

    // 🚨 NEW: Specific handler for "nonce too low" errors (RPC inconsistency)
    public async handleNonceTooLowError(
        failedNonce: number,
        tradeId?: string,
        webhookId?: string
    ): Promise<void> {
        this.stats.failedTx++;

        logger.warn('🚨 Handling "nonce too low" error - RPC inconsistency detected', {
            account: this.account,
            failedNonce,
            currentNextNonce: this.nextNonce,
            tradeId,
            webhookId: webhookId || 'cli'
        });

        // For "too low" errors, we need to sync forward
        await this.forceBlockchainSync();

        logger.info('✅ "Nonce too low" error recovery completed', {
            account: this.account,
            newNextNonce: this.nextNonce,
            failedNonce,
            tradeId,
            webhookId: webhookId || 'cli'
        });
    }

    // 🚨 NEW: Force sync that ALWAYS resets to blockchain (no Math.max!)
    private async forceBlockchainSync(): Promise<void> {
        try {
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: 'latest'
            });

            const oldNonce = this.nextNonce;

            // 🔧 CRITICAL FIX: Always reset to blockchain nonce when forcing sync
            // This is the fix for your production issue!
            this.nextNonce = blockchainNonce;
            this.nonceInitialized = true;
            this.lastSyncTime = Date.now();

            // Clear stale pending transactions
            const staleCutoff = Date.now() - this.NONCE_TIMEOUT;
            for (const [nonce, tx] of this.pendingTransactions.entries()) {
                if (tx.timestamp < staleCutoff || nonce < blockchainNonce) {
                    this.pendingTransactions.delete(nonce);
                }
            }

            logger.info('🔄 Force blockchain sync completed', {
                account: this.account,
                oldNonce,
                newNonce: this.nextNonce,
                blockchainNonce,
                wasReset: oldNonce !== this.nextNonce,
                clearedPendingTx: this.pendingTransactions.size
            });

        } catch (error) {
            logger.error('❌ Force blockchain sync failed', {
                account: this.account,
                error: getErrorMessage(error)
            });
            throw error;
        }
    }

    // Automatic drift detection and recovery
    private async checkAndRecoverFromDrift(): Promise<void> {
        const now = Date.now();

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

            if (Math.abs(drift) >= this.CRITICAL_DRIFT_THRESHOLD) {
                this.consecutiveDriftDetections++;
                this.recordDriftEvent(this.nextNonce, blockchainNonce, 'detected');

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
                    this.recordDriftEvent(this.nextNonce, blockchainNonce, 'resolved');
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

    // Emergency nonce reset method
    private async emergencyNonceReset(): Promise<void> {
        this.stats.emergencyResets++;

        logger.warn('🚨 Emergency nonce reset initiated', {
            account: this.account,
            currentLocalNonce: this.nextNonce,
            pendingTxCount: this.pendingTransactions.size,
            queueSize: this.allocationQueue.length,
            resetCount: this.stats.emergencyResets
        });

        try {
            // Clear all pending state
            this.clearQueue();
            this.pendingTransactions.clear();

            // Force fresh sync from blockchain
            await this.forceBlockchainSync();

            // Reset allocation state
            this.isAllocating = false;

            logger.info('✅ Emergency nonce reset completed', {
                account: this.account,
                resetNonce: this.nextNonce,
                resetCount: this.stats.emergencyResets
            });

        } catch (error) {
            logger.error('❌ Emergency nonce reset failed', {
                account: this.account,
                error: getErrorMessage(error)
            });
            throw error;
        }
    }

    // 🔧 FIXED: Enhanced sync logic (removes Math.max bug for normal operations)
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
                blockTag: this.nonceInitialized ? 'latest' : 'pending'
            });

            if (this.nonceInitialized) {
                if (blockchainNonce > this.nextNonce) {
                    // Blockchain is ahead - sync forward (normal case)
                    logger.warn('🔄 Blockchain ahead - syncing forward', {
                        account: this.account,
                        localNonce: this.nextNonce,
                        blockchainNonce,
                        drift: blockchainNonce - this.nextNonce
                    });
                    this.nextNonce = blockchainNonce;
                } else if (blockchainNonce < this.nextNonce) {
                    // Manager is ahead - this is drift, but don't auto-fix in normal sync
                    // Only emergency reset should fix this
                    logger.debug('Manager ahead of blockchain - will be handled by drift detection', {
                        account: this.account,
                        localNonce: this.nextNonce,
                        blockchainNonce,
                        drift: this.nextNonce - blockchainNonce
                    });
                    // Don't change nextNonce here - let drift detection handle it
                }
                // If equal, no change needed
            } else {
                // First initialization - use blockchain nonce
                this.nextNonce = blockchainNonce;
            }

            this.nonceInitialized = true;
            this.lastSyncTime = now;

            logger.debug('🔄 Nonce synchronized with blockchain', {
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
                webhookId: webhookId || 'cli',
                pendingTxCount: this.pendingTransactions.size
            });

            this.processNextQueuedRequest();
            return allocatedNonce;

        } finally {
            this.isAllocating = false;
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
                webhookId: webhookId || 'cli'
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

    private processNextQueuedRequest(): void {
        if (this.allocationQueue.length === 0) return;

        const nextRequest = this.allocationQueue.shift()!;

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
            webhookId: webhookId || 'cli',
            totalPending: this.pendingTransactions.size
        });

        transactionPromise
            .then(() => {
                this.pendingTransactions.delete(nonce);
                this.stats.successfulTx++;
                logger.debug('✅ Transaction completed and removed from pending', {
                    account: this.account,
                    nonce,
                    tradeId,
                    webhookId: webhookId || 'cli'
                });
            })
            .catch((error) => {
                this.pendingTransactions.delete(nonce);
                this.stats.failedTx++;
                logger.debug('❌ Transaction failed and removed from pending', {
                    account: this.account,
                    nonce,
                    tradeId,
                    webhookId: webhookId || 'cli',
                    error: getErrorMessage(error)
                });
            });
    }

    // Force refresh method (backward compatibility)
    public async refreshNonce(): Promise<number> {
        logger.info('🔄 Force refreshing nonce from blockchain', {
            account: this.account,
            currentNonce: this.nextNonce,
            context: this.isWebhookContext ? 'webhook' : 'cli'
        });

        await this.forceBlockchainSync();
        return this.nextNonce;
    }

    // 🚨 NEW: Manual reset for emergency situations
    public async manualReset(): Promise<void> {
        logger.warn('🔧 Manual nonce reset requested', {
            account: this.account,
            currentNonce: this.nextNonce,
            pendingTx: this.pendingTransactions.size,
            queueLength: this.allocationQueue.length
        });

        await this.emergencyNonceReset();

        logger.info('✅ Manual reset completed', {
            account: this.account,
            newNonce: this.nextNonce
        });
    }

    // 🚨 NEW: Health check method
    public async isHealthy(): Promise<boolean> {
        try {
            // Check if we can get blockchain nonce
            const blockchainNonce = await this.publicClient.getTransactionCount({
                address: this.account,
                blockTag: 'latest'
            });

            // Check for excessive drift
            const drift = Math.abs(this.nextNonce - blockchainNonce);
            const hasExcessiveDrift = drift > this.CRITICAL_DRIFT_THRESHOLD;

            // Check for stuck queue
            const hasStuckQueue = this.allocationQueue.length > 5;

            // Check for consecutive errors
            const hasConsecutiveErrors = this.consecutiveDriftDetections > 2;

            const healthy = !hasExcessiveDrift && !hasStuckQueue && !hasConsecutiveErrors;

            if (!healthy) {
                logger.warn('⚠️ Nonce manager health check failed', {
                    account: this.account,
                    drift,
                    queueLength: this.allocationQueue.length,
                    consecutiveErrors: this.consecutiveDriftDetections,
                    reasons: {
                        excessiveDrift: hasExcessiveDrift,
                        stuckQueue: hasStuckQueue,
                        consecutiveErrors: hasConsecutiveErrors
                    }
                });
            }

            return healthy;
        } catch (error) {
            logger.error('❌ Health check failed', {
                account: this.account,
                error: getErrorMessage(error)
            });
            return false;
        }
    }

    // 🚨 NEW: Get performance statistics
    public getStats() {
        const avgAllocationTime = this.stats.allocationTimes.length > 0
            ? this.stats.allocationTimes.reduce((a, b) => a + b, 0) / this.stats.allocationTimes.length
            : 0;

        return {
            totalAllocations: this.stats.totalAllocations,
            successfulTx: this.stats.successfulTx,
            failedTx: this.stats.failedTx,
            emergencyResets: this.stats.emergencyResets,
            averageAllocationTime: Math.round(avgAllocationTime),
            successRate: this.stats.totalAllocations > 0
                ? ((this.stats.successfulTx / this.stats.totalAllocations) * 100).toFixed(2) + '%'
                : '0%',
            queueLength: this.allocationQueue.length,
            pendingTx: this.pendingTransactions.size
        };
    }

    // 🚨 NEW: Enhanced status method
    public async getDetailedStatus(): Promise<NonceManagerStatus> {
        const isHealthy = await this.isHealthy();
        const pendingNonces = Array.from(this.pendingTransactions.keys()).sort((a, b) => a - b);
        const stats = this.getStats();

        return {
            account: this.account,
            nextNonce: this.nextNonce,
            pendingCount: this.pendingTransactions.size,
            pendingNonces,
            queueLength: this.allocationQueue.length,
            consecutiveDrifts: this.consecutiveDriftDetections,
            lastSyncTime: this.lastSyncTime,
            isHealthy,
            driftHistory: this.driftHistory.slice(-10), // Last 10 events
            stats: {
                totalAllocations: stats.totalAllocations,
                successfulTx: this.stats.successfulTx,
                failedTx: this.stats.failedTx,
                emergencyResets: this.stats.emergencyResets,
                averageAllocationTime: stats.averageAllocationTime
            }
        };
    }

    // Simple status (backward compatibility)
    public getStatus(): {
        account: string;
        nextNonce: number;
        pendingCount: number;
        pendingNonces: number[];
    } {
        const pendingNonces = Array.from(this.pendingTransactions.keys()).sort((a, b) => a - b);

        return {
            account: this.account,
            nextNonce: this.nextNonce,
            pendingCount: this.pendingTransactions.size,
            pendingNonces
        };
    }

    // Record drift events for analysis
    private recordDriftEvent(localNonce: number, blockchainNonce: number, action: 'detected' | 'resolved' | 'reset'): void {
        const driftRecord: DriftRecord = {
            timestamp: Date.now(),
            localNonce,
            blockchainNonce,
            drift: localNonce - blockchainNonce,
            action
        };

        this.driftHistory.push(driftRecord);

        // Keep only recent history
        if (this.driftHistory.length > this.MAX_DRIFT_HISTORY) {
            this.driftHistory.shift();
        }
    }

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
                    webhookId: tx.webhookId
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

    public cleanup(): void {
        this.cleanupStaleTransactions();
        this.cleanupStaleQueue();

        logger.debug('🧹 Manual cleanup completed', {
            account: this.account,
            pendingTxCount: this.pendingTransactions.size,
            queueLength: this.allocationQueue.length
        });
    }

    public destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.clearQueue();
        this.pendingTransactions.clear();

        logger.info('🔄 Nonce manager destroyed', {
            account: this.account,
            finalStats: this.getStats()
        });

        // Remove from instances map
        NonceManager.instances.delete(this.account.toLowerCase());
    }
}

// 🚨 NEW: Helper function for network-aware nonce management
export function getNetworkNonceManager(account: `0x${string}`, network: string): NonceManager {
    // This integrates with your existing clientManager
    try {
        // Import your clientManager here
        const { clientManager } = require('./clientManager.ts');
        const { publicClient, walletClient } = clientManager.getClients(network);
        return NonceManager.getInstance(publicClient, walletClient, account);
    } catch (error) {
        logger.error('Failed to get network nonce manager', {
            account,
            network,
            error: getErrorMessage(error)
        });
        throw new Error(`Could not create nonce manager for ${network}: ${getErrorMessage(error)}`);
    }
}

export { NonceManager };