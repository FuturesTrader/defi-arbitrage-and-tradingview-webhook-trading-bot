// src/basicWebhookServer.ts - Updated with JSON Body Secret Support
/**
 * Basic Express server with support for webhook secrets in JSON body or headers
 */

import express from 'express';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

// Configuration
const CONFIG = {
    PORT: parseInt(process.env.WEBHOOK_PORT || '3001'),
    SECRET_KEY: process.env.WEBHOOK_SECRET_KEY || 'your-secret-key',
    TEST_MODE: process.env.TEST_MODE === 'true',
    TRADE_TIMEOUT: parseInt(process.env.TRADE_TIMEOUT || '120000'),
    // 🔧 NEW: Make secret optional and support both header and body
    REQUIRE_SECRET: process.env.REQUIRE_SECRET !== 'false', // Default: true (secure)
    ALLOW_HEADER_SECRET: process.env.ALLOW_HEADER_SECRET !== 'false', // Default: true
    ALLOW_BODY_SECRET: process.env.ALLOW_BODY_SECRET !== 'false', // Default: true
} as const;

// Types - Updated to include optional secret
interface WebhookPayload {
    side: 'buy' | 'sell' | 'sellsl' | 'selltp';
    product: string;
    network: string;
    exchange: string;
    secret?: string; // 🔧 NEW: Optional secret in body
}

// Initialize Express app
const app = express();

// Create logs directory
const logsDir = path.join(process.cwd(), 'logs', 'webhooks');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log('Created webhook logs directory:', logsDir);
}

// Simple logging
const log = (level: string, message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    if (data) {
        console.log(JSON.stringify(data, null, 2));
    }
};

console.log('🔧 Setting up basic Express server with enhanced secret support...');

// Basic middleware only
app.use(express.json({ limit: '10mb' }));
console.log('✅ JSON parsing middleware loaded');

// Simple request logging
app.use((req: any, res: any, next: any) => {
    log('debug', `${req.method} ${req.url}`, { ip: req.ip });
    next();
});
console.log('✅ Request logging middleware loaded');

// 🔧 UPDATED: Enhanced validation function
const validateWebhookData = (data: any) => {
    const errors: string[] = [];

    if (!data || typeof data !== 'object') {
        errors.push('Invalid or missing request body');
        return { errors, isValid: false };
    }

    const requiredFields = ['side', 'product', 'network', 'exchange'];
    for (const field of requiredFields) {
        if (!data[field] || typeof data[field] !== 'string') {
            errors.push(`Missing or invalid required field: ${field}`);
        }
    }

    // Updated to handle buy, sell, sellsl, selltp
    const validSides = ['buy', 'sell', 'sellsl', 'selltp'];
    if (data.side && !validSides.includes(data.side.toLowerCase())) {
        errors.push(`Invalid side value: ${data.side}. Must be one of: ${validSides.join(', ')}`);
    }

    return { errors, isValid: errors.length === 0 };
};

// 🔧 NEW: Enhanced security validation with multiple secret sources
const validateSecurity = (req: any, webhookId: string): { isValid: boolean; source: string; message: string } => {
    if (!CONFIG.REQUIRE_SECRET) {
        return {
            isValid: true,
            source: 'none',
            message: 'Security disabled (REQUIRE_SECRET=false)'
        };
    }

    const headerSecret = req.get('X-Webhook-Secret');
    const bodySecret = req.body?.secret;

    // Check header secret (if enabled and present)
    if (CONFIG.ALLOW_HEADER_SECRET && headerSecret) {
        if (headerSecret === CONFIG.SECRET_KEY) {
            return {
                isValid: true,
                source: 'header',
                message: 'Valid secret provided in X-Webhook-Secret header'
            };
        } else {
            return {
                isValid: false,
                source: 'header',
                message: 'Invalid secret in X-Webhook-Secret header'
            };
        }
    }

    // Check body secret (if enabled and present)
    if (CONFIG.ALLOW_BODY_SECRET && bodySecret) {
        if (bodySecret === CONFIG.SECRET_KEY) {
            return {
                isValid: true,
                source: 'body',
                message: 'Valid secret provided in JSON body'
            };
        } else {
            return {
                isValid: false,
                source: 'body',
                message: 'Invalid secret in JSON body'
            };
        }
    }

    // No valid secret found
    const availableMethods: string[] = [];
    if (CONFIG.ALLOW_HEADER_SECRET) availableMethods.push('X-Webhook-Secret header');
    if (CONFIG.ALLOW_BODY_SECRET) availableMethods.push('secret field in JSON body');

    return {
        isValid: false,
        source: 'none',
        message: `No valid secret provided. Available methods: ${availableMethods.join(', ')}`
    };
};

