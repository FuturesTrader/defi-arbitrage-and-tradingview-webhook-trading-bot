import { tradeTracker } from '../src/tradeTracker.ts';

async function main() {
    const command = process.argv[2];
    const tradeId = process.argv[3];

    try {
        switch (command) {
            case 'list':
                console.log('📊 Listing all trades...\n');
                tradeTracker.listAllTrades();
                break;

            case 'remove':
                if (!tradeId) {
                    console.error('❌ Error: Please provide a trade ID to remove');
                    console.log('Usage: yarn trade:remove <trade-pair-id>');
                    console.log('Example: yarn trade:remove pair_trade_1750783530724_5dsj8i_trade_1750785115405_a1mpot');
                    process.exit(1);
                }
                console.log(`🗑️ Removing trade: ${tradeId}`);
                await tradeTracker.removeTradeById(tradeId);
                console.log('✅ Trade removed successfully!');
                console.log('\n📊 Updated trade list:');
                tradeTracker.listAllTrades();
                break;

            case 'summary':
                const summary = tradeTracker.getTradeSummary();
                console.log('\n📈 TRADE SUMMARY');
                console.log('==================');
                console.log(`Total Trades: ${summary.totalTrades}`);
                console.log(`Profitable: ${summary.profitableTrades}`);
                console.log(`Losing: ${summary.losingTrades}`);
                console.log(`Win Rate: ${summary.winRate.toFixed(2)}%`);
                console.log(`Total Net Profit: ${summary.totalNetProfit.toFixed(4)} USDC`);
                console.log(`Total Gas Costs: ${summary.totalGasCosts.toFixed(4)} USDC`);
                console.log(`Average Gas Cost: ${summary.averageGasCost.toFixed(4)} USDC`);
                break;

            case 'recalculate':
                console.log('🔧 Recalculating summary from completed trades...');
                await tradeTracker.recalculateSummaryFromCompletedTrades();
                console.log('✅ Summary recalculated!');
                break;
            case 'clear-active':
                const olderThan = process.argv[4];
                const options: any = { confirm: true, backup: true };

                if (olderThan && !isNaN(Number(olderThan))) {
                    options.olderThanMinutes = Number(olderThan);
                    console.log(`🧹 Clearing active trades older than ${olderThan} minutes...`);
                } else {
                    console.log('🧹 Clearing ALL active trades...');
                }

                const clearedCount = tradeTracker.clearActiveTrades(options);
                console.log(`✅ Cleared ${clearedCount} active trades`);

                if (clearedCount > 0) {
                    console.log('\n📊 Remaining active trades:');
                    tradeTracker.listAllTrades();
                }
                break;
            case 'clear-active-preview':
                console.log('👀 Preview: Active trades that would be cleared');
                console.log('(This is a dry run - no trades will be removed)\n');
                tradeTracker.clearActiveTrades({ confirm: false });
                break;
            case 'active':
                const activeTrades = tradeTracker.getActiveTrades();
                console.log('\n🔄 ACTIVE (UNMATCHED) TRADES');
                console.log('==============================');
                if (activeTrades.length === 0) {
                    console.log('No active trades found');
                } else {
                    activeTrades.forEach((trade, index) => {
                        console.log(`${index + 1}. ${trade.tradeId}`);
                        console.log(`   Type: ${trade.signalType} ${trade.tradeDirection}`);
                        console.log(`   Pair: ${trade.tokenPair}`);
                        console.log(`   Date: ${trade.signalTimestampCDT || trade.entryTimestampCDT}`);
                        console.log(`   Status: ${trade.status}`);
                        console.log('');
                    });
                }
                break;
                case 'help':
            default:
                console.log('🔧 Trade Management Commands');
                console.log('==============================');
                console.log('yarn trade:list                    - List all trades (active + completed)');
                console.log('yarn trade:active                  - Show only active (unmatched) trades');
                console.log('yarn trade:remove <id>             - Remove specific trade pair');
                console.log('yarn trade:clear-active            - Clear ALL active trades');
                console.log('yarn trade:clear-active <minutes>  - Clear active trades older than X minutes');
                console.log('yarn trade:clear-preview           - Preview what would be cleared (dry run)');
                console.log('yarn trade:summary                 - Show trade summary');
                console.log('yarn trade:recalculate             - Recalculate summary');
                console.log('yarn trade:help                    - Show this help');
                console.log('');
                console.log('Examples:');
                console.log('yarn trade:active                  # Show active trades');
                console.log('yarn trade:clear-preview           # See what would be cleared');
                console.log('yarn trade:clear-active            # Clear all active trades');
                console.log('yarn trade:clear-active 60         # Clear trades older than 1 hour');
                console.log('yarn trade:remove pair_123_456     # Remove specific completed trade');
                break;
        }
    } catch (error) {
        console.error('❌ Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main().catch(console.error);