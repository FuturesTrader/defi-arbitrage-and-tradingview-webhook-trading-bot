#!/bin/bash
# integration-test.sh
# Comprehensive integration test for TradingView webhook system

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test results
PASSED=0
FAILED=0
TOTAL=0

print_test() {
    TOTAL=$((TOTAL + 1))
    echo -e "${BLUE}[TEST $TOTAL]${NC} $1"
}

print_pass() {
    PASSED=$((PASSED + 1))
    echo -e "${GREEN}✅ PASS${NC} - $1"
}

print_fail() {
    FAILED=$((FAILED + 1))
    echo -e "${RED}❌ FAIL${NC} - $1"
}

print_skip() {
    echo -e "${YELLOW}⏭️  SKIP${NC} - $1"
}

print_info() {
    echo -e "${BLUE}ℹ️  INFO${NC} - $1"
}

# Get webhook secret from .env
get_webhook_secret() {
    if [ -f .env ]; then
        grep WEBHOOK_SECRET_KEY .env | cut -d '=' -f2
    else
        echo "your-secret-key"
    fi
}

# Wait for server to be ready
wait_for_server() {
    local retries=10
    local delay=2
    
    for i in $(seq 1 $retries); do
        if curl -s http://localhost:3001/health > /dev/null 2>&1; then
            return 0
        fi
        sleep $delay
    done
    return 1
}

# Test webhook with different payloads
test_webhook_payload() {
    local payload="$1"
    local description="$2"
    local expected_status="$3"
    
    print_test "Testing webhook: $description"
    
    local secret=$(get_webhook_secret)
    local response=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST http://localhost:3001/webhook/tradingview \
        -H "Content-Type: application/json" \
        -H "X-Webhook-Secret: $secret" \
        -d "$payload")
    
    local body=$(echo "$response" | sed -E 's/HTTPSTATUS:[0-9]{3}$//')
    local status=$(echo "$response" | grep -o '[0-9]*$')
    
    if [ "$status" = "$expected_status" ]; then
        print_pass "$description (Status: $status)"
        echo "   Response: $(echo "$body" | jq -c . 2>/dev/null || echo "$body")"
    else
        print_fail "$description (Expected: $expected_status, Got: $status)"
        echo "   Response: $(echo "$body" | jq -c . 2>/dev/null || echo "$body")"
    fi
}

