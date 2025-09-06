#!/bin/bash
# scripts/trade-management.sh - Enhanced Trade Tracking Management with Address Analytics
# Manage trade tracking, generate reports, monitor P&L, and analyze blockchain addresses

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
WEBHOOK_URL="https://autobot.ngrok.dev"
DATA_DIR="data/trades"
REPORTS_DIR="data/reports"
LOG_DIR="logs"

# Helper functions
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${CYAN}ℹ️  $1${NC}"
}

print_status() {
    echo -e "${PURPLE}🔍 $1${NC}"
}

# Check if trade tracking is enabled
check_tracking_enabled() {
    local response=$(curl -s "$WEBHOOK_URL/trades/summary" 2>/dev/null)
    if echo "$response" | grep -q "Trade tracking is disabled"; then
        print_error "Trade tracking is disabled on the server"
        print_info "Set ENABLE_TRADE_TRACKING=true in .env file and restart server"
        exit 1
    fi
}

# Ensure directories exist
ensure_directories() {
    mkdir -p "$DATA_DIR" "$REPORTS_DIR" "$LOG_DIR"
}

# 🔧 ENHANCED: Display trade summary with address analytics
show_summary() {
    print_header "Enhanced Trade Summary with Address Analytics"
    
    check_tracking_enabled
    
    local summary=$(curl -s "$WEBHOOK_URL/trades/summary" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$summary" ]; then
        echo "$summary" | jq -r '
            "📊 ENHANCED TRADING PERFORMANCE SUMMARY",
            "Last Updated: " + (.lastUpdated | todate),
            "",
            "📈 TRADE STATISTICS:",
            "  Total Trades: " + (.totalTrades | tostring),
            "  Profitable: " + (.profitableTrades | tostring),
            "  Losing: " + (.losingTrades | tostring),
            "  Breakeven: " + (.breakevenTrades | tostring),
            "",
            "💰 PROFIT & LOSS:",
            "  Total Net Profit: " + (.totalNetProfit | tostring) + " USDC",
            "  Total Gas Costs: " + (.totalGasCosts | tostring) + " USDC",
            "  Average Profit: " + (.averageProfit | tostring) + " USDC",
            "  Win Rate: " + (.winRate | tostring) + "%",
            "",
            "⏱️  TIMING METRICS:",
            "  Avg Trade Duration: " + ((.averageTradeDuration / 1000 / 60) | floor | tostring) + " minutes",
            "  Longest Trade: " + ((.longestTrade / 1000 / 60) | floor | tostring) + " minutes",
            "  Shortest Trade: " + ((.shortestTrade / 1000) | floor | tostring) + " seconds",
            "",
            "🔗 PROTOCOL ANALYTICS (NEW):",
            "  Unique Tokens: " + (.protocolAnalytics.totalUniqueTokens | tostring),
            "  Unique Pools: " + (.protocolAnalytics.totalUniquePools | tostring),
            "  Unique Routers: " + (.protocolAnalytics.totalUniqueRouters | tostring),
            "  Most Used Router: " + .protocolAnalytics.mostUsedRouter,
            "  Most Traded Pair: " + .protocolAnalytics.mostTradedTokenPair,
            "  Avg Gas per Trade: " + (.protocolAnalytics.averageGasPerTrade | tostring) + " USDC",
            "  Gas Efficiency Trend: " + (.protocolAnalytics.gasEfficiencyTrend | tostring) + "%"
        '
        
        # Show enhanced token performance
        print_info "Enhanced Token Performance:"
        echo "$summary" | jq -r '
            .tokenPerformance | to_entries[] | 
            "  " + .key + ": " + (.value.trades | tostring) + " trades, " + 
            (.value.netProfit | tostring) + " USDC profit, " + 
            (.value.winRate | tostring) + "% win rate" +
            if .value.tokenAddress and .value.tokenAddress != "N/A" then 
                " [" + .value.tokenAddress[0:10] + "...]" 
            else "" end
        '
    else
        print_error "Failed to fetch trade summary from server"
        print_info "Make sure the webhook server is running and accessible at $WEBHOOK_URL"
    fi
}

# 🔧 ENHANCED: Show active trades with address information
show_active() {
    print_header "Active Trades with Address Information"
    
    check_tracking_enabled
    
    local active=$(curl -s "$WEBHOOK_URL/trades/active" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$active" ]; then
        local count=$(echo "$active" | jq -r '.count')
        
        if [ "$count" -eq 0 ]; then
            print_info "No active trades found"
        else
            print_success "Found $count active trades:"
            echo ""
            echo "$active" | jq -r '.activeTrades[] | 
                "🔄 " + .tradeId + " (" + .signalType + ")",
                "   Token: " + .tokenPair,
                "   Direction: " + .tradeDirection,
                "   Amount: " + .entryAmount,
                "   Status: " + .status,
                "   Date: " + (.entryTimestamp | todate),
                "   🔗 Input Token: " + .tokenAddresses.inputToken.address,
                "   🔗 Output Token: " + .tokenAddresses.outputToken.address,
                "   🔗 Router: " + .protocolAddresses.routerAddress,
                if .protocolAddresses.poolAddress then "   🔗 Pool: " + .protocolAddresses.poolAddress else "" end,
                if .entryTxHash then "   📝 Tx Hash: " + .entryTxHash else "" end,
                ""
            '
        fi
    else
        print_error "Failed to fetch active trades from server"
    fi
}

# 🔧 ENHANCED: Show recent completed trades with address details
show_recent() {
    print_header "Recent Completed Trades with Address Details"
    
    check_tracking_enabled
    
    local limit=${1:-10}
    local completed=$(curl -s "$WEBHOOK_URL/trades/completed?limit=$limit" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$completed" ]; then
        local count=$(echo "$completed" | jq -r '.count')
        
        if [ "$count" -eq 0 ]; then
            print_info "No completed trades found"
        else
            print_success "Showing last $count completed trades:"
            echo ""
            echo "$completed" | jq -r '.completedTrades[] | 
                "💼 " + .tradePairId,
                "   " + .summary,
                "   Entry: " + (.entryLeg.entryTimestamp | todate),
                "   Exit: " + (.exitLeg.entryTimestamp | todate),
                "   Duration: " + .tradeDurationFormatted,
                "   Category: " + .tradeCategory,
                "   Exit Reason: " + .exitReason,
                "   🔗 Unique Addresses: " + (.addressSummary.totalUniqueAddresses | tostring),
                "   🔗 Routers Used: " + (.addressSummary.routersUsed | join(", ")),
                "   🔗 Pools Used: " + (.addressSummary.poolsUsed | join(", ")),
                "   ⛽ Gas Efficiency: " + (.gasAnalysis.gasEfficiency | tostring) + "%",
                "   📝 Entry Tx: " + (.entryLeg.entryTxHash // "N/A"),
                "   📝 Exit Tx: " + (.exitLeg.entryTxHash // "N/A"),
                ""
            '
        fi
    else
        print_error "Failed to fetch completed trades from server"
    fi
}

# 🔧 NEW: Address analysis function
show_address_analysis() {
    print_header "Blockchain Address Analysis"
    
    check_tracking_enabled
    
    local summary=$(curl -s "$WEBHOOK_URL/trades/summary" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$summary" ]; then
        echo "$summary" | jq -r '
            "🔗 BLOCKCHAIN ADDRESS ANALYTICS",
            "",
            "📊 PROTOCOL OVERVIEW:",
            "  Total Unique Token Contracts: " + (.protocolAnalytics.totalUniqueTokens | tostring),
            "  Total Unique Pool Contracts: " + (.protocolAnalytics.totalUniquePools | tostring),
            "  Total Unique Router Contracts: " + (.protocolAnalytics.totalUniqueRouters | tostring),
            "",
            "🎯 USAGE PATTERNS:",
            "  Most Used Router: " + .protocolAnalytics.mostUsedRouter,
            "  Most Traded Token Pair: " + .protocolAnalytics.mostTradedTokenPair,
            "",
            "⛽ GAS ANALYTICS:",
            "  Average Gas per Trade: " + (.protocolAnalytics.averageGasPerTrade | tostring) + " USDC",
            "  Gas Efficiency Trend: " + (.protocolAnalytics.gasEfficiencyTrend | tostring) + "% (positive = improving)",
            "",
            "💰 TOKEN CONTRACT PERFORMANCE:"
        '
        
        echo "$summary" | jq -r '
            .tokenPerformance | to_entries[] | 
            "  📈 " + .key + " Contract:",
            if .value.tokenAddress and .value.tokenAddress != "N/A" then
                "     Address: " + .value.tokenAddress
            else
                "     Address: Not available"
            end,
            "     Trades: " + (.value.trades | tostring),
            "     Net Profit: " + (.value.netProfit | tostring) + " USDC",
            "     Gas Usage: " + (.value.gasUsage | tostring) + " USDC",
            "     Avg Trade Size: " + (.value.averageTradeSize | tostring) + " USDC",
            ""
        '
    else
        print_error "Failed to fetch address analytics from server"
    fi
}

# 🔧 ENHANCED: Generate CSV reports with address tracking
generate_reports() {
    print_header "Generating Enhanced Trade Reports with Address Tracking"
    
    check_tracking_enabled
    ensure_directories
    
    print_status "Requesting comprehensive CSV report generation with address analytics..."
    
    local response=$(curl -s "$WEBHOOK_URL/trades/export/csv" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$response" ]; then
        if echo "$response" | grep -q "CSV reports generated successfully"; then
            print_success "Enhanced CSV reports generated successfully!"
            echo ""
            print_info "Generated files with address tracking:"
            echo "$response" | jq -r '.files | to_entries[] | "  📊 " + .key + ": " + .value'
            echo ""
            print_info "New features in this report:"
            print_info "  • Transaction hash tracking for all trades"
            print_info "  • Token contract addresses for input/output tokens"
            print_info "  • Pool contract addresses for liquidity sources"
            print_info "  • Router contract addresses for trade routing"
            print_info "  • Gas price analysis in Gwei"
            print_info "  • Address usage analytics"
            print_info "  • Protocol analytics summary"
            echo ""
            print_info "Reports are located in the $REPORTS_DIR directory"
        else
            print_error "Failed to generate enhanced CSV reports"
            echo "$response" | jq -r '.error // .message'
        fi
    else
        print_error "Failed to communicate with server for CSV generation"
    fi
}

# 🔧 NEW: Generate address analysis report
generate_address_report() {
    print_header "Generating Address Analysis Report"
    
    check_tracking_enabled
    ensure_directories
    
    print_status "Creating detailed blockchain address usage analysis..."
    
    # This would call a specific endpoint for address analysis
    # For now, we'll generate the full report and highlight the address analysis
    local response=$(curl -s "$WEBHOOK_URL/trades/export/csv" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$response" ]; then
        if echo "$response" | grep -q "CSV reports generated successfully"; then
            print_success "Address analysis report generated!"
            echo ""
            print_info "Look for these address-specific files:"
            echo "$response" | jq -r '.files | to_entries[] | 
                if (.key | contains("address") or .key | contains("protocol")) then
                    "  🔗 " + .key + ": " + .value
                else empty end'
            echo ""
            print_info "Address analysis includes:"
            print_info "  • Token contract usage frequency and volume"
            print_info "  • Pool contract utilization statistics"
            print_info "  • Router contract performance metrics"
            print_info "  • Gas price trends by contract interaction"
            print_info "  • Unique address interaction patterns"
        else
            print_error "Failed to generate address analysis report"
        fi
    else
        print_error "Failed to generate address analysis report"
    fi
}

# Generate daily report
generate_daily_report() {
    print_header "Generating Daily Report with Address Tracking"
    
    check_tracking_enabled
    ensure_directories
    
    print_status "Requesting daily report generation with enhanced address analytics..."
    
    local response=$(curl -s "$WEBHOOK_URL/trades/export/daily" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$response" ]; then
        if echo "$response" | grep -q "Daily reports generated successfully"; then
            print_success "Daily reports with address tracking generated successfully!"
            echo ""
            print_info "Generated files:"
            echo "$response" | jq -r '.files[]' | while read file; do
                echo "  📄 $file"
            done
        else
            print_error "Failed to generate daily reports"
            echo "$response" | jq -r '.error // .message'
        fi
    else
        print_error "Failed to communicate with server for daily report generation"
    fi
}

# Open reports directory
open_reports() {
    if [ -d "$REPORTS_DIR" ]; then
        if command -v open >/dev/null 2>&1; then
            # macOS
            open "$REPORTS_DIR"
            print_success "Opened reports directory in Finder"
        elif command -v xdg-open >/dev/null 2>&1; then
            # Linux
            xdg-open "$REPORTS_DIR"
            print_success "Opened reports directory in file manager"
        elif command -v explorer.exe >/dev/null 2>&1; then
            # WSL/Windows
            explorer.exe "$REPORTS_DIR"
            print_success "Opened reports directory in Windows Explorer"
        else
            print_info "Reports directory: $(pwd)/$REPORTS_DIR"
            print_info "Open this directory manually to view enhanced CSV files with address tracking"
        fi
    else
        print_warning "Reports directory doesn't exist yet"
        print_info "Generate reports first using: $0 generate-reports"
    fi
}

# 🔧 ENHANCED: Show profit/loss analysis with gas efficiency
show_pnl_analysis() {
    print_header "Enhanced Profit & Loss Analysis with Gas Efficiency"
    
    check_tracking_enabled
    
    local summary=$(curl -s "$WEBHOOK_URL/trades/summary" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$summary" ]; then
        echo "$summary" | jq -r '
            "💰 ENHANCED P&L BREAKDOWN WITH GAS ANALYTICS",
            "",
            "🎯 OVERALL PERFORMANCE:",
            "  Win Rate: " + (.winRate | tostring) + "%",
            "  Total Trades: " + (.totalTrades | tostring),
            "  Profitable: " + (.profitableTrades | tostring) + " (" + ((.profitableTrades / .totalTrades * 100) | floor | tostring) + "%)",
            "  Losing: " + (.losingTrades | tostring) + " (" + ((.losingTrades / .totalTrades * 100) | floor | tostring) + "%)",
            "  Breakeven: " + (.breakevenTrades | tostring) + " (" + ((.breakevenTrades / .totalTrades * 100) | floor | tostring) + "%)",
            "",
            "💵 FINANCIAL METRICS:",
            "  Gross Profit: " + (.totalGrossProfit | tostring) + " USDC",
            "  Gas Costs: " + (.totalGasCosts | tostring) + " USDC",
            "  Net Profit: " + (.totalNetProfit | tostring) + " USDC",
            "  Average per Trade: " + (.averageProfit | tostring) + " USDC",
            "  Average Gas Cost: " + (.averageGasCost | tostring) + " USDC",
            "",
            "⛽ GAS EFFICIENCY ANALYSIS:",
            "  Gas as % of Total Volume: " + ((.totalGasCosts / (.totalNetProfit + .totalGasCosts) * 100) | tostring) + "%",
            "  Gas Efficiency Trend: " + (.protocolAnalytics.gasEfficiencyTrend | tostring) + "% (positive = improving)",
            "  Avg Gas per Trade: " + (.protocolAnalytics.averageGasPerTrade | tostring) + " USDC",
            "",
            "📊 ENHANCED TOKEN BREAKDOWN WITH ADDRESSES:"
        '
        
        echo "$summary" | jq -r '
            .tokenPerformance | to_entries[] | 
            "  📈 " + .key + ":",
            "     Contract: " + (.value.tokenAddress // "Address not available"),
            "     Trades: " + (.value.trades | tostring),
            "     Net Profit: " + (.value.netProfit | tostring) + " USDC",
            "     Win Rate: " + (.value.winRate | tostring) + "%",
            "     Gas Usage: " + (.value.gasUsage | tostring) + " USDC",
            "     Avg Trade Size: " + (.value.averageTradeSize | tostring) + " USDC",
            "     Avg per Trade: " + ((.value.netProfit / .value.trades) | tostring) + " USDC",
            "     Gas Efficiency: " + ((.value.gasUsage / .value.netProfit * 100) | tostring) + "% of profit",
            ""
        '
    else
        print_error "Failed to fetch enhanced P&L data from server"
    fi
}

# Check server status
check_server() {
    print_header "Enhanced Server Status Check"
    
    print_status "Checking webhook server connectivity..."
    
    local health=$(curl -s "$WEBHOOK_URL/health" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$health" ]; then
        local status=$(echo "$health" | jq -r '.status')
        local version=$(echo "$health" | jq -r '.version')
        local mode=$(echo "$health" | jq -r '.testMode')
        
        if [ "$status" = "healthy" ]; then
            print_success "Server is healthy"
            print_info "Version: $version"
            print_info "Mode: $([ "$mode" = "true" ] && echo "TEST MODE" || echo "LIVE TRADING")"
            
            # Check enhanced trade tracking status
            local trackingEnabled=$(echo "$health" | jq -r '.tradeTracking.enabled')
            local activeTrades=$(echo "$health" | jq -r '.tradeTracking.activeTrades')
            local completedTrades=$(echo "$health" | jq -r '.tradeTracking.completedTrades')
            
            if [ "$trackingEnabled" = "true" ]; then
                print_success "Enhanced trade tracking is enabled"
                print_info "Active trades: $activeTrades"
                print_info "Completed trades: $completedTrades"
                print_info "Features: Address tracking, gas analysis, protocol analytics"
            else
                print_warning "Trade tracking is disabled"
                print_info "Enable with ENABLE_TRADE_TRACKING=true in .env"
            fi
            
            # Check for new features
            local features=$(echo "$health" | jq -r '.features[]?' 2>/dev/null)
            if [ -n "$features" ]; then
                print_info "Enhanced features detected:"
                echo "$health" | jq -r '.features[]?' | while read feature; do
                    print_info "  • $feature"
                done
            fi
        else
            print_error "Server status: $status"
        fi
    else
        print_error "Cannot connect to webhook server"
        print_info "Make sure the server is running and accessible at $WEBHOOK_URL"
        print_info "Check if ngrok tunnel is active: curl -s http://localhost:4040/api/tunnels"
    fi
}

# Show help
show_help() {
    print_header "Enhanced Trade Management Help"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Core Commands:"
    echo "  summary                 Show enhanced trade performance summary with address analytics"
    echo "  active                  Show active trades with blockchain address information"
    echo "  recent [count]          Show recent completed trades with address details (default: 10)"
    echo "  pnl                     Show detailed P&L analysis with gas efficiency metrics"
    echo ""
    echo "🔧 Enhanced Reporting Commands:"
    echo "  generate-reports        Generate complete CSV reports with address tracking"
    echo "  address-analysis        Show detailed blockchain address usage analytics"
    echo "  address-report          Generate address-specific CSV analysis report"
    echo "  daily-report           Generate daily performance report with address data"
    echo "  open-reports           Open reports directory to view enhanced CSV files"
    echo ""
    echo "System Commands:"
    echo "  check-server           Check webhook server status and enhanced features"
    echo "  monitor                Monitor trades in real-time with address info"
    echo "  help                   Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 summary              # Show overall performance with address analytics"
    echo "  $0 recent 20            # Show last 20 trades with blockchain addresses"
    echo "  $0 generate-reports     # Create enhanced CSV files with address tracking"
    echo "  $0 address-analysis     # Show detailed address usage patterns"
    echo "  $0 pnl                  # Enhanced P&L with gas efficiency analysis"
    echo ""
    echo "Enhanced Features:"
    echo "  🔗 Transaction hash tracking for all trades"
    echo "  🔗 Token contract address monitoring"
    echo "  🔗 Pool contract usage analytics"
    echo "  🔗 Router contract performance tracking"
    echo "  ⛽ Gas price analysis and efficiency trends"
    echo "  📊 Protocol analytics and usage patterns"
    echo ""
    echo "Configuration:"
    echo "  Webhook URL: $WEBHOOK_URL"
    echo "  Data Directory: $DATA_DIR"
    echo "  Reports Directory: $REPORTS_DIR"
    echo ""
    echo "Requirements:"
    echo "  - jq (JSON processor): sudo apt install jq"
    echo "  - curl (HTTP client): usually pre-installed"
    echo "  - Enhanced webhook server with address tracking enabled"
}

# Monitor live trades with address information
monitor_live() {
    print_header "Live Trade Monitoring with Address Tracking"
    print_info "Monitoring trades with enhanced address analytics. Press Ctrl+C to stop."
    echo ""
    
    while true; do
        local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
        echo -e "${CYAN}[$timestamp]${NC} Checking for new trades with address tracking..."
        
        # Get current summary with enhanced analytics
        local summary=$(curl -s "$WEBHOOK_URL/trades/summary" 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$summary" ]; then
            local totalTrades=$(echo "$summary" | jq -r '.totalTrades')
            local netProfit=$(echo "$summary" | jq -r '.totalNetProfit')
            local winRate=$(echo "$summary" | jq -r '.winRate')
            local uniqueTokens=$(echo "$summary" | jq -r '.protocolAnalytics.totalUniqueTokens')
            local gasEfficiency=$(echo "$summary" | jq -r '.protocolAnalytics.gasEfficiencyTrend')
            
            echo "  📊 Total: $totalTrades | 💰 Profit: ${netProfit} USDC | 📈 Win Rate: ${winRate}%"
            echo "  🔗 Unique Tokens: $uniqueTokens | ⛽ Gas Trend: ${gasEfficiency}%"
        fi
        
        # Get recent active trades with address info
        local active=$(curl -s "$WEBHOOK_URL/trades/active" 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$active" ]; then
            local activeCount=$(echo "$active" | jq -r '.count')
            if [ "$activeCount" -gt 0 ]; then
                echo "  🔄 Active trades: $activeCount (with address tracking)"
                # Show brief address info for active trades
                echo "$active" | jq -r '.activeTrades[0] | 
                    if . then 
                        "     Latest: " + .tokenPair + " via " + (.protocolAddresses.routerAddress[0:10] + "...")
                    else empty end' 2>/dev/null
            fi
        fi
        
        echo ""
        sleep 30
    done
}

# Main command dispatcher
main() {
    case "${1:-help}" in
        "summary")
            show_summary
            ;;
        "active")
            show_active
            ;;
        "recent")
            show_recent "${2:-10}"
            ;;
        "pnl")
            show_pnl_analysis
            ;;
        "generate-reports")
            generate_reports
            ;;
        "address-analysis")
            show_address_analysis
            ;;
        "address-report")
            generate_address_report
            ;;
        "daily-report")
            generate_daily_report
            ;;
        "open-reports")
            open_reports
            ;;
        "check-server")
            check_server
            ;;
        "monitor")
            monitor_live
            ;;
        "help"|"--help"|"-h")
            show_help
            ;;
        *)
            print_error "Unknown command: $1"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

# Check dependencies
check_dependencies() {
    if ! command -v jq >/dev/null 2>&1; then
        print_error "jq is required but not installed"
        print_info "Install with: sudo apt install jq (Ubuntu/Debian) or brew install jq (macOS)"
        exit 1
    fi
    
    if ! command -v curl >/dev/null 2>&1; then
        print_error "curl is required but not installed"
        exit 1
    fi
}

# Initialize
check_dependencies
ensure_directories

# Execute main function
main "$@"
