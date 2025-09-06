// src/scripts/testMonitoring.ts
import { PriceMonitorService } from './services/priceMonitorService';
import { ARBITRAGE_SETTINGS } from './constants';
import { sleep, getErrorMessage } from './utils';
import logger from './logger';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    try {
        logger.info('Starting arbitrage opportunity monitoring (Test Mode - No Execution)');

        // Initialize the price monitoring service
        const priceMonitor = new PriceMonitorService(ARBITRAGE_SETTINGS.MIN_PROFIT_THRESHOLD);

        // Track statistics
        let cycleCount = 0;
        let opportunitiesFound = 0;
        const profitsByDirection: Record<string, number[]> = {
            'uniswap->traderjoe': [],
            'traderjoe->uniswap': []
        };

        // Monitor for a fixed duration or until interrupted
        const monitoringDuration = 1 * 60 * 60 * 1000; // 1 hour in milliseconds
        const startTime = performance.now();

        while (performance.now() - startTime < monitoringDuration) {
            cycleCount++;

            try {
                logger.info(`Starting monitoring cycle ${cycleCount}`);
                const opportunity = await priceMonitor.findArbitrageOpportunity();

                if (opportunity) {
                    opportunitiesFound++;
                    const direction = `${opportunity.startDex}->${opportunity.endDex}`;
                    const profit = parseFloat(opportunity.expectedProfit);

                    if (direction === 'uniswap->traderjoe') {
                        profitsByDirection['uniswap->traderjoe'].push(profit);
                    } else {
                        profitsByDirection['traderjoe->uniswap'].push(profit);
                    }

                    logger.info('Arbitrage opportunity found (Test Mode - Not Executing)', {
                        cycle: cycleCount,
                        direction,
                        profitPercent: `${opportunity.profitPercent.toFixed(4)}%`,
                        profitAmount: opportunity.expectedProfit,
                        priceImpact: opportunity.metrics?.priceImpact,
                        gasCost: opportunity.gasCosts?.estimatedGasCostUSDC,
                        tokenPath: 'USDC→WAVAX→USDC'
                    });
                } else {
                    logger.info(`No arbitrage opportunity found in cycle ${cycleCount}`);
                }
            } catch (error) {
                logger.error(`Error in monitoring cycle ${cycleCount}`, {
                    error: getErrorMessage(error)
                });
            }

            // Wait for the next monitoring interval
            await sleep(ARBITRAGE_SETTINGS.MONITORING_INTERVAL);
        }

        // Report statistics
        const calculateStats = (profits: number[]) => {
            if (profits.length === 0) return { min: 0, max: 0, avg: 0, count: 0 };
            const min = Math.min(...profits);
            const max = Math.max(...profits);
            const avg = profits.reduce((sum, val) => sum + val, 0) / profits.length;
            return { min, max, avg, count: profits.length };
        };

        const uniToJoeStats = calculateStats(profitsByDirection['uniswap->traderjoe']);
        const joeToUniStats = calculateStats(profitsByDirection['traderjoe->uniswap']);

        logger.info('Monitoring test completed', {
            totalCycles: cycleCount,
            totalOpportunities: opportunitiesFound,
            opportunityRate: `${((opportunitiesFound / cycleCount) * 100).toFixed(2)}%`,
            uniToJoeOpportunities: {
                count: uniToJoeStats.count,
                minProfit: uniToJoeStats.min.toFixed(6),
                maxProfit: uniToJoeStats.max.toFixed(6),
                avgProfit: uniToJoeStats.avg.toFixed(6)
            },
            joeToUniOpportunities: {
                count: joeToUniStats.count,
                minProfit: joeToUniStats.min.toFixed(6),
                maxProfit: joeToUniStats.max.toFixed(6),
                avgProfit: joeToUniStats.avg.toFixed(6)
            },
            recommendedSettings: {
                minProfitThreshold: Math.max(0.001, uniToJoeStats.avg/2, joeToUniStats.avg/2).toFixed(6),
                gasBuffer: '1.2x',
                monitoringInterval: `${ARBITRAGE_SETTINGS.MONITORING_INTERVAL}ms`
            }
        });

        // Shutdown
        await priceMonitor.shutdown();
        await logger.flush();

    } catch (error) {
        logger.error('Fatal error in test monitoring', {
            error: getErrorMessage(error)
        });
        process.exit(1);
    }
}

main().catch(console.error);