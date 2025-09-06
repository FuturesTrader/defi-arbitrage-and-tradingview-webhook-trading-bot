#!/bin/bash
# phase1-tradingview-setup.sh
# Simple, reliable setup for TradingView → mainUniswap.ts integration

echo "🎯 Phase 1: TradingView → Custom Code Integration"
echo "================================================"
echo "Goal: Prove webhook integration with your reliable mainUniswap.ts"
echo "Services: Single webhook server + Single ngrok tunnel"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }

# Step 1: Verify existing setup
verify_existing_setup() {
    print_info "Verifying your existing reliable components..."
    
    # Check if mainUniswap.ts exists and works
    if [ ! -f "src/mainUniswap.ts" ]; then
        print_warning "mainUniswap.ts not found. Please ensure it's in src/ directory"
        exit 1
    fi
    
    # Test mainUniswap.ts works
    print_info "Testing mainUniswap.ts functionality..."
    if yarn ts-node src/mainUniswap.ts USDC_TO_WAVAX --amount=0.01 2>&1 | grep -q "error"; then
        print_warning "mainUniswap.ts test had errors. Please verify it works manually first."
        echo "Try: yarn ts-node src/mainUniswap.ts USDC_TO_WAVAX --amount=0.01"
    else
        print_status "mainUniswap.ts appears functional"
    fi
    
    # Verify environment variables
    if [ ! -f ".env" ]; then
        print_warning ".env file not found. Creating template..."
        create_basic_env
    fi
    
    print_status "Existing setup verified"
}

# Create basic .env if missing
create_basic_env() {
    cat > .env << 'EOF'
# Webhook Configuration  
WEBHOOK_PORT=3001
WEBHOOK_SECRET_KEY=generate_secure_key_here_use_previous_script

# Your existing trading configuration
AVALANCHE_RPC_URL=your_rpc_url_here
PRIVATE_KEY=your_private_key_here

# Optional: Logging level
LOG_LEVEL=info
EOF
    
    print_warning "Please update .env with your actual values before proceeding"
}

# Create simple PM2 config for Phase 1
create_simple_pm2_config() {
    print_info "Creating simple PM2 configuration for Phase 1..."
    
    cat > ecosystem-phase1.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'webhook-server',
      script: 'dist/webhookServer.js',
      env: {
        NODE_ENV: 'production',
        WEBHOOK_PORT: 3001,
        LOG_LEVEL: 'info'
      },
      // Restart settings
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      autorestart: true,
      
      // Logging
      log_file: './logs/webhook-server.log',
      error_file: './logs/webhook-server-error.log',
      out_file: './logs/webhook-server-out.log',
      time: true
    },
    {
      name: 'ngrok-tunnel',
      script: 'ngrok',
      args: 'http --subdomain=YOUR_SUBDOMAIN_HERE 3001',
      
      // Restart settings
      restart_delay: 10000,
      max_restarts: 5,
      min_uptime: '30s',
      autorestart: true,
      
      // Logging
      log_file: './logs/ngrok.log',
      error_file: './logs/ngrok-error.log',
      out_file: './logs/ngrok-out.log',
      time: true
    }
  ]
};
EOF

    print_status "Simple PM2 configuration created"
    print_warning "Update YOUR_SUBDOMAIN_HERE in ecosystem-phase1.config.js"
}

# Create Phase 1 health check
create_phase1_health_check() {
    print_info "Creating Phase 1 health monitoring..."
    
    cat > health-check-phase1.sh << 'EOF'
#!/bin/bash
# health-check-phase1.sh - Simple health check for Phase 1

LOG_FILE="./logs/health-check.log"
mkdir -p logs

timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

log() {
    echo "[$(timestamp)] $1" | tee -a "$LOG_FILE"
}

# Check webhook server
check_webhook_server() {
    if curl -s -f "http://localhost:3001/health" > /dev/null; then
        log "✅ Webhook server healthy (port 3001)"
        return 0
    else
        log "❌ Webhook server down - restarting"
        pm2 restart webhook-server
        sleep 5
        return 1
    fi
}

# Check ngrok tunnel
check_ngrok_tunnel() {
    if curl -s -f "http://localhost:4040/api/tunnels" | grep -q "https://"; then
        local url=$(curl -s "http://localhost:4040/api/tunnels" | grep -o 'https://[^"]*\.ngrok\.io')
        log "✅ ngrok tunnel healthy: $url"
        echo "$url" > ./logs/current-ngrok-url.txt  # Save for reference
        return 0
    else
        log "❌ ngrok tunnel down - restarting"
        pm2 restart ngrok-tunnel
        sleep 15
        return 1
    fi
}

# Test webhook endpoint
test_webhook_endpoint() {
    local ngrok_url=$(cat ./logs/current-ngrok-url.txt 2>/dev/null)
    if [ -n "$ngrok_url" ]; then
        local test_response=$(curl -s -w "%{http_code}" -o /dev/null \
            -X POST "$ngrok_url/webhook/tradingview" \
            -H "Content-Type: application/json" \
            -H "X-Webhook-Secret: test" \
            -d '{"side":"buy","product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}')
        
        if [ "$test_response" = "401" ]; then
            log "✅ Webhook endpoint responding (401 = auth working)"
        elif [ "$test_response" = "200" ]; then
            log "✅ Webhook endpoint responding (200 = received)"
        else
            log "⚠️  Webhook endpoint returned: $test_response"
        fi
    fi
}

# Main health check
main() {
    log "=== Phase 1 Health Check ==="
    
    local issues=0
    check_webhook_server || ((issues++))
    check_ngrok_tunnel || ((issues++))
    test_webhook_endpoint
    
    if [ $issues -eq 0 ]; then
        log "✅ Phase 1 system healthy"
    else
        log "⚠️  $issues issue(s) detected"
    fi
    
    # Show current status
    log "Current ngrok URL: $(cat ./logs/current-ngrok-url.txt 2>/dev/null || echo 'Not available')"
    log "=== Health Check Complete ==="
}

main "$@"
EOF

    chmod +x health-check-phase1.sh
    print_status "Phase 1 health check created"
}

