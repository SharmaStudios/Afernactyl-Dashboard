const cron = require('node-cron');
const generateInvoices = require('../tasks/generate_invoices');
const cleanupSuspended = require('../tasks/cleanup_suspended');
const suspendOverdue = require('../tasks/suspend_overdue');
const radarScan = require('../tasks/radar_scan');
const cleanupAttachments = require('../tasks/cleanup_attachments');
const db = require('../config/database');

let radarTask = null;

async function getRadarInterval() {
    try {
        const conn = await db.getConnection();
        const result = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'radar_scan_interval'");
        conn.release();
        if (result.length > 0 && result[0].setting_value) {
            const interval = parseInt(result[0].setting_value);
            if (interval >= 5 && interval <= 1440) {
                return interval;
            }
        }
    } catch (err) {
        // Obfuscated/Silent failure for security (Lockout)
        // If the DB is locked (Key Mismatch), this will fail.
        // We should just return default and let the tasks fail individually/silently later.
        if (err.message !== "KEY_MISMATCH" && err.message !== "HW_MISMATCH") {
            console.error('[Scheduler] Warning: Could not fetch radar interval (using default).');
        }
    }
    return 30; // Default to 30 minutes
}

async function initScheduler() {
    console.log('[Scheduler] Initializing internal job scheduler...');

    // Invoice Generation - Runs daily at midnight
    // Schedule: 0 0 * * *
    cron.schedule('0 0 * * *', async () => {
        console.log('[Scheduler] Running scheduled task: Generate Invoices');
        try {
            await generateInvoices();
        } catch (err) {
            console.error('[Scheduler] Error in Generate Invoices task:', err);
        }
    });
    console.log('[Scheduler] Registered task: Generate Invoices (Daily at 00:00)');

    // Cleanup Suspended Servers - Runs daily at midnight
    // Schedule: 0 0 * * *
    cron.schedule('0 0 * * *', async () => {
        console.log('[Scheduler] Running scheduled task: Cleanup Suspended Servers');
        try {
            await cleanupSuspended();
        } catch (err) {
            console.error('[Scheduler] Error in Cleanup Suspended task:', err);
        }
    });
    console.log('[Scheduler] Registered task: Cleanup Suspended Servers (Daily at 00:00)');

    // Suspend Overdue Servers - Runs daily at 00:05
    // Schedule: 5 0 * * *
    cron.schedule('5 0 * * *', async () => {
        console.log('[Scheduler] Running scheduled task: Suspend Overdue Servers');
        try {
            await suspendOverdue();
        } catch (err) {
            console.error('[Scheduler] Error in Suspend Overdue task:', err);
        }
    });
    console.log('[Scheduler] Registered task: Suspend Overdue Servers (Daily at 00:05)');

    // Cleanup Old Attachments - Runs daily at 01:00
    // Schedule: 0 1 * * *
    cron.schedule('0 1 * * *', async () => {
        console.log('[Scheduler] Running scheduled task: Cleanup Old Attachments');
        try {
            await cleanupAttachments();
        } catch (err) {
            console.error('[Scheduler] Error in Cleanup Attachments task:', err);
        }
    });
    console.log('[Scheduler] Registered task: Cleanup Old Attachments (Daily at 01:00)');

    // Radar Scan - Runs based on configurable interval (default 30 mins)
    const radarInterval = await getRadarInterval();
    const radarCronExpr = `*/${radarInterval} * * * *`;

    radarTask = cron.schedule(radarCronExpr, async () => {
        console.log('[Scheduler] Running scheduled task: Radar Scan');
        try {
            await radarScan();
        } catch (err) {
            console.error('[Scheduler] Error in Radar Scan task:', err);
        }
    });
    console.log(`[Scheduler] Registered task: Radar Scan (Every ${radarInterval} mins)`);

    console.log('[Scheduler] Internal scheduler started.');
}

module.exports = { initScheduler, getRadarInterval };

