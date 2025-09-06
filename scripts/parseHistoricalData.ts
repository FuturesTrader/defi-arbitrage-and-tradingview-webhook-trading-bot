// scripts/parseHistoricalData.ts - Attempt to fix historical trades by parsing CDT timestamps
// Run with: tsx scripts/parseHistoricalData.ts

import fs from 'fs';
import path from 'path';

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

function parseCDTTimestamp(cdtString: string): number | null {
    try {
        // Parse "2025-06-24T09:36:05.000 CDT" format
        const match = cdtString.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\s+CDT$/);
        if (!match) {
            console.warn(`Cannot parse CDT timestamp: ${cdtString}`);
            return null;
        }

        // Convert to UTC then to timestamp
        const isoString = match[1] + 'Z'; // Treat as UTC first
        const utcDate = new Date(isoString);

        // CDT is UTC-5, so add 5 hours to get the actual UTC time
        const cdtOffsetHours = 5;
        const actualUtcTime = new Date(utcDate.getTime() + (cdtOffsetHours * 60 * 60 * 1000));

        return Math.floor(actualUtcTime.getTime() / 1000);
    } catch (error) {
        console.warn(`Error parsing CDT timestamp ${cdtString}:`, error);
        return null;
    }
}

async function parseHistoricalData() {
    console.log('🔧 ATTEMPTING TO PARSE HISTORICAL CDT TIMESTAMPS\n');

    const completedTradesFile = path.join(process.cwd(), 'data', 'trades', 'trades_completed.json');

    if (!fs.existsSync(completedTradesFile)) {
        console.log('❌ No completed trades file found.');
        return;
    }

    // Create backup
    const backupFile = completedTradesFile + '.backup-before-parse';
    fs.copyFileSync(completedTradesFile, backupFile);
    console.log(`📁 Backup created: ${backupFile}\n`);

    try {
        const data = fs.readFileSync(completedTradesFile, 'utf8');
        const completedTrades = JSON.parse(data);

        console.log(`📊 Processing ${completedTrades.length} completed trades...\n`);

        let successfulFixes = 0;
        let failedFixes = 0;

        for (const trade of completedTrades) {
            console.log(`🔍 Processing ${trade.tradePairId}:`);

            const entryDateCDT = trade.entryDateCDT;
            const exitDateCDT = trade.exitDateCDT;

            if (!entryDateCDT || !exitDateCDT) {
                console.log(`   ❌ Missing CDT timestamps`);
                failedFixes++;
                continue;
            }

            // Parse CDT timestamps to raw timestamps
            const entryTimestamp = parseCDTTimestamp(entryDateCDT);
            const exitTimestamp = parseCDTTimestamp(exitDateCDT);

            if (!entryTimestamp || !exitTimestamp) {
                console.log(`   ❌ Could not parse CDT timestamps`);
                failedFixes++;
                continue;
            }

            // Calculate correct duration
            const isEntryFirst = entryTimestamp <= exitTimestamp;
            const firstTimestamp = isEntryFirst ? entryTimestamp : exitTimestamp;
            const secondTimestamp = isEntryFirst ? exitTimestamp : entryTimestamp;

            const correctDurationMs = (secondTimestamp - firstTimestamp) * 1000;
            const correctDurationFormatted = formatDuration(correctDurationMs);

            // Update the trade with parsed data
            if (trade.entryLeg && trade.exitLeg) {
                // Add missing timestamp fields
                trade.entryLeg.signalTimestamp = entryTimestamp;
                trade.entryLeg.executionTimestamp = entryTimestamp;
                trade.entryLeg.signalTimestampCDT = entryDateCDT;
                trade.entryLeg.executionTimestampCDT = entryDateCDT;

                trade.exitLeg.signalTimestamp = exitTimestamp;
                trade.exitLeg.executionTimestamp = exitTimestamp;
                trade.exitLeg.signalTimestampCDT = exitDateCDT;
                trade.exitLeg.executionTimestampCDT = exitDateCDT;

                // Fix duration calculations
                trade.signalDurationMs = correctDurationMs;
                trade.signalDurationFormatted = correctDurationFormatted;
                trade.executionDurationMs = correctDurationMs;
                trade.executionDurationFormatted = correctDurationFormatted;
                trade.tradeDurationMs = correctDurationMs;
                trade.tradeDurationFormatted = correctDurationFormatted;

                // Fix timing details
                trade.entrySignalCDT = isEntryFirst ? entryDateCDT : exitDateCDT;
                trade.exitSignalCDT = isEntryFirst ? exitDateCDT : entryDateCDT;
                trade.entryExecutionCDT = trade.entrySignalCDT;
                trade.exitExecutionCDT = trade.exitSignalCDT;

                console.log(`   ✅ Fixed duration: ${correctDurationFormatted} (was ${trade.summary?.split(' in ')[1] || 'unknown'})`);
                successfulFixes++;
            } else {
                console.log(`   ❌ Missing entryLeg or exitLeg`);
                failedFixes++;
            }
        }

        // Save updated trades
        fs.writeFileSync(completedTradesFile, JSON.stringify(completedTrades, null, 2));

        console.log('\n📋 PARSING SUMMARY:');
        console.log(`   Successful fixes: ${successfulFixes}`);
        console.log(`   Failed fixes: ${failedFixes}`);
        console.log(`   Backup saved: ${backupFile}`);

        if (successfulFixes > 0) {
            console.log('\n✅ Historical data parsing completed!');
            console.log('🔧 Next steps:');
            console.log('   1. Run yarn reports:generate to see corrected CSV');
            console.log('   2. Verify the durations are now correct');
            console.log('   3. If satisfied, continue with normal trading');
        } else {
            console.log('\n❌ No trades could be fixed.');
            console.log('💡 Recommendation: Use future-only approach for clean data');
        }

    } catch (error) {
        console.error('❌ Error parsing historical data:', error);
        console.log('🔄 Restoring backup...');
        fs.copyFileSync(backupFile, completedTradesFile);
    }
}

// ES module check - run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    parseHistoricalData();
}