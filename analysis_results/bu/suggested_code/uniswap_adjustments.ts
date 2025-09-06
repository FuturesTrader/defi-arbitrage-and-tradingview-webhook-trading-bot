// ========================================================
// QUOTE ADJUSTMENT FACTORS FOR UNISWAP
// ========================================================
// Generated based on statistical analysis of 62 transactions
// Date: 2025-03-14T15:56:28.809Z
// 
// First Leg (USDC->WAVAX): 1.0000 
//    - Confidence: low
//    - Sample size: 31
//
// Second Leg (WAVAX->USDC): 1.0000
//    - Confidence: low
//    - Sample size: 31
// ========================================================

/**
 * Adjustment factors for Uniswap quotes based on empirical data
 */
export const UNISWAP_QUOTE_ADJUSTMENT_FACTORS = {
    // For USDC->WAVAX direction
    USDC_TO_WAVAX: 1.0000,
    
    // For WAVAX->USDC direction
    WAVAX_TO_USDC: 1.0000
};

/**
 * Apply the empirical adjustment factor to expected output
 * @param expectedOutput The original expected output
 * @param direction The swap direction ('USDC->WAVAX' or 'WAVAX->USDC')
 * @returns The adjusted expected output
 */
export function applyQuoteAdjustment(expectedOutput: string, direction: 'USDC->WAVAX' | 'WAVAX->USDC'): string {
    // Get the appropriate factor based on direction
    const factor = direction === 'USDC->WAVAX' 
        ? UNISWAP_QUOTE_ADJUSTMENT_FACTORS.USDC_TO_WAVAX 
        : UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WAVAX_TO_USDC;
    
    // Apply the adjustment factor
    const adjustedOutput = (parseFloat(expectedOutput) * factor).toString();
    return adjustedOutput;
}

// Implementation example for your getQuote function:
/*
export async function getQuote(
    direction: 'USDC->WAVAX' | 'WAVAX->USDC',
    amount?: string,
    recipientOverride?: string
): Promise<SimulatedQuoteResult | null> {
    // ... existing code ...
    
    // Once we have the expected output, apply the adjustment factor
    const rawExpectedOutput = trade.outputAmount.toExact();
    const adjustedExpectedOutput = applyQuoteAdjustment(rawExpectedOutput, direction);
    
    // Use the adjusted value in the returned results
    const result: SimulatedQuoteResult = {
        // ... other fields ...
        expectedOutput: adjustedExpectedOutput,
        // ... other fields ...
    };
    
    // ... existing code ...
}
*/