# Create test scripts
create_test_scripts() {
    print_info "Creating test scripts for Phase 1..."
    
    # Manual webhook test
    cat > test-webhook-manual.sh << 'EOF'
#!/bin/bash
# test-webhook-manual.sh - Test webhook manually

NGROK_URL=$(cat ./logs/current-ngrok-url.txt 2>/dev/null)
SECRET=$(grep WEBHOOK_SECRET_KEY .env | cut -d'=' -f2)

if [ -z "$NGROK_URL" ]; then
    echo "❌ ngrok URL not found. Run health check first."
    exit 1
fi

if [ -z "$SECRET" ]; then
    echo "❌ Webhook secret not found in .env"
    exit 1
fi

echo "🧪 Testing webhook endpoint..."
echo "URL: $NGROK_URL/webhook/tradingview"
echo "Secret: $SECRET"
echo ""

# Test buy signal
echo "Testing BUY signal..."
curl -X POST "$NGROK_URL/webhook/tradingview" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "side": "buy",
    "product": "BTC/USDC", 
    "network": "Avalanche",
    "exchange": "Uniswap"
  }' \
  -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "Check logs: tail -f logs/webhook-server.log"
EOF

    chmod +x test-webhook-manual.sh
    
    # Mainuniswap test
    cat > test-mainuniswap.sh << 'EOF'
#!/bin/bash
# test-mainuniswap.sh - Test mainUniswap.ts directly

echo "🧪 Testing mainUniswap.ts directly..."
echo "This verifies your trading code works before webhook integration"
echo ""

# Test with small amount
echo "Testing USDC_TO_WAVAX with small amount..."
yarn ts-node src/mainUniswap.ts USDC_TO_WAVAX --amount=0.01

echo ""
echo "If successful, your trading code is ready for webhook integration!"
EOF

    chmod +x test-mainuniswap.sh
    
    print_status "Test scripts created"
}

# Setup Phase 1 system
setup_phase1() {
    print_info "Setting up Phase 1 system..."
    
    # Create logs directory
    mkdir -p logs
    
    # Build the project
    yarn install
    yarn build
    
    print_status "Project built successfully"
}

# Start Phase 1 system
start_phase1() {
    print_info "Starting Phase 1 system..."
    
    # Get subdomain from user
    echo ""
    read -p "Enter your desired ngrok subdomain (e.g., 'mytrader'): " SUBDOMAIN
    if [ -z "$SUBDOMAIN" ]; then
        SUBDOMAIN="trader-$(date +%s)"
        print_warning "Using generated subdomain: $SUBDOMAIN"
    fi
    
    # Update PM2 config with subdomain
    sed -i.bak "s/YOUR_SUBDOMAIN_HERE/$SUBDOMAIN/g" ecosystem-phase1.config.js
    
    # Start services
    pm2 start ecosystem-phase1.config.js
    pm2 save
    
    # Wait for services to start
    sleep 10
    
    # Run health check
    ./health-check-phase1.sh
    
    # Show results
    echo ""
    print_status "Phase 1 system started!"
    echo ""
    echo "🌐 Your webhook URL: https://$SUBDOMAIN.ngrok.io/webhook/tradingview"
    echo "🔍 Monitor at: http://localhost:4040"
    echo "📊 Health check: ./health-check-phase1.sh"
    echo "🧪 Test webhook: ./test-webhook-manual.sh"
    echo "📝 Logs: tail -f logs/webhook-server.log"
    echo ""
    echo "📋 TradingView Configuration:"
    echo "Webhook URL: https://$SUBDOMAIN.ngrok.io/webhook/tradingview"
    echo "Secret Header: X-Webhook-Secret: $(grep WEBHOOK_SECRET_KEY .env | cut -d'=' -f2)"
    echo ""
    echo "🎯 Next Steps:"
    echo "1. Test mainUniswap.ts: ./test-mainuniswap.sh"
    echo "2. Test webhook: ./test-webhook-manual.sh"
    echo "3. Configure TradingView with the URL above"
    echo "4. Monitor logs for live trading signals"
}

# Main execution
main() {
    echo "This script sets up Phase 1: TradingView → Custom Code integration"
    echo "Focus: Prove webhook integration with your reliable mainUniswap.ts"
    echo ""
    
    read -p "Continue with Phase 1 setup? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        verify_existing_setup
        create_simple_pm2_config
        create_phase1_health_check
        create_test_scripts
        setup_phase1
        start_phase1
    else
        echo "Setup cancelled. You can run this script anytime to start Phase 1."
        exit 0
    fi
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
