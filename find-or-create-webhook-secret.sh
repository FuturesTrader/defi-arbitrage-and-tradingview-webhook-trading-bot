#!/bin/bash
# find-or-create-webhook-secret.sh
# Find existing webhook secret or create a new one

echo "🔐 Webhook Secret Key Finder/Creator"
echo "====================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

# Check if .env exists and has webhook secret
check_existing_secret() {
    if [ -f ".env" ]; then
        print_status ".env file found"
        
        if grep -q "WEBHOOK_SECRET_KEY" .env; then
            local secret=$(grep WEBHOOK_SECRET_KEY .env | cut -d'=' -f2)
            if [ -n "$secret" ] && [ "$secret" != "generate_secure_key_here_use_previous_script" ] && [ "$secret" != "your-secret-key-here" ]; then
                print_status "Webhook secret key found!"
                echo ""
                echo "🔑 Your current webhook secret key:"
                echo "======================================"
                echo "$secret"
                echo "======================================"
                echo ""
                echo "Use this in TradingView webhook header:"
                echo "X-Webhook-Secret: $secret"
                echo ""
                return 0
            else
                print_warning "Webhook secret key needs to be set (placeholder value found)"
                return 1
            fi
        else
            print_warning "WEBHOOK_SECRET_KEY not found in .env"
            return 1
        fi
    else
        print_warning ".env file not found"
        return 1
    fi
}

# Generate new secret key
generate_new_secret() {
    print_info "Generating new secure webhook secret key..."
    
    # Try different methods to generate secure key
    if command -v openssl &> /dev/null; then
        SECRET_KEY=$(openssl rand -hex 32)
        print_status "Generated using OpenSSL"
    elif command -v node &> /dev/null; then
        SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        print_status "Generated using Node.js"
    else
        # Fallback method using /dev/urandom (Linux/Mac)
        if [ -f /dev/urandom ]; then
            SECRET_KEY=$(head -c 32 /dev/urandom | xxd -p -c 32)
            print_status "Generated using /dev/urandom"
        else
            print_error "No secure random generator found. Please install OpenSSL or Node.js"
            exit 1
        fi
    fi
    
    echo ""
    echo "🔑 Your new webhook secret key:"
    echo "======================================"
    echo "$SECRET_KEY"
    echo "======================================"
    echo ""
}

# Update or create .env file
update_env_file() {
    local secret=$1
    
    if [ -f ".env" ]; then
        # Update existing .env
        if grep -q "WEBHOOK_SECRET_KEY" .env; then
            # Replace existing key
            if [[ "$OSTYPE" == "darwin"* ]]; then
                # macOS
                sed -i '' "s/WEBHOOK_SECRET_KEY=.*/WEBHOOK_SECRET_KEY=$secret/" .env
            else
                # Linux
                sed -i "s/WEBHOOK_SECRET_KEY=.*/WEBHOOK_SECRET_KEY=$secret/" .env
            fi
            print_status "Updated WEBHOOK_SECRET_KEY in existing .env file"
        else
            # Add new key
            echo "WEBHOOK_SECRET_KEY=$secret" >> .env
            print_status "Added WEBHOOK_SECRET_KEY to existing .env file"
        fi
    else
        # Create new .env file
        cat > .env << EOF
# Webhook Configuration
WEBHOOK_PORT=3001
WEBHOOK_SECRET_KEY=$secret
ALLOWED_ORIGINS=https://www.tradingview.com,https://alerts.tradingview.com

# Your trading configuration (update these)
AVALANCHE_RPC_URL=your_rpc_url_here
PRIVATE_KEY=your_private_key_here

# Optional settings
LOG_LEVEL=info
NODE_ENV=production
EOF
        print_status "Created new .env file with webhook configuration"
        print_warning "Please update AVALANCHE_RPC_URL and PRIVATE_KEY in .env"
    fi
}

# Ensure .env is in .gitignore
update_gitignore() {
    if [ ! -f .gitignore ]; then
        echo ".env" > .gitignore
        print_status "Created .gitignore with .env"
    elif ! grep -q "^\.env$" .gitignore; then
        echo ".env" >> .gitignore
        print_status "Added .env to .gitignore"
    else
        print_status ".env already in .gitignore"
    fi
}

# Display usage instructions
show_usage_instructions() {
    local secret=$1
    
    echo ""
    echo "📋 How to Use Your Webhook Secret:"
    echo "=================================="
    echo ""
    echo "1. In TradingView Alert Setup:"
    echo "   - Webhook URL: https://your-subdomain.ngrok.io/webhook/tradingview"
    echo "   - Message: Your T3 strategy JSON (already configured)"
    echo "   - Additional Headers:"
    echo "     X-Webhook-Secret: $secret"
    echo ""
    echo "2. Test your webhook:"
    echo "   curl -X POST https://your-ngrok-url.ngrok.io/webhook/tradingview \\"
    echo "     -H 'Content-Type: application/json' \\"
    echo "     -H 'X-Webhook-Secret: $secret' \\"
    echo "     -d '{\"side\":\"buy\",\"product\":\"BTC/USDC\",\"network\":\"Avalanche\",\"exchange\":\"Uniswap\"}'"
    echo ""
    echo "3. Security Notes:"
    echo "   - Keep this secret private"
    echo "   - Never commit .env to git"
    echo "   - Regenerate if compromised"
    echo ""
}

# Main execution
main() {
    print_info "Checking for existing webhook secret key..."
    
    if check_existing_secret; then
        echo "✅ You already have a webhook secret key!"
        echo ""
        read -p "Do you want to generate a new one? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            generate_new_secret
            update_env_file "$SECRET_KEY"
            update_gitignore
            show_usage_instructions "$SECRET_KEY"
        else
            echo "Keeping existing secret key."
            local existing_secret=$(grep WEBHOOK_SECRET_KEY .env | cut -d'=' -f2)
            show_usage_instructions "$existing_secret"
        fi
    else
        print_info "Creating new webhook secret key..."
        generate_new_secret
        update_env_file "$SECRET_KEY"
        update_gitignore
        show_usage_instructions "$SECRET_KEY"
    fi
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
