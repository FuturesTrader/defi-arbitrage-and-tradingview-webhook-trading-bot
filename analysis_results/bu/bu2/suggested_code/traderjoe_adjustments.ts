// ========================================================
// QUOTE ADJUSTMENT FACTORS FOR TRADER JOE
// ========================================================
// Generated based on statistical analysis of 56 transactions
// Date: 2025-03-16T21:55:04.835Z
// 
// First Leg (USDC->WAVAX): 1.0001 
//    - Confidence: low
//    - Sample size: 17
//
// Second Leg (WAVAX->USDC): 1.0000
//    - Confidence: low
//    - Sample size: 24
// ========================================================

/**
 * Adjustment factors for Trader Joe quotes based on empirical data
 */
export const TRADERJOE_QUOTE_ADJUSTMENT_FACTORS = {
    // For USDC->WAVAX direction
    USDC_TO_WAVAX: 1.0001,
    
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
        ? TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.USDC_TO_WAVAX 
        : TRADERJOE_QUOTE_ADJUSTMENT_FACTORS.WAVAX_TO_USDC;
    
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
    const rawExpectedOutput = bestTrade.outputAmount.toExact();
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