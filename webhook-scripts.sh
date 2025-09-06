#!/bin/bash
# webhook-scripts.sh
# Management scripts for TradingView Webhook Server

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ✅ $1"
}

print_warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ⚠️  $1"
}

print_error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ❌ $1"
}

# Check if .env file exists
check_env() {
    if [ ! -f .env ]; then
        print_error ".env file not found! Please create it from the template."
        echo "Copy the .env template and update the values:"
        echo "cp .env.template .env"
        exit 1
    fi
    print_success ".env file found"
}

# Build the project
build_project() {
    print_status "Building TypeScript project..."
    if yarn build; then
        print_success "Project built successfully"
    else
        print_error "Build failed"
        exit 1
    fi
}

# Start webhook server in test mode
start_test_mode() {
    print_status "Starting webhook server in TEST MODE..."
    check_env
    build_project
    
    # Ensure TEST_MODE=true in .env
    if grep -q "TEST_MODE=false" .env; then
        print_warning "Switching to TEST_MODE=true for safety"
        sed -i 's/TEST_MODE=false/TEST_MODE=true/' .env
    fi
    
    print_success "Webhook server starting in TEST MODE (Safe)"
    node dist/webhookServer.js
}

# Start webhook server in live mode
start_live_mode() {
    print_warning "⚠️  STARTING WEBHOOK SERVER IN LIVE TRADING MODE ⚠️"
    echo "This will execute REAL trades when webhooks are received!"
    echo ""
    read -p "Are you sure you want to enable live trading? (type 'YES' to confirm): " confirm
    
    if [ "$confirm" != "YES" ]; then
        print_status "Live mode cancelled. Use 'yarn webhook:test' for safe testing."
        exit 0
    fi
    
    check_env
    build_project
    
    # Set TEST_MODE=false in .env
    sed -i 's/TEST_MODE=true/TEST_MODE=false/' .env
    
    print_warning "🚀 LIVE TRADING MODE ENABLED"
    node dist/webhookServer.js
}

# Switch to test mode
switch_to_test() {
    print_status "Switching to TEST MODE..."
    sed -i 's/TEST_MODE=false/TEST_MODE=true/' .env
    print_success "Switched to TEST MODE. Restart the server to apply changes."
}

# Check webhook server status
check_status() {
    print_status "Checking webhook server status..."
    
    # Check if server is running
    if curl -s http://localhost:3001/health > /dev/null; then
        print_success "Webhook server is running"
        echo ""
        curl -s http://localhost:3001/status | jq '.'
    else
        print_error "Webhook server is not running"
        echo "Start it with: yarn webhook:test"
    fi
}

# Test webhook with sample data
test_webhook() {
    print_status "Testing webhook with sample data..."
    
    # Sample webhook data
    local webhook_data='{
        "side": "buy",
        "product": "BTC/USDC",
        "network": "Avalanche",
        "exchange": "Uniswap"
    }'
    
    # Get secret from .env
    local secret=$(grep WEBHOOK_SECRET_KEY .env | cut -d '=' -f2)
    
    if [ "$secret" = "your_secure_secret_key_here_change_this" ]; then
        print_error "Please update WEBHOOK_SECRET_KEY in .env file before testing"
        exit 1
    fi
    
    print_status "Sending test webhook..."
    echo "Data: $webhook_data"
    echo ""
    
    curl -X POST http://localhost:3001/webhook/tradingview \
        -H "Content-Type: application/json" \
        -H "X-Webhook-Secret: $secret" \
        -d "$webhook_data" \
        -w "\nStatus: %{http_code}\n" | jq '.'
}

# View recent logs
view_logs() {
    local lines=${1:-50}
    print_status "Viewing last $lines lines of webhook logs..."
    
    if curl -s "http://localhost:3001/logs?lines=$lines"; then
        echo ""
    else
        print_error "Could not retrieve logs. Is the server running?"
    fi
}

# Monitor logs in real-time
monitor_logs() {
    print_status "Monitoring webhook logs in real-time..."
    print_status "Press Ctrl+C to stop monitoring"
    
    local log_dir="logs/webhooks"
    local today=$(date +%Y-%m-%d)
    local log_file="$log_dir/webhooks-$today.log"
    
    if [ -f "$log_file" ]; then
        tail -f "$log_file" | while read line; do
            echo "$line" | jq -r '. | "\(.timestamp) [\(.level | ascii_upcase)] \(.message)"' 2>/dev/null || echo "$line"
        done
    else
        print_warning "Log file not found: $log_file"
        print_status "Make sure the webhook server is running and has received requests"
    fi
}

# Setup ngrok tunnel (if ngrok is installed)
setup_ngrok() {
    if ! command -v ngrok &> /dev/null; then
        print_error "ngrok is not installed. Please install it from https://ngrok.com/"
        exit 1
    fi
    
    print_status "Setting up ngrok tunnel on port 3001..."
    print_status "This will create a public URL for your webhook server"
    
    # Start ngrok in background
    ngrok http 3001 --log=stdout > ngrok.log 2>&1 &
    local ngrok_pid=$!
    
    # Wait for ngrok to start
    sleep 3
    
    # Get the public URL
    local public_url=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url')
    
    if [ "$public_url" != "null" ] && [ -n "$public_url" ]; then
        print_success "ngrok tunnel created!"
        echo ""
        echo "🌐 Public Webhook URL: $public_url/webhook/tradingview"
        echo "📊 ngrok Web Interface: http://localhost:4040"
        echo ""
        print_status "Use this URL in TradingView webhook configuration:"
        print_status "$public_url/webhook/tradingview"
        echo ""
        print_warning "ngrok is running in background (PID: $ngrok_pid)"
        print_warning "Kill it with: kill $ngrok_pid"
    else
        print_error "Failed to create ngrok tunnel"
        kill $ngrok_pid 2>/dev/null
        exit 1
    fi
}

# Main script logic
case "${1:-help}" in
    "test")
        start_test_mode
        ;;
    "live")
        start_live_mode
        ;;
    "switch-test")
        switch_to_test
        ;;
    "status")
        check_status
        ;;
    "test-webhook")
        test_webhook
        ;;
    "logs")
        view_logs "${2:-50}"
        ;;
    "monitor")
        monitor_logs
        ;;
    "ngrok")
        setup_ngrok
        ;;
    "help"|*)
        echo ""
        echo "🚀 TradingView Webhook Server Management"
        echo "========================================"
        echo ""
        echo "Usage: $0 <command> [options]"
        echo ""
        echo "Commands:"
        echo "  test             Start webhook server in TEST MODE (safe)"
        echo "  live             Start webhook server in LIVE TRADING MODE (⚠️  real trades)"
        echo "  switch-test      Switch to TEST MODE (requires restart)"
        echo "  status           Check webhook server status"
        echo "  test-webhook     Send a test webhook to the server"
        echo "  logs [lines]     View recent webhook logs (default: 50 lines)"
        echo "  monitor          Monitor webhook logs in real-time"
        echo "  ngrok            Setup ngrok tunnel for external access"
        echo "  help             Show this help message"
        echo ""
        echo "Examples:"
        echo "  $0 test                    # Start in test mode"
        echo "  $0 status                  # Check server status"
        echo "  $0 test-webhook           # Send test webhook"
        echo "  $0 logs 100               # View last 100 log lines"
        echo "  $0 monitor                # Monitor logs in real-time"
        echo ""
        ;;
esac