# Main test suite
run_integration_tests() {
    echo ""
    echo "🧪 =================================="
    echo "🧪 WEBHOOK INTEGRATION TEST SUITE"
    echo "🧪 =================================="
    echo ""
    
    # Test 1: Environment Setup
    print_test "Checking environment setup"
    if [ -f .env ]; then
        print_pass "Environment file exists"
    else
        print_fail "Environment file missing"
        echo "   Please create .env file from template"
        return 1
    fi
    
    # Test 2: Dependencies
    print_test "Checking dependencies"
    if command -v node > /dev/null && command -v yarn > /dev/null; then
        print_pass "Node.js and Yarn available"
    else
        print_fail "Missing Node.js or Yarn"
        return 1
    fi
    
    # Test 3: Build project
    print_test "Building TypeScript project"
    if yarn build > /dev/null 2>&1; then
        print_pass "Project builds successfully"
    else
        print_fail "Project build failed"
        echo "   Run 'yarn build' to see detailed errors"
        return 1
    fi
    
    # Test 4: Check if server is already running
    print_test "Checking if webhook server is running"
    if curl -s http://localhost:3001/health > /dev/null 2>&1; then
        print_info "Server already running, using existing instance"
        SERVER_STARTED_BY_TEST=false
    else
        print_info "Starting webhook server for testing"
        # Start server in background
        yarn webhook:test > webhook-test.log 2>&1 &
        SERVER_PID=$!
        SERVER_STARTED_BY_TEST=true
        
        # Wait for server to start
        if wait_for_server; then
            print_pass "Webhook server started successfully"
        else
            print_fail "Webhook server failed to start"
            if [ -f webhook-test.log ]; then
                echo "   Server log:"
                tail -5 webhook-test.log | sed 's/^/   /'
            fi
            return 1
        fi
    fi
    
    # Test 5: Health check
    print_test "Testing health endpoint"
    local health_response=$(curl -s http://localhost:3001/health)
    if echo "$health_response" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
        print_pass "Health endpoint working"
    else
        print_fail "Health endpoint not responding correctly"
    fi
    
    # Test 6: Status endpoint
    print_test "Testing status endpoint"
    local status_response=$(curl -s http://localhost:3001/status)
    if echo "$status_response" | jq -e '.mode' > /dev/null 2>&1; then
        local mode=$(echo "$status_response" | jq -r '.mode')
        print_pass "Status endpoint working (Mode: $mode)"
    else
        print_fail "Status endpoint not responding correctly"
    fi
    
    # Test 7: Security - No secret header
    print_test "Testing security - missing secret header"
    local response=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST http://localhost:3001/webhook/tradingview \
        -H "Content-Type: application/json" \
        -d '{"side":"buy","product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}')
    
    local status=$(echo "$response" | grep -o '[0-9]*$')
    if [ "$status" = "401" ]; then
        print_pass "Security validation (missing header)"
    else
        print_fail "Security validation failed (expected 401, got $status)"
    fi
    
    # Test 8: Security - Wrong secret
    print_test "Testing security - wrong secret"
    local response=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST http://localhost:3001/webhook/tradingview \
        -H "Content-Type: application/json" \
        -H "X-Webhook-Secret: wrong-secret" \
        -d '{"side":"buy","product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}')
    
    local status=$(echo "$response" | grep -o '[0-9]*$')
    if [ "$status" = "401" ]; then
        print_pass "Security validation (wrong secret)"
    else
        print_fail "Security validation failed (expected 401, got $status)"
    fi
    
    # Test 9-12: Valid webhook payloads
    test_webhook_payload \
        '{"side":"buy","product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}' \
        "Valid BTC buy signal" \
        "200"
    
    test_webhook_payload \
        '{"side":"sell","product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}' \
        "Valid BTC sell signal" \
        "200"
    
    test_webhook_payload \
        '{"side":"buy","product":"AVAX/USDC","network":"Avalanche","exchange":"Uniswap"}' \
        "Valid AVAX buy signal" \
        "200"
    
    test_webhook_payload \
        '{"side":"sell","product":"AVAX/USDC","network":"Avalanche","exchange":"Uniswap"}' \
        "Valid AVAX sell signal" \
        "200"
    
    # Test 13-15: Invalid payloads
    test_webhook_payload \
        '{"side":"invalid","product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}' \
        "Invalid side value" \
        "400"
    
    test_webhook_payload \
        '{"product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}' \
        "Missing side field" \
        "400"
    
    test_webhook_payload \
        '{"side":"buy","product":"UNKNOWN/USDC","network":"Avalanche","exchange":"Uniswap"}' \
        "Unsupported trading pair" \
        "400"
    
    # Test 16: Coinrule format
    test_webhook_payload \
        '{"userId":"test123","hookId":"hook123","hookToken":"token123","side":"buy","product":"BTC/USDC"}' \
        "Coinrule webhook format" \
        "200"
    
    # Test 17: Check logs
    print_test "Testing logs endpoint"
    local logs_response=$(curl -s "http://localhost:3001/logs?lines=5")
    if [ -n "$logs_response" ]; then
        print_pass "Logs endpoint working"
    else
        print_fail "Logs endpoint not working"
    fi
    
    # Cleanup
    if [ "$SERVER_STARTED_BY_TEST" = true ] && [ -n "$SERVER_PID" ]; then
        print_info "Stopping test server (PID: $SERVER_PID)"
        kill $SERVER_PID 2>/dev/null || true
        rm -f webhook-test.log
    fi
    
    # Test Summary
    echo ""
    echo "🧪 =================================="
    echo "🧪 TEST SUMMARY"
    echo "🧪 =================================="
    echo -e "Total Tests: $TOTAL"
    echo -e "${GREEN}Passed: $PASSED${NC}"
    echo -e "${RED}Failed: $FAILED${NC}"
    echo ""
    
    if [ $FAILED -eq 0 ]; then
        echo -e "${GREEN}🎉 ALL TESTS PASSED!${NC}"
        echo "Your webhook integration is ready for testing with TradingView."
        echo ""
        echo "Next steps:"
        echo "1. Setup ngrok: yarn webhook:ngrok"
        echo "2. Configure TradingView webhook with your ngrok URL"
        echo "3. Test with real TradingView alerts"
        echo "4. When ready, switch to live mode: yarn webhook:live"
        return 0
    else
        echo -e "${RED}❌ SOME TESTS FAILED${NC}"
        echo "Please fix the issues before proceeding."
        return 1
    fi
}

# Handle script arguments
case "${1:-run}" in
    "run")
        run_integration_tests
        ;;
    "quick")
        echo "🚀 Quick integration test..."
        if curl -s http://localhost:3001/health > /dev/null; then
            echo "✅ Server is running"
            test_webhook_payload \
                '{"side":"buy","product":"BTC/USDC","network":"Avalanche","exchange":"Uniswap"}' \
                "Quick webhook test" \
                "200"
        else
            echo "❌ Server not running. Start with: yarn webhook:test"
        fi
        ;;
    "help")
        echo "Webhook Integration Test Suite"
        echo ""
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  run     Run full integration test suite (default)"
        echo "  quick   Quick test (server must be running)"
        echo "  help    Show this help"
        echo ""
        ;;
    *)
        echo "Unknown command: $1"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac
