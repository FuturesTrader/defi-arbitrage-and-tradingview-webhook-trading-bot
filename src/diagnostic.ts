#!/usr/bin/env tsx
// Enhanced Trade Tracking Diagnostic Script with Environment Loading
// Run from project root: yarn tsx diagnostic.ts

import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

// Force load environment variables
console.log('🔧 Loading environment variables...');
const envResult = config();
if (envResult.error) {
    console.log('❌ Error loading .env file:', envResult.error.message);
} else {
    console.log('✅ Environment variables loaded successfully');
}

// Import after environment is loaded
import { tradeTracker } from './tradeTracker.ts';
import { TransactionState } from './tradeTypes.ts';

async function runEnhancedDiagnostic() {
    console.log('🔍 ENHANCED TRADE TRACKING DIAGNOSTIC REPORT');
    console.log('=============================================\n');

    // 0. Current Working Directory
    console.log('0. WORKING DIRECTORY:');
    console.log('   Current directory:', process.cwd());
    console.log('   Expected project root: /home/todd/WebstormProjects/ExecuteTradeSmartContractFlashLoanV15BTC');
    console.log('   Is in project root:', process.cwd().endsWith('ExecuteTradeSmartContractFlashLoanV15BTC'));
    console.log('');

    // 1. Check Environment Variables (ENHANCED)
    console.log('1. ENVIRONMENT VARIABLES (ENHANCED):');
    console.log('   ENABLE_TRADE_TRACKING:', process.env.ENABLE_TRADE_TRACKING || 'undefined');
    console.log('   AUTO_GENERATE_REPORTS:', process.env.AUTO_GENERATE_REPORTS || 'undefined');
    console.log('   TEST_MODE:', process.env.TEST_MODE || 'undefined');
    console.log('   BUY_MODE:', process.env.BUY_MODE || 'undefined');
    console.log('   BUY_AMOUNT:', process.env.BUY_AMOUNT || 'undefined');
    console.log('   REQUIRE_SECRET:', process.env.REQUIRE_SECRET || 'undefined');

    // Check .env file directly
    const envPath = path.join(process.cwd(), '.env');
    console.log('   .env file exists at', envPath + ':', fs.existsSync(envPath));
    if (fs.existsSync(envPath)) {
        try {
            const envContent = fs.readFileSync(envPath, 'utf8');
            console.log('   .env file size:', envContent.length, 'bytes');
            console.log('   .env contains ENABLE_TRADE_TRACKING:', envContent.includes('ENABLE_TRADE_TRACKING'));
        } catch (error) {
            console.log('   ❌ Cannot read .env file:', error);
        }
    }
    console.log('');

    // 2. Check File System
    console.log('2. FILE SYSTEM CHECK:');
    const dataDir = path.join(process.cwd(), 'data', 'trades');
    const activeFile = path.join(dataDir, 'trades_active.json');
    const completedFile = path.join(dataDir, 'trades_completed.json');
    const summaryFile = path.join(dataDir, 'trades_summary.json');

    console.log('   Data directory exists:', fs.existsSync(dataDir));
    console.log('   Data directory path:', dataDir);
    console.log('   Active trades file exists:', fs.existsSync(activeFile));
    console.log('   Completed trades file exists:', fs.existsSync(completedFile));
    console.log('   Summary file exists:', fs.existsSync(summaryFile));

    if (fs.existsSync(dataDir)) {
        try {
            const stats = fs.statSync(dataDir);
            console.log('   Directory permissions:', stats.mode.toString(8));
        } catch (error) {
            console.log('   ❌ Cannot read directory stats:', error);
        }
    }
    console.log('');

    // 3. Check File Contents
    console.log('3. FILE CONTENTS:');

    try {
        if (fs.existsSync(activeFile)) {
            const activeData = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
            console.log('   Active trades count:', activeData.length);
            if (activeData.length > 0) {
                console.log('   Latest active trade:', activeData[activeData.length - 1].tradeId);
            }
        } else {
            console.log('   ❌ Active trades file missing');
        }

        if (fs.existsSync(completedFile)) {
            const completedData = JSON.parse(fs.readFileSync(completedFile, 'utf8'));
            console.log('   Completed trades count:', completedData.length);
        } else {
            console.log('   ❌ Completed trades file missing');
        }

        if (fs.existsSync(summaryFile)) {
            const summaryData = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
            console.log('   Total recorded trades:', summaryData.totalTrades);
            console.log('   Last updated:', summaryData.lastUpdated);
            console.log('   Win rate:', summaryData.winRate.toFixed(2) + '%');
            console.log('   Net profit:', summaryData.totalNetProfit.toFixed(4), 'USDC');
        } else {
            console.log('   ❌ Summary file missing');
        }
    } catch (error) {
        console.log('   ❌ Error reading files:', error);
    }
    console.log('');

    // 4. Test TradeTracker Methods
    console.log('4. TRADETRACKER METHODS TEST:');
    try {
        const activeTrades = tradeTracker.getActiveTrades();
        console.log('   ✅ getActiveTrades() works, count:', activeTrades.length);

        const completedTrades = tradeTracker.getCompletedTrades();
        console.log('   ✅ getCompletedTrades() works, count:', completedTrades.length);

        const summary = tradeTracker.getTradeSummary();
        console.log('   ✅ getTradeSummary() works, total trades:', summary.totalTrades);
    } catch (error) {
        console.log('   ❌ TradeTracker method error:', error);
    }
    console.log('');

    // 5. Test Write Permissions
    console.log('5. WRITE PERMISSIONS TEST:');
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        const testFile = path.join(dataDir, 'test_write.json');
        fs.writeFileSync(testFile, '{"test": true}');
        fs.unlinkSync(testFile);
        console.log('   ✅ Write permissions OK');
    } catch (error) {
        console.log('   ❌ Write permission error:', error);
    }
    console.log('');

    // 6. Recent Log Analysis (CORRECTED PATH)
    console.log('6. RECENT LOG ANALYSIS:');
    const logFile = path.join(process.cwd(), 'logs', 'application-2025-06-22.log');
    console.log('   Looking for log file at:', logFile);
    if (fs.existsSync(logFile)) {
        try {
            const logContent = fs.readFileSync(logFile, 'utf8');
            const lines = logContent.split('\n');

            // Look for trade tracking related messages
            const trackingMessages = lines.filter(line =>
                line.includes('Trade recording') ||
                line.includes('shouldRecord') ||
                line.includes('Trade not recorded') ||
                line.includes('Trade recorded successfully') ||
                line.includes('Enhanced Trade Recording')
            );

            console.log('   Recent tracking log messages:');
            if (trackingMessages.length === 0) {
                console.log('     ⚠️ No trade recording messages found in logs');
            } else {
                trackingMessages.slice(-10).forEach(msg => {
                    console.log('     -', msg.substring(0, 150) + '...');
                });
            }
        } catch (error) {
            console.log('   ❌ Cannot read log file:', error);
        }
    } else {
        console.log('   ⚠️ Log file not found at:', logFile);

        // Try to find any log files
        const logsDir = path.join(process.cwd(), 'logs');
        if (fs.existsSync(logsDir)) {
            const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
            console.log('   Available log files:', logFiles);
        }
    }
    console.log('');

    // 7. ENHANCED Recommendations
    console.log('7. ENHANCED RECOMMENDATIONS:');

    const isProjectRoot = process.cwd().endsWith('ExecuteTradeSmartContractFlashLoanV15BTC');
    const hasEnvFile = fs.existsSync(path.join(process.cwd(), '.env'));
    const trackingEnabled = process.env.ENABLE_TRADE_TRACKING === 'true';

    if (!isProjectRoot) {
        console.log('   🔧 Navigate to project root: cd /home/todd/WebstormProjects/ExecuteTradeSmartContractFlashLoanV15BTC');
    }

    if (!hasEnvFile) {
        console.log('   🔧 Create .env file in project root with:');
        console.log('       ENABLE_TRADE_TRACKING=true');
        console.log('       TEST_MODE=false');
        console.log('       BUY_MODE=fixed');
        console.log('       BUY_AMOUNT=15');
        console.log('       AUTO_GENERATE_REPORTS=false');
        console.log('       REQUIRE_SECRET=true');
    }

    if (!trackingEnabled) {
        console.log('   🔧 CRITICAL: Set ENABLE_TRADE_TRACKING=true in .env file');
    }

    if (!fs.existsSync(dataDir)) {
        console.log('   🔧 Create data directory: mkdir -p data/trades');
    }

    console.log('   🔧 Apply the fixed recordTradeIfEnabled function from Solution 1');
    console.log('   🔧 Run test trade from project root: yarn tsx src/mainUniswap.ts WBTC_TO_USDC --percent=1');
    console.log('   🔧 Check logs for "Enhanced Trade Recording Conditions Check" messages');

    console.log('\n✅ Enhanced diagnostic complete!');

    // 8. QUICK TEST - Try to create a test trade record
    console.log('\n8. QUICK TRADE RECORDING TEST:');
    if (trackingEnabled) {
        try {
            console.log('   🧪 Attempting to create a test trade record...');

            const testTradeData = {
                webhookData: {
                    side: 'sell' as const,
                    product: 'BTC/USDC',
                    network: 'Avalanche',
                    exchange: 'Uniswap'
                },
                tradeDirection: 'WBTC_TO_USDC' as const,
                tradeResult: {
                    success: true,
                    tradeId: 'diagnostic_test_' + Date.now(),
                    actualAmountIn: '0.001',
                    actualAmountOut: '95.50'
                },
                executionResult: {
                    hash: '0xtest_diagnostic_' + Math.random().toString(36).substring(2),
                    state: TransactionState.Sent,
                    blockNumber: BigInt(12345)
                },
                webhookId: 'diagnostic_test_' + Date.now(),
                signalType: 'Diagnostic Test',
                executionTime: 1500
            };

            const recordedId = await tradeTracker.recordTrade(testTradeData);
            console.log('   ✅ Test trade recorded successfully with ID:', recordedId);

            // Verify it was stored
            const activeTrades = tradeTracker.getActiveTrades();
            console.log('   ✅ Active trades count after test:', activeTrades.length);

            if (activeTrades.length > 0) {
                const latestTrade = activeTrades[activeTrades.length - 1];
                console.log('   ✅ Latest trade ID:', latestTrade.tradeId);
                console.log('   ✅ Latest trade status:', latestTrade.status);
            }

        } catch (error) {
            console.log('   ❌ Test trade recording failed:', error);
        }
    } else {
        console.log('   ⚠️ Skipping test - ENABLE_TRADE_TRACKING is not true');
    }
}

// Run the enhanced diagnostic
runEnhancedDiagnostic().catch(console.error);