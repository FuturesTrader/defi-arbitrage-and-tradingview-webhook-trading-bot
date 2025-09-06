// scripts/debugTradeData.ts - Debug duration calculation issues
// Run with: tsx scripts/debugTradeData.ts

import fs from 'fs';
import path from 'path';

function formatCDTTimestamp(unixTimestamp: number): string {
    const date = new Date(unixTimestamp * 1000);
    const datePart = date.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const timePart = date.toLocaleTimeString('en-GB', {
        timeZone: 'America/Chicago',
        hour12: false,
    });
    const timeZone = date.toLocaleDateString('en-US', {
        timeZone: 'America/Chicago',
        timeZoneName: 'short',
    }).split(', ')[1];
    return `${datePart} ${timePart} ${timeZone}`;
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
}

async function debugTradeData() {
    console.log('🔍 DEBUGGING TRADE DURATION CALCULATIONS\n');

    const completedTradesFile = path.join(process.cwd(), 'data', 'trades', 'trades_completed.json');

    if (!fs.existsSync(completedTradesFile)) {
        console.log('❌ No completed trades file found.');
        return;
    }

    try {
        const data = fs.readFileSync(completedTradesFile, 'utf8');
        const completedTrades = JSON.parse(data);

        console.log(`📊 Found ${completedTrades.length} completed trades\n`);

        for (let i = 0; i < Math.min(3, completedTrades.length); i++) {
            const trade = completedTrades[i];

            console.log(`🔍 TRADE ${i + 1}: ${trade.tradePairId}`);
            console.log('─'.repeat(80));

            // Raw timestamp data
            console.log('📅 RAW TIMESTAMP DATA:');
            console.log(`   Entry Leg Signal Timestamp: ${trade.entryLeg?.signalTimestamp}`);
            console.log(`   Exit Leg Signal Timestamp: ${trade.exitLeg?.signalTimestamp}`);
            console.log(`   Entry Leg Execution Timestamp: ${trade.entryLeg?.executionTimestamp}`);
            console.log(`   Exit Leg Execution Timestamp: ${trade.exitLeg?.executionTimestamp}`);

            // Formatted timestamp data
            console.log('\n🕒 FORMATTED TIMESTAMP DATA:');
            console.log(`   Entry Leg signalTimestampCDT: ${trade.entryLeg?.signalTimestampCDT}`);
            console.log(`   Exit Leg signalTimestampCDT: ${trade.exitLeg?.signalTimestampCDT}`);
            console.log(`   Entry Leg executionTimestampCDT: ${trade.entryLeg?.executionTimestampCDT}`);
            console.log(`   Exit Leg executionTimestampCDT: ${trade.exitLeg?.executionTimestampCDT}`);

            // Current trade data
            console.log('\n📊 CURRENT TRADE DURATION DATA:');
            console.log(`   signalDurationMs: ${trade.signalDurationMs}`);
            console.log(`   signalDurationFormatted: ${trade.signalDurationFormatted}`);
            console.log(`   tradeDurationMs: ${trade.tradeDurationMs}`);
            console.log(`   tradeDurationFormatted: ${trade.tradeDurationFormatted}`);

            // Current CSV export data
            console.log('\n📋 CURRENT CSV EXPORT DATA:');
            console.log(`   entrySignalCDT: ${trade.entrySignalCDT}`);
            console.log(`   exitSignalCDT: ${trade.exitSignalCDT}`);
            console.log(`   entryDateCDT: ${trade.entryDateCDT}`);
            console.log(`   exitDateCDT: ${trade.exitDateCDT}`);

            // Calculate what SHOULD be the correct values
            if (trade.entryLeg?.signalTimestamp && trade.exitLeg?.signalTimestamp) {
                console.log('\n🔧 CORRECT CALCULATIONS:');

                // Determine chronological order
                const isEntryFirst = trade.entryLeg.signalTimestamp <= trade.exitLeg.signalTimestamp;
                const firstTimestamp = isEntryFirst ? trade.entryLeg.signalTimestamp : trade.exitLeg.signalTimestamp;
                const secondTimestamp = isEntryFirst ? trade.exitLeg.signalTimestamp : trade.entryLeg.signalTimestamp;

                const correctDurationMs = (secondTimestamp - firstTimestamp) * 1000;
                const correctDurationMinutes = correctDurationMs / (1000 * 60);
                const correctDurationFormatted = formatDuration(correctDurationMs);

                const firstCDT = formatCDTTimestamp(firstTimestamp);
                const secondCDT = formatCDTTimestamp(secondTimestamp);

                console.log(`   Chronological Order: ${isEntryFirst ? 'Entry → Exit' : 'Exit → Entry'}`);
                console.log(`   First Signal Timestamp: ${firstTimestamp} → ${firstCDT}`);
                console.log(`   Second Signal Timestamp: ${secondTimestamp} → ${secondCDT}`);
                console.log(`   Correct Duration: ${correctDurationMs}ms = ${correctDurationMinutes.toFixed(2)} minutes = ${correctDurationFormatted}`);

                // Compare with current
                const isCorrect = Math.abs(correctDurationMs - (trade.signalDurationMs || trade.tradeDurationMs || 0)) < 1000;
                console.log(`   Current Duration Correct: ${isCorrect ? '✅ YES' : '❌ NO'}`);

                if (!isCorrect) {
                    console.log(`   🚨 ISSUE: Current shows ${trade.signalDurationFormatted || trade.tradeDurationFormatted} but should be ${correctDurationFormatted}`);
                }
            } else {
                console.log('\n⚠️  Missing timestamp data - cannot calculate correct duration');
            }

            console.log('\n' + '='.repeat(80) + '\n');
        }

        // Summary
        console.log('📋 DEBUGGING SUMMARY:');
        console.log('1. Check if raw timestamps are correct');
        console.log('2. Verify chronological ordering logic');
        console.log('3. Check if formatCDTTimestamp is working correctly');
        console.log('4. Verify CSV export is using the right fields');
        console.log('\n🔧 Next steps:');
        console.log('1. Replace createCompletedTrade with the fixed version');
        console.log('2. Run migration script to fix historical data');
        console.log('3. Test with new trades to verify fix');

    } catch (error) {
        console.error('❌ Error debugging trade data:', error);
    }
}

// ES module check - run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    debugTradeData();
}