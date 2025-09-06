// src/priceHelper.ts
import dotenv from 'dotenv';
dotenv.config();
import logger from '@/logger';

export class Constants {
    static readonly SCALE = 1n << 128n;
    static readonly SCALE_OFFSET = 128n;
    static readonly BASIS_POINT_MAX = 10000n;
    static readonly PRECISION = 10n ** 18n;
}

export class PriceHelper {
    private static readonly REAL_ID_SHIFT = 1n << 23n;

    /**
     * @dev Calculates the price from the id and the bin step
     * @param id The id (uint24)
     * @param binStep The bin step (uint16)
     * @return price The price as a 128.128-binary fixed-point number
     */
    static getPriceFromId(id: number, binStep: number): bigint {
        try {
            logger.debug('Calculating price from ID', {
                id,
                binStep,
                operation: 'getPriceFromId'
            });

            const base = this.getBase(BigInt(binStep));
            const exponent = this.getExponent(BigInt(id));
            const result = this.pow(base, exponent);

            logger.debug('Price calculation completed', {
                id,
                binStep,
                base: base.toString(),
                exponent: exponent.toString(),
                result: result.toString()
            });

            return result;
        } catch (error) {
            logger.error('Error calculating price from ID', {
                id,
                binStep,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * @dev Calculates the base from the bin step, which is `1 + binStep / BASIS_POINT_MAX`
     * @param binStep The bin step
     * @return base The base as 128.128-binary fixed-point
     */
    private static getBase(binStep: bigint): bigint {
        try {
            logger.debug('Calculating base from bin step', {
                binStep: binStep.toString()
            });

            const scaledBinStep = (binStep << Constants.SCALE_OFFSET) / Constants.BASIS_POINT_MAX;
            const result = Constants.SCALE + scaledBinStep;

            logger.debug('Base calculation completed', {
                binStep: binStep.toString(),
                scaledBinStep: scaledBinStep.toString(),
                result: result.toString()
            });

            return result;
        } catch (error) {
            logger.error('Error calculating base', {
                binStep: binStep.toString(),
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * @dev Calculates the exponent from the id, which is `id - REAL_ID_SHIFT`
     * @param id The id
     * @return exponent The exponent
     */
    private static getExponent(id: bigint): bigint {
        try {
            logger.debug('Calculating exponent', {
                id: id.toString(),
                REAL_ID_SHIFT: this.REAL_ID_SHIFT.toString()
            });

            const result = id - this.REAL_ID_SHIFT;

            logger.debug('Exponent calculation completed', {
                id: id.toString(),
                result: result.toString()
            });

            return result;
        } catch (error) {
            logger.error('Error calculating exponent', {
                id: id.toString(),
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * @dev Implements power function for binary fixed-point numbers
     * @param base The base as a 128.128-binary fixed-point number
     * @param exponent The exponent (can be negative)
     */
    private static pow(base: bigint, exponent: bigint): bigint {
        try {
            logger.debug('Starting power calculation', {
                base: base.toString(),
                exponent: exponent.toString()
            });

            if (exponent === 0n) {
                logger.debug('Power calculation completed (exponent = 0)', {
                    result: Constants.SCALE.toString()
                });
                return Constants.SCALE;
            }
            if (exponent === 1n) {
                logger.debug('Power calculation completed (exponent = 1)', {
                    result: base.toString()
                });
                return base;
            }

            let result = Constants.SCALE;
            let absExponent = exponent < 0n ? -exponent : exponent;
            let currentBase = base;

            while (absExponent > 0n) {
                if (absExponent & 1n) {
                    result = (result * currentBase) >> Constants.SCALE_OFFSET;
                }
                currentBase = (currentBase * currentBase) >> Constants.SCALE_OFFSET;
                absExponent = absExponent >> 1n;
            }

            if (exponent < 0n) {
                result = (Constants.SCALE * Constants.SCALE) / result;
            }

            logger.debug('Power calculation completed', {
                base: base.toString(),
                exponent: exponent.toString(),
                result: result.toString()
            });

            return result;
        } catch (error) {
            logger.error('Error in power calculation', {
                base: base.toString(),
                exponent: exponent.toString(),
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * @dev Converts a price with 18 decimals to a 128.128-binary fixed-point number
     * @param price The price with 18 decimals
     */
    static convertDecimalPriceTo128x128(price: bigint): bigint {
        try {
            logger.debug('Converting decimal price to 128x128', {
                price: price.toString()
            });

            const result = (price << Constants.SCALE_OFFSET) / Constants.PRECISION;

            logger.debug('Decimal to 128x128 conversion completed', {
                price: price.toString(),
                result: result.toString()
            });

            return result;
        } catch (error) {
            logger.error('Error converting decimal price to 128x128', {
                price: price.toString(),
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * @dev Converts a 128.128-binary fixed-point number to a price with 18 decimals
     * @param price128x128 The 128.128-binary fixed-point number
     */
    static convert128x128PriceToDecimal(price128x128: bigint): bigint {
        try {
            logger.debug('Converting 128x128 price to decimal', {
                price128x128: price128x128.toString()
            });

            const result = (price128x128 * Constants.PRECISION) >> Constants.SCALE_OFFSET;

            logger.debug('128x128 to decimal conversion completed', {
                price128x128: price128x128.toString(),
                result: result.toString()
            });

            return result;
        } catch (error) {
            logger.error('Error converting 128x128 price to decimal', {
                price128x128: price128x128.toString(),
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * Converts the raw decimal price to a human-readable format
     * @param decimalPrice The price in raw decimal format (18 decimals)
     * @param quoteDecimals Number of decimals for quote token (e.g., 6 for USDC)
     * @param baseDecimals Number of decimals for base token (e.g., 18 for WAVAX)
     * @returns The price as a string with proper decimal places
     */
    static formatPrice(
        decimalPrice: bigint,
        quoteDecimals: number = 6,
        baseDecimals: number = 18
    ): string {
        try {
            logger.debug('Formatting price', {
                decimalPrice: decimalPrice.toString(),
                quoteDecimals,
                baseDecimals
            });

            const adjustedDecimalPrice = Number(decimalPrice) / Number(10n ** BigInt(18 + quoteDecimals - baseDecimals));
            const result = adjustedDecimalPrice.toFixed(quoteDecimals);

            logger.debug('Price formatting completed', {
                decimalPrice: decimalPrice.toString(),
                adjustedDecimalPrice,
                result
            });

            return result;
        } catch (error) {
            logger.error('Error formatting price', {
                decimalPrice: decimalPrice.toString(),
                quoteDecimals,
                baseDecimals,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /**
     * @dev Safe casting to uint24 (throws if number is out of bounds)
     */
    private static safe24(value: bigint): number {
        try {
            logger.debug('Performing safe24 conversion', {
                value: value.toString()
            });

            const max24bit = (1n << 24n) - 1n;
            if (value < 0n || value > max24bit) {
                const error = new Error('Value out of uint24 bounds');
                logger.error('safe24 conversion failed', {
                    value: value.toString(),
                    max24bit: max24bit.toString(),
                    error: error.message
                });
                throw error;
            }

            const result = Number(value);
            logger.debug('safe24 conversion completed', {
                value: value.toString(),
                result
            });

            return result;
        } catch (error) {
            logger.error('Error in safe24 conversion', {
                value: value.toString(),
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
}