// ========================================================
// QUOTE ADJUSTMENT FACTORS FOR UNISWAP
// ========================================================
// Generated based on statistical analysis of 8 transactions
// Date: 2025-09-10T20:00:44.954Z
// 
// WAVAX Adjustment Factors:
// ------------------------
// First Leg (USDC->WAVAX): 1.0000 
//    - Confidence: low
//    - Sample size: 4
//
// Second Leg (WAVAX->USDC): 1.0000
//    - Confidence: low
//    - Sample size: 0
//
// WBTC Adjustment Factors:
// -----------------------
// First Leg (USDC->WBTC): 1.0000 
//    - Confidence: low
//    - Sample size: 4
//
// Second Leg (WBTC->USDC): 1.0000
//    - Confidence: low
//    - Sample size: 0
// ========================================================

/**
 * Adjustment factors for Uniswap quotes based on empirical data
 */
export const UNISWAP_QUOTE_ADJUSTMENT_FACTORS = {
    // WAVAX adjustment factors
    WAVAX: {
        // For USDC->WAVAX direction
        USDC_TO_WAVAX: 1.0000,
        
        // For WAVAX->USDC direction
        WAVAX_TO_USDC: 1.0000
    },
    
    // WBTC adjustment factors
    WBTC: {
        // For USDC->WBTC direction
        USDC_TO_WBTC: 1.0000,
        
        // For WBTC->USDC direction
        WBTC_TO_USDC: 1.0000
    }
};

/**
 * Apply the empirical adjustment factor to expected output
 * @param expectedOutput The original expected output
 * @param direction The swap direction ('USDC->WAVAX' or 'WAVAX->USDC')
 * @returns The adjusted expected output
 */
export function applyQuoteAdjustment(
    expectedOutput: string, 
    direction: 'USDC->WAVAX' | 'WAVAX->USDC' | 'USDC->WBTC' | 'WBTC->USDC'
): string {
    // Get token from direction
    const isWbtc = direction.includes('WBTC');
    const tokenKey = isWbtc ? 'WBTC' : 'WAVAX';
    
    // Get direction type (first leg or second leg)
    const isFirstLeg = direction.startsWith('USDC->');
    
    // Get the appropriate factor based on token and direction
    let factor: number;
    if (isWbtc) {
        factor = isFirstLeg 
            ? UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WBTC.USDC_TO_WBTC 
            : UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WBTC.WBTC_TO_USDC;
    } else {
        factor = isFirstLeg 
            ? UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WAVAX.USDC_TO_WAVAX 
            : UNISWAP_QUOTE_ADJUSTMENT_FACTORS.WAVAX.WAVAX_TO_USDC;
    }
    
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