// traceTransaction.ts
import { createPublicClient, http } from 'viem';
import { avalanche } from 'viem/chains';

async function traceTransaction(hash: string) {
    const client = createPublicClient({
        chain: avalanche,
        transport: http(process.env.AVALANCHE_RPC_URL as string),
    });

    // Note: Your RPC provider must support debug methods
    try {
        const trace = await client.transport.request({
            method: 'debug_traceTransaction',
            params: [hash, { tracer: 'callTracer' }]
        });

        console.log(JSON.stringify(trace, null, 2));
    } catch (error) {
        console.error('Error tracing transaction:', error);
        console.log('Note: Your RPC provider may not support debug_traceTransaction');
        console.log('Try using a dedicated node or a service like Chainstack, QuickNode, or Alchemy');
    }
}

// Check if hash is provided as command line argument
const hash = process.argv[2] || '0x7065df34fd215f9ebf385f1e00d7a190e7924049efa30d1511236e54dec71257';
console.log(`Tracing transaction: ${hash}`);
traceTransaction(hash).catch(console.error);