const mapToTradeDirection = (side: string, product: string): string | null => {
    const normalizedProduct = product.toUpperCase();
    const normalizedSide = side.toLowerCase();

    // Determine if this is a buy or sell operation
    const isBuyOperation = normalizedSide === 'buy';
    const isSellOperation = ['sell', 'sellsl', 'selltp'].includes(normalizedSide);

    if (normalizedProduct.includes('BTC')) {
        return isBuyOperation ? 'USDC_TO_WBTC' :
            isSellOperation ? 'WBTC_TO_USDC' : null;
    }

    if (normalizedProduct.includes('AVAX')) {
        return isBuyOperation ? 'USDC_TO_WAVAX' :
            isSellOperation ? 'WAVAX_TO_USDC' : null;
    }

    return null;
};

// Helper function to categorize signal type
const getSignalType = (side: string): string => {
    const normalizedSide = side.toLowerCase();

    switch (normalizedSide) {
        case 'buy':
            return 'Regular Buy';
        case 'sell':
            return 'Regular Sell';
        case 'sellsl':
            return 'Stop Loss';
        case 'selltp':
            return 'Take Profit';
        default:
            return 'Unknown';
    }
};

const executeTrade = async (tradeDirection: string): Promise<any> => {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        log('info', `🎯 Executing: tsx src/mainUniswap.ts ${tradeDirection} --percentage=100`, { tradeId });

        const child = spawn('tsx', ['src/mainUniswap.ts', tradeDirection, '--percentage=100'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: process.cwd()
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => stdout += data.toString());
        child.stderr?.on('data', (data) => stderr += data.toString());

        child.on('close', (code) => {
            const duration = Date.now() - startTime;

            if (code === 0) {
                log('info', '✅ Trade executed successfully', { tradeId, duration });
                resolve({ success: true, output: stdout, duration, tradeId });
            } else {
                log('error', '❌ Trade execution failed', { tradeId, exitCode: code, stderr });
                resolve({ success: false, error: `Trade failed: ${stderr}`, duration, tradeId });
            }
        });

        child.on('error', (error) => {
            resolve({ success: false, error: error.message, tradeId });
        });

        setTimeout(() => {
            if (!child.killed) {
                child.kill();
                resolve({ success: false, error: 'Timeout', tradeId });
            }
        }, CONFIG.TRADE_TIMEOUT);
    });
};

console.log('🔧 Defining routes...');

// Route 1: Health check
app.get('/health', (req: any, res: any) => {
    log('debug', 'Health check requested');
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: CONFIG.PORT,
        testMode: CONFIG.TEST_MODE,
        version: '3.1.0-enhanced-secret',
        server: 'Basic Express (Enhanced Secret Support)',
        security: {
            requireSecret: CONFIG.REQUIRE_SECRET,
            allowHeaderSecret: CONFIG.ALLOW_HEADER_SECRET,
            allowBodySecret: CONFIG.ALLOW_BODY_SECRET,
            secretConfigured: CONFIG.SECRET_KEY !== 'your-secret-key'
        }
    });
});
console.log('✅ Health route defined');

// Route 2: Status check - Updated with security info
app.get('/status', (req: any, res: any) => {
    log('debug', 'Status check requested');
    res.json({
        server: 'Basic Express Webhook Server (Enhanced)',
        status: 'running',
        mode: CONFIG.TEST_MODE ? 'TEST MODE' : 'LIVE TRADING',
        port: CONFIG.PORT,
        timestamp: new Date().toISOString(),
        routes: ['/health', '/status', '/config', '/logs', '/webhook/tradingview'],
        supportedSignals: {
            buy: 'Regular Buy (USDC → Token)',
            sell: 'Regular Sell (Token → USDC)',
            sellsl: 'Stop Loss (Token → USDC)',
            selltp: 'Take Profit (Token → USDC)'
        },
        supportedPairs: ['BTC/USDC', 'AVAX/USDC'],
        tradeDirections: {
            'buy + BTC/USDC': 'USDC_TO_WBTC',
            'sell/sellsl/selltp + BTC/USDC': 'WBTC_TO_USDC',
            'buy + AVAX/USDC': 'USDC_TO_WAVAX',
            'sell/sellsl/selltp + AVAX/USDC': 'WAVAX_TO_USDC'
        },
        security: {
            requireSecret: CONFIG.REQUIRE_SECRET,
            allowHeaderSecret: CONFIG.ALLOW_HEADER_SECRET,
            allowBodySecret: CONFIG.ALLOW_BODY_SECRET,
            secretConfigured: CONFIG.SECRET_KEY !== 'your-secret-key',
            supportedSecretMethods: [
                ...(CONFIG.ALLOW_HEADER_SECRET ? ['X-Webhook-Secret header'] : []),
                ...(CONFIG.ALLOW_BODY_SECRET ? ['secret field in JSON body'] : [])
            ]
        }
    });
});
console.log('✅ Status route defined');

