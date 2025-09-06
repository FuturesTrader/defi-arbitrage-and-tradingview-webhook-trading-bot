// src/logger.ts
import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import process from 'process';
import { safeSerialize } from '@/utils';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirnamePath = path.dirname(__filename);
const logsDir = path.join(__dirnamePath, '..', 'logs');

// Custom types
interface CustomLogger extends winston.Logger {
    flush: () => Promise<void>;
}

interface DailyRotateFileTransport extends winston.transport {
    close?: () => void;
}

class LoggerSingleton {
    private static instance: CustomLogger | null = null;
    private static isInitialized = false;

    private static getLogsDirectory(): string {
        const cwd = process.cwd();
        const logsDir = path.join(cwd, 'logs');

        if (!fs.existsSync(logsDir)) {
            try {
                fs.mkdirSync(logsDir, { recursive: true });
                console.log(`Created logs directory at: ${logsDir}`);
            } catch (error) {
                console.error(`Failed to create logs directory at ${logsDir}:`, error);
                process.exit(1);
            }
        }
        return logsDir;
    }

    public static createFormat(): winston.Logform.Format {
        return winston.format.combine(
            winston.format.timestamp({
                format: () => {
                    const now = new Date();
                    // Format date as YYYY-MM-DD using en-CA (ISO-like)
                    const datePart = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
                    // Format time as HH:mm:ss (24-hour clock) using en-GB
                    const timePart = now.toLocaleTimeString('en-GB', {
                        timeZone: 'America/Chicago',
                        hour12: false,
                    });
                    // Extract the timezone abbreviation (e.g. CST or CDT)
                    const tzString = now
                        .toLocaleTimeString('en-US', {
                            timeZone: 'America/Chicago',
                            timeZoneName: 'short',
                        })
                        .split(' ')
                        .pop();
                    return `${datePart}T${timePart}.000 ${tzString}`;
                },
            }),
            winston.format.printf(({ level, message, timestamp, ...metadata }) => {
                let serializedMetadata = '';
                if (metadata && Object.keys(metadata).length > 0) {
                    try {
                        serializedMetadata = safeSerialize(metadata);
                    } catch (error) {
                        serializedMetadata = `[Serialization Error: ${
                            error instanceof Error ? error.message : String(error)
                        }]`;
                        console.error('Logging serialization error:', error);
                    }
                }
                return `${timestamp} [${level}]: ${message} ${serializedMetadata}`;
            })
        );
    }

    public static getInstance(): CustomLogger {
        if (!LoggerSingleton.instance) {
            LoggerSingleton.initialize();
        }
        return LoggerSingleton.instance!;
    }

    private static initialize(): void {
        if (LoggerSingleton.isInitialized) {
            return;
        }

        const logsDir = LoggerSingleton.getLogsDirectory();
        const customFormat = LoggerSingleton.createFormat();

        // Console transport with debug level for development
        const consoleTransport = new winston.transports.Console({
            level: 'debug',
            format: winston.format.combine(winston.format.colorize(), customFormat),
        });

        // File transport with configurable level and reduced size
        const fileTransport = new winston.transports.DailyRotateFile({
            filename: path.join(logsDir, 'application-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '2m', //
            maxFiles: '2d', // Reduced retention period to manage storage
            level: process.env.LOG_LEVEL || 'debug',
            format: customFormat,
            handleExceptions: true,
            handleRejections: true,
            zippedArchive: true
        });

        // Create the logger
        const baseLogger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'debug',
            format: winston.format.combine(
                winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
                customFormat
            ),
            transports: [consoleTransport, fileTransport],
            exitOnError: false
        });

        // Add flush capability
        const customLogger = baseLogger as CustomLogger;
        customLogger.flush = async function (): Promise<void> {
            return new Promise((resolve) => {
                const transports = this.transports as winston.transport[];
                const promises = transports.map(
                    transport =>
                        new Promise<void>(transportResolve => {
                            if (transport instanceof winston.transports.DailyRotateFile) {
                                setTimeout(() => transportResolve(), 100);
                                const dailyRotateTransport = transport as DailyRotateFileTransport;
                                if (typeof dailyRotateTransport.close === 'function') {
                                    transport.on('finish', () => transportResolve());
                                } else {
                                    transportResolve();
                                }
                            } else {
                                transportResolve();
                            }
                        })
                );

                Promise.all(promises).then(() => {
                    setTimeout(resolve, 100);
                });
            });
        };

        // Error handling
        fileTransport.on('error', (error) => {
            console.error('File transport error:', error);
        });

        consoleTransport.on('error', (error) => {
            console.error('Console transport error:', error);
        });

        LoggerSingleton.instance = customLogger;
        LoggerSingleton.isInitialized = true;

        // Initial log to verify logger is working
        customLogger.info('Logger initialized', {
            logsDirectory: logsDir,
            logLevel: process.env.LOG_LEVEL || 'debug',
            nodeEnv: process.env.NODE_ENV,
            timezone: 'America/Chicago'
        });
    }
}

// Export the singleton instance
const logger = LoggerSingleton.getInstance();
export default logger;

// ------------------------------------------------------------------
// Update: Trade logger now outputs logs to the logs/tradelogs directory
// ------------------------------------------------------------------

// Ensure the trade logs subdirectory exists
const tradeLogsDir = path.join(logsDir, 'tradelogs');
if (!fs.existsSync(tradeLogsDir)) {
    try {
        fs.mkdirSync(tradeLogsDir, { recursive: true });
        console.log(`Created trade logs directory at: ${tradeLogsDir}`);
    } catch (error) {
        console.error(`Failed to create trade logs directory at ${tradeLogsDir}:`, error);
        process.exit(1);
    }
}

const tradeTransport = new winston.transports.DailyRotateFile({
    filename: path.join(tradeLogsDir, 'trade-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '100k', // Reduced to 100KB
    maxFiles: '14d', // Reduced retention period to manage storage
    level: 'info',
    format: LoggerSingleton.createFormat(),
    zippedArchive: true
});

const tradeLogger = winston.createLogger({
    level: 'info',
    transports: [tradeTransport]
});

export { tradeLogger };
