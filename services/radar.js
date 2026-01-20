const axios = require('axios');
const db = require('../config/database');
const pteroService = require('./pterodactyl');
const discord = require('./discord');

// Default thresholds (heuristics for resource abuse)
const DEFAULT_THRESHOLDS = {
    cpu: { warn: 90, danger: 150 },
    disk: { warn: 90, danger: 98 }
};

// Default suspicious files
const DEFAULT_SUSPICIOUS = 'xmrig, minerd, cpuminer, .sh.x, wallet.dat, mining';

async function getSettings() {
    const conn = await db.getConnection();
    const rows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('ptero_url', 'ptero_client_api_key', 'radar_enabled', 'radar_suspicious_files', 'radar_ignore_files', 'radar_discord_alerts')");
    conn.release();

    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    return settings;
}

// Parse comma-separated string into array
function parseList(str) {
    if (!str) return [];
    return str.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
}

// Client API Helper
function getClientApi(url, key) {
    if (url.endsWith('/')) url = url.slice(0, -1);
    return axios.create({
        baseURL: url + '/api/client',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        timeout: 5000
    });
}

module.exports = {
    DEFAULT_THRESHOLDS,

    /**
     * Recursively scan directories for suspicious files
     */
    async scanDirectory(clientApi, serverId, directory, suspiciousFiles, ignorePatterns, foundFiles = [], depth = 0) {
        // Limit recursion depth to prevent infinite loops
        if (depth > 3) return foundFiles;

        try {
            const resFiles = await clientApi.get(`/servers/${serverId}/files/list?directory=${encodeURIComponent(directory)}`);
            const files = resFiles.data.data;

            for (const file of files) {
                const name = file.attributes.name.toLowerCase();
                const fullPath = directory === '/' ? `/${file.attributes.name}` : `${directory}/${file.attributes.name}`;

                // Skip if matches ignore pattern
                const shouldIgnore = ignorePatterns.some(pattern => name.includes(pattern));
                if (shouldIgnore) continue;

                // Check against suspicious patterns
                if (suspiciousFiles.some(bad => name.includes(bad))) {
                    foundFiles.push(fullPath);
                }

                // Recursively scan directories
                if (file.attributes.is_file === false) {
                    // Skip common non-useful directories to save time
                    const skipDirs = ['node_modules', '.git', 'vendor', 'cache', '.cache', 'logs'];
                    if (!skipDirs.includes(name)) {
                        await this.scanDirectory(clientApi, serverId, fullPath, suspiciousFiles, ignorePatterns, foundFiles, depth + 1);
                    }
                }
            }
        } catch (err) {
            // Directory might not exist or be accessible - that's ok
            if (!err.message.includes('404')) {
                console.error(`[Radar] Error scanning ${directory}:`, err.message);
            }
        }

        return foundFiles;
    },

    /**
     * Scan a single server for abuse
     */
    async scanServer(server, clientApi, suspiciousFiles, ignorePatterns) {
        let status = 'safe';
        let details = { cpu: 0, disk: 0, ram: 0, suspicious_files: [] };

        try {
            // 1. Check Resources
            console.log(`[Radar] Checking resources for server ${server.ptero_identifier}...`);
            const resStats = await clientApi.get(`/servers/${server.ptero_identifier}/resources`);
            const stats = resStats.data.attributes;

            details.cpu = stats.resources.cpu_absolute || 0;

            // Handle disk calculation safely
            if (stats.resources.disk_bytes && stats.meta && stats.meta.disk_bytes) {
                details.disk = (stats.resources.disk_bytes / stats.meta.disk_bytes) * 100;
            } else {
                details.disk = 0;
            }

            // Handle RAM calculation safely
            if (stats.resources.memory_bytes && stats.meta && stats.meta.memory_bytes) {
                details.ram = (stats.resources.memory_bytes / stats.meta.memory_bytes) * 100;
            } else {
                details.ram = 0;
            }

            console.log(`[Radar] Server ${server.id}: CPU=${details.cpu.toFixed(1)}%, Disk=${details.disk.toFixed(1)}%, RAM=${details.ram.toFixed(1)}%`);

            // Heuristics: CPU/Disk
            if (details.cpu > DEFAULT_THRESHOLDS.cpu.danger) status = 'danger';
            else if (details.cpu > DEFAULT_THRESHOLDS.cpu.warn && status !== 'danger') status = 'warning';

            if (details.disk > DEFAULT_THRESHOLDS.disk.danger) status = 'danger';
            else if (details.disk > DEFAULT_THRESHOLDS.disk.warn && status !== 'danger') status = 'warning';

            // 2. Scan files recursively from root
            console.log(`[Radar] Scanning files for server ${server.ptero_identifier}...`);
            const foundSuspicious = await this.scanDirectory(clientApi, server.ptero_identifier, '/', suspiciousFiles, ignorePatterns);

            if (foundSuspicious.length > 0) {
                status = 'danger';
                details.suspicious_files = foundSuspicious;
                console.log(`[Radar] Found ${foundSuspicious.length} suspicious files: ${foundSuspicious.join(', ')}`);
            }

            return { status, details };

        } catch (err) {
            console.error(`[Radar] Failed to scan server ${server.id}:`, err.message);
            return { status: 'safe', details: { error: err.message } };
        }
    },

    /**
     * Run scan on all active servers
     */
    async scanAll() {
        // SECURITY: If DB is locked, this function should fail silently or securely.
        let settings;
        try {
            settings = await getSettings();
        } catch (err) {
            // If DB key is invalid (Lockout), we stop here.
            // "Obfuscated" behavior: just stop.
            return;
        }

        console.log('[Radar] Starting scan...'); // Minimal logging

        console.log('[Radar] Config:', {
            enabled: settings.radar_enabled,
            suspicious_files: '***' // Obfuscate sensitive info in logs
        });

        // Check if radar is enabled (default to DISABLED if not set)
        if (settings.radar_enabled !== 'true') {
            console.log('[Radar] Radar is disabled. Skipping scan.');
            return;
        }

        if (!settings.ptero_client_api_key || !settings.ptero_url) {
            console.error('[Radar] Missing Client API Key or URL. Aborting.');
            console.error('[Radar] Please set the "Pterodactyl Client API Key" in Admin > Settings.');
            console.error('[Radar] This key should be from an admin account in Pterodactyl Panel that has access to all servers.');
            return;
        }

        // Parse settings
        const suspiciousFiles = parseList(settings.radar_suspicious_files || DEFAULT_SUSPICIOUS);
        const ignorePatterns = parseList(settings.radar_ignore_files);
        const discordAlertsEnabled = settings.radar_discord_alerts === 'true';

        console.log('[Radar] Suspicious patterns:', suspiciousFiles);
        console.log('[Radar] Ignore patterns:', ignorePatterns);

        const clientApi = getClientApi(settings.ptero_url, settings.ptero_client_api_key);
        let conn;
        try {
            conn = await db.getConnection();
            const servers = await conn.query("SELECT * FROM active_servers WHERE status = 'active'");
            console.log(`[Radar] Scanning ${servers.length} servers...`);

            for (const server of servers) {
                if (!server.ptero_identifier) continue;

                const result = await module.exports.scanServer(server, clientApi, suspiciousFiles, ignorePatterns);

                // Update DB
                await conn.query("UPDATE active_servers SET radar_status = ?, radar_last_scan = NOW(), radar_details = ? WHERE id = ?",
                    [result.status, JSON.stringify(result.details), server.id]);

                // Handle Warning or Danger
                if (result.status === 'warning' || result.status === 'danger') {
                    // Send Discord Alert if enabled
                    if (discordAlertsEnabled) {
                        try {
                            const user = await conn.query("SELECT * FROM users WHERE id = ?", [server.user_id]);
                            await discord.radarAlert(server, user[0], result.details, result.status);
                        } catch (e) {
                            // Silent fail
                        }
                    }

                    // Auto-Suspend only for DANGER
                    if (result.status === 'danger') {
                        try {
                            await pteroService.suspendServer(server.ptero_server_id);
                            await conn.query("UPDATE active_servers SET status = 'suspended' WHERE id = ?", [server.id]);
                            console.log(`[Radar] Auto-suspended server #${server.id}`);
                        } catch (e) {
                            // Silent fail
                        }
                    }
                }
            }
        } catch (err) {
            // "Obfuscated" error handling - don't leak details if it's a security lock
            if (err.message !== "KEY_MISMATCH") {
                console.error('[Radar] Scan error.');
            }
        } finally {
            if (conn) conn.release();
        }
    }
};