// Route 3: Config check - Updated
app.get('/config', (req: any, res: any) => {
    res.json({
        testMode: CONFIG.TEST_MODE,
        port: CONFIG.PORT,
        tradeTimeoutMs: CONFIG.TRADE_TIMEOUT,
        security: {
            requireSecret: CONFIG.REQUIRE_SECRET,
            allowHeaderSecret: CONFIG.ALLOW_HEADER_SECRET,
            allowBodySecret: CONFIG.ALLOW_BODY_SECRET,
            secretConfigured: CONFIG.SECRET_KEY !== 'your-secret-key'
        }
    });
});
console.log('✅ Config route defined');

// Route 4: Main webhook (updated with enhanced security)
app.post('/webhook/tradingview', (req: any, res: any) => {
    const webhookId = `webhook_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // Handle webhook synchronously to avoid async issues
    handleWebhook(req, res, webhookId);
});
console.log('✅ Webhook route defined');

// 🔧 UPDATED: Enhanced webhook handler with flexible security
function handleWebhook(req: any, res: any, webhookId: string) {
    log('info', `📡 Incoming webhook (${webhookId})`, {
        body: {
            ...req.body,
            // 🔧 Mask secret in logs for security
            ...(req.body?.secret && { secret: '[PRESENT]' })
        },
        headers: {
            'content-type': req.get('Content-Type'),
            'x-webhook-secret': req.get('X-Webhook-Secret') ? '[PRESENT]' : '[MISSING]',
            'user-agent': req.get('User-Agent')
        }
    });

    // 🔧 Enhanced security check
    const securityCheck = validateSecurity(req, webhookId);

    if (!securityCheck.isValid) {
        log('warn', `❌ Webhook rejected - ${securityCheck.message} (${webhookId})`);
        res.status(401).json({
            error: 'Unauthorized',
            message: securityCheck.message,
            webhookId
        });
        return;
    }

    log('info', `✅ Webhook security check passed - ${securityCheck.message} (${webhookId})`);

    // Validation
    const validation = validateWebhookData(req.body);
    if (!validation.isValid) {
        log('warn', `❌ Webhook validation failed (${webhookId})`, { errors: validation.errors });
        res.status(400).json({ error: 'Invalid webhook data', details: validation.errors, webhookId });
        return;
    }

    // Process data
    const webhookData: WebhookPayload = req.body;
    const { side, product } = webhookData;
    const tradeDirection = mapToTradeDirection(side, product);
    const signalType = getSignalType(side);

    if (!tradeDirection) {
        log('warn', `❌ Unsupported trading pair (${webhookId})`, { product, side, signalType });
        res.status(400).json({ error: 'Unsupported trading pair', product, side, signalType, webhookId });
        return;
    }

    log('info', `🎯 Webhook processed (${webhookId})`, {
        tradeDirection,
        signalType,
        originalSide: side,
        testMode: CONFIG.TEST_MODE,
        securitySource: securityCheck.source
    });

    if (CONFIG.TEST_MODE) {
        const response = {
            mode: 'TEST_MODE',
            status: 'webhook_received_and_validated',
            webhookId,
            timestamp: new Date().toISOString(),
            receivedData: {
                ...webhookData,
                // 🔧 Mask secret in response for security
                ...(webhookData.secret && { secret: '[RECEIVED]' })
            },
            signalType: signalType,
            wouldExecute: tradeDirection,
            message: 'TEST MODE: Set TEST_MODE=false to enable live trading.',
            security: {
                source: securityCheck.source,
                requireSecret: CONFIG.REQUIRE_SECRET
            }
        };

        log('info', `🧪 TEST MODE: Would execute ${tradeDirection} (${signalType}) (${webhookId})`);
        res.json(response);
    } else {
        log('info', `🚀 LIVE MODE: Executing ${tradeDirection} (${signalType}) (${webhookId})`);

        // Execute trade asynchronously but respond immediately
        executeTrade(tradeDirection).then((executionResult) => {
            const response = {
                mode: 'LIVE_TRADING',
                status: executionResult.success ? 'trade_executed' : 'trade_failed',
                webhookId,
                timestamp: new Date().toISOString(),
                tradeDirection,
                signalType: signalType,
                originalSide: side,
                executionResult,
                security: {
                    source: securityCheck.source
                }
            };

            res.status(executionResult.success ? 200 : 500).json(response);
        }).catch((error) => {
            log('error', `💥 Trade execution error (${webhookId})`, { error: error.message, signalType });
            res.status(500).json({
                mode: 'LIVE_TRADING',
                status: 'trade_failed',
                webhookId,
                signalType: signalType,
                error: error.message,
                timestamp: new Date().toISOString(),
                security: {
                    source: securityCheck.source
                }
            });
        });
    }
}

// Route 5: Logs (simple version)
app.get('/logs', (req: any, res: any) => {
    try {
        const lines = parseInt(req.query.lines as string) || 50;
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `webhooks-${today}.log`);

        if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8');
            const recentLogs = logs.split('\n').slice(-lines).filter(line => line.trim()).join('\n');
            res.set('Content-Type', 'text/plain');
            res.send(recentLogs || 'No logs found');
        } else {
            res.json({ message: 'No logs found for today', date: today });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to read logs' });
    }
});
console.log('✅ Logs route defined');

// Specific 404 handlers for common routes (avoid wildcard)
app.get('/', (req: any, res: any) => {
    res.json({
        message: 'TradingView Webhook Server (Enhanced Secret Support)',
        endpoints: ['/health', '/status', '/config', '/logs'],
        webhook: '/webhook/tradingview',
        security: {
            requireSecret: CONFIG.REQUIRE_SECRET,
            allowHeaderSecret: CONFIG.ALLOW_HEADER_SECRET,
            allowBodySecret: CONFIG.ALLOW_BODY_SECRET,
            supportedMethods: [
                ...(CONFIG.ALLOW_HEADER_SECRET ? ['X-Webhook-Secret header'] : []),
                ...(CONFIG.ALLOW_BODY_SECRET ? ['secret field in JSON body'] : [])
            ]
        }
    });
});

app.get('/favicon.ico', (req: any, res: any) => {
    res.status(204).send();
});

// Generic 404 handler (last resort, avoid wildcard patterns)
app.use((req: any, res: any) => {
    log('warn', `❌ 404 - Route not found: ${req.method} ${req.url}`);
    res.status(404).json({
        error: 'Endpoint not found',
        requested: `${req.method} ${req.url}`,
        available: ['/health', '/status', '/config', '/logs', '/webhook/tradingview']
    });
});
console.log('✅ 404 handler defined');

console.log('🔧 All routes defined successfully!');

// Start server
const server = app.listen(CONFIG.PORT, () => {
    console.log('🚀 ================================');
    console.log('🚀 ENHANCED WEBHOOK SERVER v3.1');
    console.log('🚀 ================================');
    console.log(`🚀 Port: ${CONFIG.PORT}`);
    console.log(`🚀 Mode: ${CONFIG.TEST_MODE ? '🧪 TEST MODE (Safe)' : '⚡ LIVE TRADING'}`);
    console.log(`🚀 Security: ${CONFIG.REQUIRE_SECRET ? '🔒 Enabled' : '⚠️  Disabled'}`);
    console.log(`🚀 Secret Sources: ${[
        ...(CONFIG.ALLOW_HEADER_SECRET ? ['Header'] : []),
        ...(CONFIG.ALLOW_BODY_SECRET ? ['JSON Body'] : [])
    ].join(', ') || 'None'}`);
    console.log(`🚀 Webhook URL: http://localhost:${CONFIG.PORT}/webhook/tradingview`);
    console.log('🚀 ================================');

    log('info', 'Enhanced webhook server started', {
        port: CONFIG.PORT,
        testMode: CONFIG.TEST_MODE,
        security: {
            requireSecret: CONFIG.REQUIRE_SECRET,
            allowHeaderSecret: CONFIG.ALLOW_HEADER_SECRET,
            allowBodySecret: CONFIG.ALLOW_BODY_SECRET
        }
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down gracefully');
    server.close(() => {
        log('info', 'Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    log('info', 'SIGINT received, shutting down gracefully');
    server.close(() => {
        log('info', 'Server closed');
        process.exit(0);
    });
});
