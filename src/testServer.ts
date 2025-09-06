// src/testServer.ts - Ultra minimal test to isolate express issue
import express from 'express';

const app = express();
const PORT = 3001;

// Only JSON parsing, no other middleware
app.use(express.json());

// Single test route
app.get('/test', (req: any, res: any) => {
    res.json({ status: 'working', timestamp: new Date().toISOString() });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🧪 Ultra minimal test server running on port ${PORT}`);
    console.log(`Test URL: http://localhost:${PORT}/test`);
});

export default app;