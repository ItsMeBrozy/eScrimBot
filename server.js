const express = require('express');
const app = express();
const port = process.env.PORT || 7860; // HF Spaces uses port 7860

// Log buffer to store live console logs for web diagnostics
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatLog(args) {
    return args.map(arg => {
        if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
        }
        return String(arg);
    }).join(' ');
}

console.log = (...args) => {
    logBuffer.push(`[LOG] ${new Date().toISOString()} | ${formatLog(args)}`);
    if (logBuffer.length > 500) logBuffer.shift();
    originalLog(...args);
};

console.error = (...args) => {
    logBuffer.push(`[ERROR] ${new Date().toISOString()} | ${formatLog(args)}`);
    if (logBuffer.length > 500) logBuffer.shift();
    originalError(...args);
};

console.warn = (...args) => {
    logBuffer.push(`[WARN] ${new Date().toISOString()} | ${formatLog(args)}`);
    if (logBuffer.length > 500) logBuffer.shift();
    originalWarn(...args);
};

// Client reference — set later via setClient()
let botClient = null;

app.get('/', (req, res) => {
    res.status(200).json({
        status: botClient?.isReady() ? 'online' : 'starting',
        bot: botClient?.user ? botClient.user.tag : 'Initializing...',
        shard: botClient?.shard ? botClient.shard.ids : 'none',
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/logs', (req, res) => {
    res.header('Content-Type', 'text/plain; charset=utf-8');
    res.send(logBuffer.join('\n'));
});

app.get('/health', (req, res) => {
    // Always return 200 immediately so HF Spaces keeps us alive
    // Bot initializes in background
    res.status(200).send('OK');
});

app.get('/status', (req, res) => {
    // Detailed status for monitoring (non-blocking)
    res.status(200).json({
        status: botClient?.isReady() ? 'online' : 'starting',
        bot: botClient?.user ? botClient.user.tag : 'Initializing...',
        uptime: Math.floor(process.uptime()) + 's'
    });
});

// Start listening IMMEDIATELY on require() — this is critical for HF Spaces
app.listen(port, '0.0.0.0', () => {
    console.log(`>>> [SERVER] Keep-alive server listening on port ${port}`);
});

function setClient(client) {
    botClient = client;
}

module.exports = { setClient };
