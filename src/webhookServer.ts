// src/webhookServer.ts - Express 5.1.0 Compatible Version
/**
 * TradingView Webhook Server for Express 5.1.0
 * Progressive middleware loading to avoid path-to-regexp conflicts
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
    LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
    MAX_REQUESTS_PER_MINUTE: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '100'),
    TRADE_TIMEOUT: parseInt(process.env.TRADE_TIMEOUT || '120000'),
    ENABLE_CORS: process.env.ENABLE_CORS !== 'false',
    ENABLE_HELMET: process.env.ENABLE_HELMET !== 'false',
    ENABLE_RATE_LIMIT: process.env.ENABLE_RATE_LIMIT !== 'false',
} as const;

// Types
interface WebhookPayload {
    side: 'buy' | 'sell';
    product: string;
    network: string;
    exchange: string;
    userId?: string;
    hookId?: string;
    hookToken?: string;
}

interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

interface TradeExecutionResult {
    success: boolean;
    output?: string;
    error?: string;
    duration?: number;
    tradeId?: string;
}

interface WebhookResponse {
    mode: 'TEST_MODE' | 'LIVE_TRADING';
    status: string;
    webhookId: string;
    timestamp: string;
    receivedData?: WebhookPayload;
    wouldExecute?: string;
    tradeDirection?: string;
    executionResult?: TradeExecutionResult;
    message?: string;
    error?: string;
}

// Initialize Express app
const app = express();

// Create logs directory
const logsDir = path.join(process.cwd(), 'logs', 'webhooks');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log('Created webhook logs directory:', logsDir);
}

// Enhanced logging for webhooks
class WebhookLogger {
    private static logToFile(level: string, message: string, data?: any): void {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            ...(data && { data })
        };

        // Console logging with colors
        const colors = {
            error: '\x1b[31m',
            warn: '\x1b[33m',
            info: '\x1b[36m',
            debug: '\x1b[37m'
        };
        const reset = '\x1b[0m';
        const color = colors[level as keyof typeof colors] || colors.debug;

        console.log(`${color}[${timestamp}] [${level.toUpperCase()}]${reset} ${message}`);
        if (data) {
            console.log(`${color}${JSON.stringify(data, null, 2)}${reset}`);
        }

        // File logging
        const logFile = path.join(logsDir, `webhooks-${new Date().toISOString().split('T')[0]}.log`);
        const logLine = JSON.stringify(logEntry) + '\n';

        try {
            fs.appendFileSync(logFile, logLine);
        } catch (error) {
            console.error('Failed to write to webhook log file:', error);
        }
    }

    static info(message: string, data?: any): void {
        this.logToFile('info', message, data);
    }

    static warn(message: string, data?: any): void {
        this.logToFile('warn', message, data);
    }

    static error(message: string, data?: any): void {
        this.logToFile('error', message, data);
    }

    static debug(message: string, data?: any): void {
        this.logToFile('debug', message, data);
    }
}

// Progressive middleware setup - add one by one to identify issues
console.log('Setting up Express 5.1.0 webhook server...');

// Basic middleware that should always work
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
console.log('✅ Basic Express middleware loaded');

// Request logging middleware
app.use((req: any, res: any, next: any) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    req.requestId = requestId;

    WebhookLogger.debug('Incoming request', {
        requestId,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });

    next();
});
console.log('✅ Request logging middleware loaded');

// Conditional CORS (only if enabled)
if (CONFIG.ENABLE_CORS) {
    try {
        const cors = require('cors');
        app.use(cors({
            origin: true,
            credentials: true
        }));
        console.log('✅ CORS middleware loaded');
    } catch (error) {
        console.log('⚠️  CORS not available, skipping');
    }
}

// Conditional Helmet (only if enabled)
if (CONFIG.ENABLE_HELMET) {
    try {
        const helmet = require('helmet');
        app.use(helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false
        }));
        console.log('✅ Helmet middleware loaded');
    } catch (error) {
        console.log('⚠️  Helmet not available, skipping');
    }
}

// Conditional Rate Limiting (only if enabled)
if (CONFIG.ENABLE_RATE_LIMIT) {
    try {
        const rateLimit = require('express-rate-limit');
        const limiter = rateLimit({
            windowMs: 60 * 1000,
            limit: CONFIG.MAX_REQUESTS_PER_MINUTE, // Express 5.x uses 'limit' instead of 'max'
            message: {
                error: 'Too many webhook requests',
                retryAfter: '60 seconds'
            },
            standardHeaders: true,
            legacyHeaders: false,
            handler: (req: any, res: any) => {
                WebhookLogger.warn('Rate limit exceeded', {
                    ip: req.ip,
                    userAgent: req.get('User-Agent'),
                    url: req.originalUrl
                });
                res.status(429).json({
                    error: 'Too many requests',
                    message: 'Rate limit exceeded. Please wait before sending more requests.',
                    retryAfter: 60
                });
            }
        });

        app.use('/webhook', limiter);
        console.log('✅ Rate limiting middleware loaded');
    } catch (error) {
        console.log('⚠️  Rate limiting not available, skipping');
    }
}

console.log('All middleware loaded successfully!');

// Validation functions
const validateWebhookData = (data: any): ValidationResult => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!data || typeof data !== 'object') {
        errors.push('Invalid or missing request body');
        return { errors, warnings, isValid: false };
    }

    const requiredFields = ['side', 'product', 'network', 'exchange'];
    for (const field of requiredFields) {
        if (!data[field] || typeof data[field] !== 'string') {
            errors.push(`Missing or invalid required field: ${field}`);
        }
    }

    if (data.side && !['buy', 'sell'].includes(data.side.toLowerCase())) {
        errors.push(`Invalid side value: ${data.side}. Must be 'buy' or 'sell'`);
    }

    if (data.network && data.network.toLowerCase() !== 'avalanche') {
        warnings.push(`Network '${data.network}' detected - only Avalanche is fully supported`);
    }

    if (data.exchange && data.exchange.toLowerCase() !== 'uniswap') {
        warnings.push(`Exchange '${data.exchange}' detected - only Uniswap is fully supported`);
    }

    if (data.product && typeof data.product === 'string') {
        const validProducts = ['BTC/USDC', 'WBTC/USDC', 'AVAX/USDC', 'WAVAX/USDC'];
        const normalizedProduct = data.product.toUpperCase();

        const isValidProduct = validProducts.some(valid =>
            normalizedProduct.includes(valid.split('/')[0])
        );

        if (!isValidProduct) {
            warnings.push(`Product '${data.product}' may not be supported. Supported: BTC, WBTC, AVAX, WAVAX`);
        }
    }

    return {
        errors,
        warnings,
        isValid: errors.length === 0
    };
};

const mapToTradeDirection = (side: string, product: string): string | null => {
    const normalizedProduct = product.toUpperCase();
    const normalizedSide = side.toLowerCase();

    if (normalizedProduct.includes('BTC')) {
        return normalizedSide === 'buy' ? 'USDC_TO_WBTC' : 'WBTC_TO_USDC';
    }

    if (normalizedProduct.includes('AVAX')) {
        return normalizedSide === 'buy' ? 'USDC_TO_WAVAX' : 'WAVAX_TO_USDC';
    }

    return null;
};

// Trade execution function
const executeTrade = async (tradeDirection: string, webhookData: WebhookPayload): Promise<TradeExecutionResult> => {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        WebhookLogger.info('🎯 Executing trade command', {
            tradeId,
            command: `tsx src/mainUniswap.ts ${tradeDirection} --percentage=100`,
            tradeDirection,
            webhookData
        });

        const child = spawn('tsx', ['src/mainUniswap.ts', tradeDirection, '--percentage=100'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: process.cwd()
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            const duration = Date.now() - startTime;

            if (code === 0) {
                WebhookLogger.info('✅ Trade executed successfully', {
                    tradeId,
                    duration,
                    stdout: stdout.slice(-500),
                    stderr: stderr.slice(-200)
                });

                resolve({
                    success: true,
                    output: stdout,
                    duration,
                    tradeId
                });
            } else {
                WebhookLogger.error('❌ Trade execution failed', {
                    tradeId,
                    exitCode: code,
                    duration,
                    stdout: stdout.slice(-500),
                    stderr: stderr.slice(-500)
                });

                resolve({
                    success: false,
                    error: `Trade failed with exit code ${code}. ${stderr}`,
                    duration,
                    tradeId
                });
            }
        });

        child.on('error', (error) => {
            const duration = Date.now() - startTime;
            WebhookLogger.error('💥 Trade execution error', {
                tradeId,
                error: error.message,
                duration
            });

            resolve({
                success: false,
                error: `Execution error: ${error.message}`,
                duration,
                tradeId
            });
        });

        // Handle timeout
        setTimeout(() => {
            if (!child.killed) {
                child.kill();
                const duration = Date.now() - startTime;
                WebhookLogger.error('⏱️ Trade execution timeout', {
                    tradeId,
                    timeout: CONFIG.TRADE_TIMEOUT,
                    duration
                });

                resolve({
                    success: false,
                    error: `Trade execution timed out after ${CONFIG.TRADE_TIMEOUT}ms`,
                    duration,
                    tradeId
                });
            }
        }, CONFIG.TRADE_TIMEOUT);
    });
};

// Route handlers
app.get('/health', (req: any, res: any) => {
    const healthInfo = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: CONFIG.PORT,
        testMode: CONFIG.TEST_MODE,
        uptime: Math.floor(process.uptime()),
        version: '3.0.0-express5',
        nodeVersion: process.version,
        expressVersion: '5.1.0',
        memory: process.memoryUsage(),
        middleware: {
            cors: CONFIG.ENABLE_CORS,
            helmet: CONFIG.ENABLE_HELMET,
            rateLimit: CONFIG.ENABLE_RATE_LIMIT
        }
    };

    WebhookLogger.debug('Health check requested', healthInfo);
    res.json(healthInfo);
});

app.get('/status', (req: any, res: any) => {
    const statusInfo = {
        server: 'TradingView Webhook Server v3.0 (Express 5.1.0)',
        status: 'running',
        mode: CONFIG.TEST_MODE ? 'TEST MODE' : 'LIVE TRADING',
        port: CONFIG.PORT,
        timestamp: new Date().toISOString(),
        configuration: {
            testMode: CONFIG.TEST_MODE,
            secretConfigured: CONFIG.SECRET_KEY !== 'your-secret-key',
            corsEnabled: CONFIG.ENABLE_CORS,
            helmetEnabled: CONFIG.ENABLE_HELMET,
            rateLimitEnabled: CONFIG.ENABLE_RATE_LIMIT,
            rateLimitPerMin: CONFIG.MAX_REQUESTS_PER_MINUTE,
            tradeTimeoutMs: CONFIG.TRADE_TIMEOUT,
            logLevel: CONFIG.LOG_LEVEL,
            logDirectory: logsDir
        },
        endpoints: {
            health: '/health',
            status: '/status',
            webhook: '/webhook/tradingview',
            logs: '/logs',
            config: '/config'
        },
        supportedPairs: ['BTC/USDC', 'WBTC/USDC', 'AVAX/USDC', 'WAVAX/USDC'],
        supportedNetworks: ['Avalanche'],
        supportedExchanges: ['Uniswap']
    };

    WebhookLogger.debug('Status check requested', statusInfo);
    res.json(statusInfo);
});

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
            res.json({
                message: 'No webhook logs found for today',
                date: today,
                logFile,
                availableLogs: fs.readdirSync(logsDir).filter(f => f.endsWith('.log'))
            });
        }
    } catch (error) {
        WebhookLogger.error('Failed to read logs', { error });
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

app.get('/config', (req: any, res: any) => {
    const configInfo = {
        testMode: CONFIG.TEST_MODE,
        port: CONFIG.PORT,
        rateLimitPerMin: CONFIG.MAX_REQUESTS_PER_MINUTE,
        tradeTimeoutMs: CONFIG.TRADE_TIMEOUT,
        corsEnabled: CONFIG.ENABLE_CORS,
        helmetEnabled: CONFIG.ENABLE_HELMET,
        rateLimitEnabled: CONFIG.ENABLE_RATE_LIMIT,
        secretConfigured: CONFIG.SECRET_KEY !== 'your-secret-key',
        logLevel: CONFIG.LOG_LEVEL,
        environment: process.env.NODE_ENV || 'development'
    };

    res.json(configInfo);
});

// Main webhook endpoint
app.post('/webhook/tradingview', (req: any, res: any) => {
    const webhookId = `webhook_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const startTime = Date.now();

    handleWebhookAsync(req, res, webhookId, startTime).catch((error) => {
        WebhookLogger.error('Webhook handler error', { error: error.message, webhookId });
        res.status(500).json({
            error: 'Internal server error',
            webhookId,
            timestamp: new Date().toISOString()
        });
    });
});

// Separate async function to handle webhook processing
async function handleWebhookAsync(req: any, res: any, webhookId: string, startTime: number): Promise<void> {
    try {
        WebhookLogger.info(`📡 Incoming webhook (${webhookId})`, {
            headers: {
                'content-type': req.get('Content-Type'),
                'user-agent': req.get('User-Agent'),
                'x-webhook-secret': req.get('X-Webhook-Secret') ? '[PRESENT]' : '[MISSING]'
            },
            body: req.body,
            ip: req.ip
        });

        // Security validation
        const providedSecret = req.get('X-Webhook-Secret');
        if (!providedSecret) {
            WebhookLogger.warn(`❌ Webhook rejected - No secret header (${webhookId})`);
            res.status(401).json({
                error: 'Missing X-Webhook-Secret header',
                webhookId,
                required: 'X-Webhook-Secret header is required'
            });
            return;
        }

        if (providedSecret !== CONFIG.SECRET_KEY) {
            WebhookLogger.warn(`❌ Webhook rejected - Invalid secret (${webhookId})`, {
                providedLength: providedSecret.length,
                expectedLength: CONFIG.SECRET_KEY.length
            });
            res.status(401).json({
                error: 'Invalid webhook secret',
                webhookId
            });
            return;
        }

        WebhookLogger.info(`✅ Webhook security check passed (${webhookId})`);

        // Data validation
        const validation = validateWebhookData(req.body);

        if (!validation.isValid) {
            WebhookLogger.warn(`❌ Webhook data validation failed (${webhookId})`, {
                errors: validation.errors,
                receivedData: req.body
            });
            res.status(400).json({
                error: 'Invalid webhook data',
                details: validation.errors,
                webhookId
            });
            return;
        }

        if (validation.warnings.length > 0) {
            WebhookLogger.warn(`⚠️ Webhook validation warnings (${webhookId})`, {
                warnings: validation.warnings
            });
        }

        // Extract and process data
        const webhookData: WebhookPayload = req.body;
        const { side, product, network, exchange } = webhookData;
        const tradeDirection = mapToTradeDirection(side, product);

        if (!tradeDirection) {
            WebhookLogger.warn(`❌ Unsupported trading pair (${webhookId})`, { product, side });
            res.status(400).json({
                error: 'Unsupported trading pair',
                product,
                side,
                supported: ['BTC/USDC', 'WBTC/USDC', 'AVAX/USDC', 'WAVAX/USDC'],
                webhookId
            });
            return;
        }

        WebhookLogger.info(`🎯 Webhook processed successfully (${webhookId})`, {
            originalData: { side, product, network, exchange },
            mappedTradeDirection: tradeDirection,
            testMode: CONFIG.TEST_MODE
        });

        // Execute trade or return test response
        const response: WebhookResponse = {
            mode: CONFIG.TEST_MODE ? 'TEST_MODE' : 'LIVE_TRADING',
            status: '',
            webhookId,
            timestamp: new Date().toISOString(),
            receivedData: webhookData,
            tradeDirection
        };

        if (CONFIG.TEST_MODE) {
            response.status = 'webhook_received_and_validated';
            response.wouldExecute = tradeDirection;
            response.message = 'Webhook received and validated. Set TEST_MODE=false to enable live trading.';

            WebhookLogger.info(`🧪 TEST MODE: Would execute ${tradeDirection} (${webhookId})`, response);
            res.json(response);
        } else {
            WebhookLogger.info(`🚀 LIVE MODE: Executing ${tradeDirection} (${webhookId})`);

            const executionResult: TradeExecutionResult = await executeTrade(tradeDirection, webhookData);

            response.status = executionResult.success ? 'trade_executed' : 'trade_failed';
            response.executionResult = executionResult;

            if (executionResult.success) {
                WebhookLogger.info(`✅ Trade execution completed (${webhookId})`, {
                    duration: Date.now() - startTime,
                    tradeResult: executionResult
                });
            } else {
                WebhookLogger.error(`❌ Trade execution failed (${webhookId})`, {
                    duration: Date.now() - startTime,
                    error: executionResult.error
                });
                response.error = executionResult.error;
            }

            res.status(executionResult.success ? 200 : 500).json(response);
        }

    } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        WebhookLogger.error(`💥 Webhook processing error (${webhookId})`, {
            error: errorMessage,
            duration,
            stack: error instanceof Error ? error.stack : undefined
        });

        res.status(500).json({
            error: 'Internal server error',
            webhookId,
            timestamp: new Date().toISOString(),
            message: CONFIG.TEST_MODE ? errorMessage : 'An error occurred processing the webhook'
        });
    }
}

// 404 handler
app.use('*', (req: any, res: any) => {
    WebhookLogger.warn(`❌ 404 - Route not found: ${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });

    res.status(404).json({
        error: 'Endpoint not found',
        requested: `${req.method} ${req.originalUrl}`,
        availableEndpoints: ['/health', '/status', '/webhook/tradingview', '/logs', '/config']
    });
});

// Error handler
app.use((error: Error, req: any, res: any, _next: any) => {
    WebhookLogger.error('Express error handler', {
        error: error.message,
        stack: error.stack,
        url: req.originalUrl,
        method: req.method
    });

    res.status(500).json({
        error: 'Internal server error',
        message: CONFIG.TEST_MODE ? error.message : 'An unexpected error occurred'
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    WebhookLogger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
        WebhookLogger.info('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    WebhookLogger.info('SIGINT received, shutting down gracefully');
    server.close(() => {
        WebhookLogger.info('Server closed');
        process.exit(0);
    });
});

// Start server
const server = app.listen(CONFIG.PORT, () => {
    console.log('🚀 ================================');
    console.log('🚀 EXPRESS 5.1.0 WEBHOOK SERVER');
    console.log('🚀 ================================');
    console.log(`🚀 Port: ${CONFIG.PORT}`);
    console.log(`🚀 Mode: ${CONFIG.TEST_MODE ? '🧪 TEST MODE (Safe)' : '⚡ LIVE TRADING'}`);
    console.log(`🚀 Express: 5.1.0 (Latest & Secure)`);
    console.log(`🚀 Webhook URL: http://localhost:${CONFIG.PORT}/webhook/tradingview`);
    console.log(`🚀 Logs Directory: ${logsDir}`);
    console.log(`🚀 Middleware: CORS=${CONFIG.ENABLE_CORS}, Helmet=${CONFIG.ENABLE_HELMET}, RateLimit=${CONFIG.ENABLE_RATE_LIMIT}`);
    console.log('🚀 ================================');

    WebhookLogger.info('Express 5.1.0 webhook server started', {
        port: CONFIG.PORT,
        testMode: CONFIG.TEST_MODE,
        middleware: {
            cors: CONFIG.ENABLE_CORS,
            helmet: CONFIG.ENABLE_HELMET,
            rateLimit: CONFIG.ENABLE_RATE_LIMIT
        }
    });
});