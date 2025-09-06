// Create a file: scripts/fixGasCosts.ts and run it once

import { tradeTracker } from '../src/tradeTracker';

async function fixGasCosts() {
    console.log('🔧 Fixing corrupted gas costs in summary...');

    // Show current corrupted values
    const currentSummary = tradeTracker.getTradeSummary();
    console.log('BEFORE FIX:');
    console.log(`Total Gas Costs: ${currentSummary.totalGasCosts.toFixed(4)} USDC`);
    console.log(`Average Gas Cost: ${currentSummary.averageGasCost.toFixed(4)} USDC`);

    // Run the fix (add the method from the previous artifact to tradeTracker.ts first)
    await tradeTracker.recalculateSummaryFromCompletedTrades();

    // Show fixed values
    const fixedSummary = tradeTracker.getTradeSummary();
    console.log('\nAFTER FIX:');
    console.log(`Total Gas Costs: ${fixedSummary.totalGasCosts.toFixed(4)} USDC`);
    console.log(`Average Gas Cost: ${fixedSummary.averageGasCost.toFixed(4)} USDC`);

    console.log('\n✅ Gas costs fixed! Now regenerate reports to see correct values.');
}

fixGasCosts().catch(console.error);