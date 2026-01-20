// Centralized Debug Logger Service with File Persistence
// Used by Pterodactyl API, Payment Gateways, and other services

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../data/debug_logs.json');
const MAX_LOGS = 500;

// Ensure data directory exists
const dataDir = path.dirname(LOG_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Load logs from file
function loadLogs() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const data = fs.readFileSync(LOG_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('[DebugLogger] Error reading log file:', err.message);
    }
    return [];
}

// Save logs to file
function saveLogs(logs) {
    try {
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
    } catch (err) {
        console.error('[DebugLogger] Error writing log file:', err.message);
    }
}

function addLog(source, type, message, data = null) {
    const logs = loadLogs();
    logs.unshift({
        source,
        type,
        message,
        data: data ? JSON.stringify(data, null, 2) : null,
        timestamp: new Date().toISOString()
    });

    // Keep last MAX_LOGS entries
    if (logs.length > MAX_LOGS) {
        logs.length = MAX_LOGS;
    }

    saveLogs(logs);
}

module.exports = {
    // Add a log entry
    log: (source, type, message, data = null) => {
        addLog(source, type, message, data);
    },

    // Convenience methods for different sources
    ptero: (type, message, data = null) => addLog('PTERO', type, message, data),
    phonepe: (type, message, data = null) => addLog('PHONEPE', type, message, data),
    stripe: (type, message, data = null) => addLog('STRIPE', type, message, data),
    paypal: (type, message, data = null) => addLog('PAYPAL', type, message, data),
    system: (type, message, data = null) => addLog('SYSTEM', type, message, data),

    // Get all logs
    getLogs: () => {
        const logs = loadLogs();
        // Convert timestamp strings back to Date objects for display
        return logs.map(log => ({
            ...log,
            timestamp: new Date(log.timestamp)
        }));
    },

    // Get logs filtered by source
    getLogsBySource: (source) => {
        const logs = loadLogs();
        return logs.filter(log => log.source === source).map(log => ({
            ...log,
            timestamp: new Date(log.timestamp)
        }));
    },

    // Clear all logs
    clearLogs: () => {
        saveLogs([]);
    }
};
