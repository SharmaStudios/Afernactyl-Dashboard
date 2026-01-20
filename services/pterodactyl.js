const axios = require('axios');
const db = require('../config/database');
require('dotenv').config();

// In-memory logs for Debug Page
const debugLogs = [];

function addLog(type, message, data = null) {
    debugLogs.unshift({
        type,
        message,
        data: data ? JSON.stringify(data, null, 2) : null,
        timestamp: new Date()
    });
    // Keep last 50 logs
    if (debugLogs.length > 50) debugLogs.pop();
}

async function getClient() {
    let url = process.env.PTERODACTYL_URL;
    let key = process.env.PTERODACTYL_APP_API_KEY;
    let debugMode = 'false';

    try {
        const conn = await db.getConnection();
        const settings = await conn.query("SELECT * FROM settings WHERE setting_key IN ('ptero_url', 'ptero_key', 'debug_mode')");
        conn.release();

        const pteroUrl = settings.find(s => s.setting_key === 'ptero_url');
        const pteroKey = settings.find(s => s.setting_key === 'ptero_key');
        const debugSetting = settings.find(s => s.setting_key === 'debug_mode');

        if (pteroUrl && pteroUrl.setting_value) url = pteroUrl.setting_value;
        if (pteroKey && pteroKey.setting_value) key = pteroKey.setting_value;
        if (debugSetting && debugSetting.setting_value) debugMode = debugSetting.setting_value;

    } catch (e) {
        console.error("Error fetching Ptero settings, using env backup:", e.message);
    }

    // Remove trailing slash if present
    if (url && url.endsWith('/')) url = url.slice(0, -1);

    const client = axios.create({
        baseURL: url + '/api/application',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    if (debugMode === 'true') {
        client.interceptors.request.use(request => {
            const msg = `${request.method.toUpperCase()} ${request.url}`;
            console.log(`[Ptero Debug] ${msg}`);
            addLog('REQUEST', msg, request.data);
            return request;
        });

        client.interceptors.response.use(response => {
            const msg = `${response.status} ${response.statusText}`;
            console.log(`[Ptero Debug] ${msg}`);
            addLog('RESPONSE', msg);
            return response;
        }, error => {
            const msg = error.message;
            const data = error.response ? error.response.data : null;
            console.error(`[Ptero Debug] ERROR:`, msg);
            addLog('ERROR', msg, data);
            return Promise.reject(error);
        });
    }

    return client;
}

module.exports = {
    getClient,
    getLogs: () => debugLogs,
    checkConnection: async () => {
        try {
            const client = await getClient();
            await client.get('/nodes');
            return true;
        } catch (error) {
            console.error('Pterodactyl Connection Error:', error.message);
            return false;
        }
    },

    // Fetch Data
    getNests: async () => {
        const client = await getClient();
        const res = await client.get('/nests');
        return res.data.data.map(item => item.attributes);
    },

    getEggs: async (nestId) => {
        const client = await getClient();
        const res = await client.get(`/nests/${nestId}/eggs`);
        return res.data.data.map(item => item.attributes);
    },

    // Get specific egg with variables
    getEggDetails: async (nestId, eggId) => {
        const client = await getClient();
        const res = await client.get(`/nests/${nestId}/eggs/${eggId}?include=variables`);
        return res.data.attributes;
    },

    getLocations: async () => {
        const client = await getClient();
        const res = await client.get('/locations');
        return res.data.data.map(item => item.attributes);
    },

    getNodes: async () => {
        const client = await getClient();
        const res = await client.get('/nodes');
        return res.data.data.map(item => item.attributes);
    },

    createUser: async (user, password) => {
        try {
            const client = await getClient();
            const response = await client.post('/users', {
                email: user.email,
                username: user.username,
                first_name: user.username,
                last_name: 'User',
                password: password,
                root_admin: false,
                language: 'en'
            });
            return response.data.attributes;
        } catch (error) {
            console.error('Create Ptero User Error:', error.response ? error.response.data : error.message);
            throw error;
        }
    },

    // Get User by Email (to check existence)
    getUser: async (email) => {
        try {
            const client = await getClient();
            const response = await client.get(`/users?filter[email]=${encodeURIComponent(email)}`);
            if (response.data.data.length > 0) {
                return response.data.data[0].attributes;
            }
            return null;
        } catch (error) {
            console.error('Get Ptero User Error:', error.message);
            return null;
        }
    },

    // Update User Password on Pterodactyl
    updateUserPassword: async (pteroUserId, newPassword) => {
        try {
            const client = await getClient();
            // First get the user to get their current details
            const userRes = await client.get(`/users/${pteroUserId}`);
            const user = userRes.data.attributes;

            // Update the user with new password (PATCH requires all fields)
            const response = await client.patch(`/users/${pteroUserId}`, {
                email: user.email,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                password: newPassword,
                language: user.language || 'en'
            });
            return { success: true, message: 'Password updated successfully' };
        } catch (error) {
            console.error('Update Ptero Password Error:', error.response ? error.response.data : error.message);
            throw error;
        }
    },

    createServer: async (serverConfig) => {
        try {
            const client = await getClient();
            let environment = {};
            let finalDockerImage = null;
            let finalStartup = null;

            // STRICT EGG SYNC: Fetch Egg Details
            if (serverConfig.nest_id && serverConfig.egg_id) {
                try {
                    const egg = await module.exports.getEggDetails(serverConfig.nest_id, serverConfig.egg_id);

                    // 1. Fetch Environment Variables (Attributes.relationships.variables.data)
                    // Note: getEggDetails uses ?include=variables. Ptero response structure is messy.
                    // We need to check if response.data.attributes includes relationships??
                    // getEggDetails returns res.data.attributes directly.
                    // Let's re-verify getEggDetails implementation. 
                    // It returns res.data.attributes. But variables are in res.data.relationships? No, standard Ptero API include.
                    // Actually, let's fetch strictly here to be safe and debuggable.

                    const eggClient = await getClient();
                    const eggRes = await eggClient.get(`/nests/${serverConfig.nest_id}/eggs/${serverConfig.egg_id}?include=variables`);
                    const eggData = eggRes.data.attributes;
                    const eggRel = eggRes.data.attributes.relationships || {};
                    // Wait, attributes usually doesn't contain relationships. Relationships are sibling to attributes in JSON:API.
                    // But Pterodactyl Application API often nests them or returns them in 'included'.
                    // Let's check typical Ptero response. It puts relationships INSIDE attributes for App API? No.
                    // Actually, let's look at `getEggDetails` implementation I wrote earlier.
                    // It returns `res.data.attributes`.

                    // Let's rely on `eggRes.data.attributes.docker_images` and `eggRes.data.attributes.startup`.
                    finalStartup = eggData.startup;

                    // Docker Images is an object { "Display Name": "image_url" }
                    const images = eggData.docker_images;
                    if (images && Object.keys(images).length > 0) {
                        // Get the first image URL (values, not keys)
                        finalDockerImage = Object.values(images)[0];
                    }

                    // Environment Variables - CORRECT PATH: attributes.relationships.variables.data
                    const varsRel = eggData.relationships?.variables;
                    if (varsRel && varsRel.data) {
                        varsRel.data.forEach(v => {
                            const attr = v.attributes;
                            if (attr && attr.env_variable) {
                                environment[attr.env_variable] = attr.default_value || '';
                            }
                        });
                    }
                    console.log('[Ptero Service] Fetched environment from Egg:', JSON.stringify(environment));

                } catch (e) {
                    console.error("Failed to fetch Egg strict details:", e.message);
                    throw new Error("Failed to fetch Egg details for server creation.");
                }
            }

            // LAYER 2: Apply Plan's saved environment config (admin customizations)
            if (serverConfig.environment_config) {
                try {
                    const planEnv = typeof serverConfig.environment_config === 'string'
                        ? JSON.parse(serverConfig.environment_config)
                        : serverConfig.environment_config;

                    for (const [key, config] of Object.entries(planEnv)) {
                        if (config.value !== undefined && config.value !== '') {
                            environment[key] = config.value;
                        }
                    }
                    console.log('[Ptero Service] Applied plan environment overrides');
                } catch (e) {
                    console.warn('[Ptero Service] Failed to parse plan environment_config:', e.message);
                }
            }

            // LAYER 3: Apply user checkout overrides (for user-visible vars)
            if (serverConfig.user_env_overrides) {
                for (const [key, value] of Object.entries(serverConfig.user_env_overrides)) {
                    if (value !== undefined && value !== '') {
                        environment[key] = value;
                    }
                }
                console.log('[Ptero Service] Applied user environment overrides:', Object.keys(serverConfig.user_env_overrides));
            }

            console.log('[Ptero Service] Final environment:', JSON.stringify(environment));

            // Fallback (Should not happen if Nest/Egg IDs are valid)
            if (!finalDockerImage) finalDockerImage = serverConfig.docker_image;
            if (!finalStartup) finalStartup = serverConfig.startup_cmd;

            const payload = {
                name: serverConfig.name,
                user: serverConfig.user_id,
                egg: serverConfig.egg_id,
                docker_image: finalDockerImage,
                startup: finalStartup,
                // Environment (Stringify values for safety)
                environment: Object.entries(environment).reduce((acc, [k, v]) => {
                    acc[k] = String(v);
                    return acc;
                }, {}),
                limits: {
                    memory: parseInt(serverConfig.ram),
                    swap: 0,
                    disk: parseInt(serverConfig.disk),
                    io: 500,
                    cpu: parseInt(serverConfig.cpu)
                },
                feature_limits: {
                    databases: serverConfig.db_count ?? 1,
                    // FIX: Allocations must be TOTAL (Primary + Extra). 
                    // If serverConfig.allocations is 0 (Extra), we must send 1.
                    allocations: (parseInt(serverConfig.allocations) || 0) + 1,
                    backups: serverConfig.backups ?? 0
                }
            };

            // Enhanced allocation logic
            if (serverConfig.location_id) {
                payload.deploy = {
                    locations: [parseInt(serverConfig.location_id)],
                    dedicated_ip: false,
                    port_range: []
                };
                // Pterodactyl REQUIRES port_range to be present (even if empty)
            } else {
                payload.allocation = { default: 0 };
            }

            console.log("[Ptero Service] Creating Server Payload:", JSON.stringify(payload, null, 2));

            const response = await client.post('/servers', payload);
            return response.data.attributes;
        } catch (error) {
            console.error('Create Server Error details:', error.response ? JSON.stringify(error.response.data) : error.message);
            throw error;
        }
    },

    async deleteServer(serverId) {
        const client = await getClient();
        try {
            await client.delete(`/servers/${serverId}`);
            return true;
        } catch (error) {
            console.error('Delete Server Error:', error.response ? JSON.stringify(error.response.data) : error.message);
            throw error;
        }
    },

    async suspendServer(serverId) {
        const client = await getClient();
        try {
            await client.post(`/servers/${serverId}/suspend`);
            return true;
        } catch (error) {
            console.error('Suspend Server Error:', error.response ? JSON.stringify(error.response.data) : error.message);
            throw error;
        }
    },

    async unsuspendServer(serverId) {
        const client = await getClient();
        try {
            await client.post(`/servers/${serverId}/unsuspend`);
            return true;
        } catch (error) {
            console.error('Unsuspend Server Error:', error.response ? JSON.stringify(error.response.data) : error.message);
            throw error;
        }
    },

    getAllServers: async () => {
        const client = await getClient();
        let allServers = [];
        let page = 1;
        let hasNext = true;

        while (hasNext) {
            try {
                const res = await client.get(`/servers?page=${page}`);
                const data = res.data.data.map(item => item.attributes);
                allServers = allServers.concat(data);

                if (res.data.meta && res.data.meta.pagination && res.data.meta.pagination.total_pages > page) {
                    page++;
                } else {
                    hasNext = false;
                }
            } catch (err) {
                console.error("[Ptero Service] Error fetching servers page " + page, err.message);
                hasNext = false;
            }
        }
        return allServers;
    }
};
