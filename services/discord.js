/**
 * Discord Webhook Service
 * Sends notifications to Discord for various events
 */

const db = require('../config/database');

// Discord embed colors
const COLORS = {
    info: 0x3b82f6,      // Blue
    success: 0x10b981,   // Green
    warning: 0xf59e0b,   // Orange
    danger: 0xef4444,    // Red
    purple: 0xa855f7     // Purple
};

/**
 * Get Discord webhook URL from settings
 */
async function getWebhookUrl() {
    try {
        const conn = await db.getConnection();
        const rows = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'discord_webhook_url'");
        conn.release();
        return rows.length > 0 ? rows[0].setting_value : null;
    } catch (err) {
        console.error('[Discord] Failed to get webhook URL:', err.message);
        return null;
    }
}

/**
 * Send a message to Discord webhook
 * @param {object} embed - Discord embed object
 */
async function sendWebhook(embed) {
    const webhookUrl = await getWebhookUrl();
    if (!webhookUrl) {
        return; // Silently fail if no webhook configured
    }

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'Afernactyl',
                avatar_url: 'https://www.iconarchive.com/download/i112250/fa-team/fontawesome/FontAwesome-Dragon.ico',
                embeds: [embed]
            })
        });

        if (!response.ok) {
            console.error('[Discord] Webhook failed:', response.status, await response.text());
        }
    } catch (err) {
        console.error('[Discord] Webhook error:', err.message);
    }
}

/**
 * Build a Discord embed
 */
function buildEmbed(title, description, color = COLORS.info, fields = []) {
    return {
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
        footer: {
            text: 'Afernactyl Dashboard'
        }
    };
}

module.exports = {
    // User Events
    async userRegistered(user) {
        await sendWebhook(buildEmbed(
            '👤 New User Registered',
            `**${user.username}** has registered`,
            COLORS.success,
            [
                { name: 'Email', value: user.email, inline: true },
                { name: 'User ID', value: String(user.id), inline: true }
            ]
        ));
    },

    async userRoleUpdated(user, newRole, adminName) {
        await sendWebhook(buildEmbed(
            '🔑 User Role Updated',
            `**${user.username}**'s role has been changed`,
            COLORS.warning,
            [
                { name: 'New Role', value: newRole ? 'Admin' : 'User', inline: true },
                { name: 'Changed By', value: adminName, inline: true }
            ]
        ));
    },

    // Ticket Events
    async newTicket(ticket, user) {
        await sendWebhook(buildEmbed(
            '🎫 New Support Ticket',
            `**${user.username}** opened a new ticket`,
            COLORS.info,
            [
                { name: 'Subject', value: ticket.subject, inline: false },
                { name: 'Ticket ID', value: `#${ticket.id}`, inline: true }
            ]
        ));
    },

    async ticketReply(ticket, user, isAdmin) {
        await sendWebhook(buildEmbed(
            isAdmin ? '💬 Admin Replied to Ticket' : '💬 Customer Replied to Ticket',
            `${isAdmin ? 'An admin' : `**${user.username}**`} replied to ticket #${ticket.id}`,
            isAdmin ? COLORS.purple : COLORS.info,
            [
                { name: 'Subject', value: ticket.subject, inline: false },
                { name: 'Ticket ID', value: `#${ticket.id}`, inline: true }
            ]
        ));
    },

    async ticketStatusChanged(ticket, newStatus, user) {
        await sendWebhook(buildEmbed(
            '📋 Ticket Status Updated',
            `Ticket #${ticket.id} status changed to **${newStatus}**`,
            COLORS.warning,
            [
                { name: 'Subject', value: ticket.subject, inline: false },
                { name: 'Changed By', value: user.username, inline: true }
            ]
        ));
    },

    // Invoice Events
    async newInvoice(invoice, user) {
        await sendWebhook(buildEmbed(
            '📄 New Invoice Created',
            `Invoice #${invoice.id} created for **${user.username}**`,
            COLORS.info,
            [
                { name: 'Amount', value: `$${parseFloat(invoice.amount).toFixed(2)}`, inline: true },
                { name: 'Description', value: invoice.description || 'N/A', inline: false }
            ]
        ));
    },

    async invoicePaid(invoice, user, paymentMethod, transactionId) {
        await sendWebhook(buildEmbed(
            '💰 Invoice Paid',
            `**${user.username}** paid invoice #${invoice.id}`,
            COLORS.success,
            [
                { name: 'Amount', value: `$${parseFloat(invoice.amount).toFixed(2)}`, inline: true },
                { name: 'Payment Method', value: paymentMethod || 'Unknown', inline: true },
                { name: 'Transaction ID', value: transactionId || 'N/A', inline: false }
            ]
        ));
    },

    // Plan Events
    async planPurchased(plan, user, server) {
        await sendWebhook(buildEmbed(
            '🛒 New Plan Purchased',
            `**${user.username}** purchased a plan`,
            COLORS.success,
            [
                { name: 'Plan', value: plan.name, inline: true },
                { name: 'Price', value: `$${parseFloat(plan.price).toFixed(2)}`, inline: true },
                { name: 'Server Name', value: server.server_name || 'N/A', inline: false }
            ]
        ));
    },

    async planCreated(plan, admin) {
        await sendWebhook(buildEmbed(
            '📦 New Plan Created',
            `Admin **${admin.username}** created a new plan`,
            COLORS.purple,
            [
                { name: 'Plan Name', value: plan.name, inline: true },
                { name: 'Price', value: `$${parseFloat(plan.price).toFixed(2)}/mo`, inline: true }
            ]
        ));
    },

    // Server Events
    async serverCancelled(server, user, reason) {
        await sendWebhook(buildEmbed(
            '❌ Server Cancelled',
            `Server **${server.server_name}** has been cancelled`,
            COLORS.danger,
            [
                { name: 'Owner', value: user.username, inline: true },
                { name: 'Reason', value: reason || 'Not specified', inline: false }
            ]
        ));
    },

    async serverDeleted(server, user, admin) {
        await sendWebhook(buildEmbed(
            '🗑️ Server Deleted',
            `Server **${server.server_name}** has been deleted`,
            COLORS.danger,
            [
                { name: 'Owner', value: user.username, inline: true },
                { name: 'Deleted By', value: admin.username, inline: true }
            ]
        ));
    },

    // Broadcast Events
    async broadcastSent(admin, subject, recipientType, sent, failed) {
        const typeLabels = {
            'all': 'All Users',
            'active': 'Active Server Owners',
            'admins': 'Admins Only'
        };
        await sendWebhook(buildEmbed(
            '📧 Email Broadcast Sent',
            `**${admin.username}** sent a broadcast email`,
            COLORS.info,
            [
                { name: 'Subject', value: subject, inline: false },
                { name: 'Recipients', value: typeLabels[recipientType] || recipientType, inline: true },
                { name: 'Sent', value: String(sent), inline: true },
                { name: 'Failed', value: String(failed), inline: true }
            ]
        ));
    },

    // Server Creation Failed Event
    async serverCreationFailed(user, plan, error, transactionId) {
        await sendWebhook(buildEmbed(
            '🚨 SERVER CREATION FAILED',
            `Payment received but server creation failed for **${user.username}**`,
            COLORS.danger,
            [
                { name: 'User', value: user.username, inline: true },
                { name: 'Email', value: user.email, inline: true },
                { name: 'Plan', value: plan.name, inline: true },
                { name: 'Transaction ID', value: transactionId || 'N/A', inline: true },
                { name: 'Error', value: error.substring(0, 200), inline: false },
                { name: 'Action Required', value: 'Plan marked out of stock. User expects resolution within 24 hours.', inline: false }
            ]
        ));
    },

    // Funds Added Event
    async fundsAdded(user, amount, method, transactionId) {
        await sendWebhook(buildEmbed(
            '💰 Funds Added',
            `**${user.username}** added funds to their account`,
            COLORS.success,
            [
                { name: 'Amount', value: `$${parseFloat(amount).toFixed(2)}`, inline: true },
                { name: 'Payment Method', value: method || 'Unknown', inline: true },
                { name: 'Transaction ID', value: transactionId || 'N/A', inline: false },
                { name: 'New Balance', value: `$${parseFloat(user.balance).toFixed(2)}`, inline: true }
            ]
        ));
    },

    // Radar Alert Event
    async radarAlert(server, user, details, status) {
        const color = status === 'danger' ? COLORS.danger : COLORS.warning;
        const icon = status === 'danger' ? '🚨' : '⚠️';
        const fields = [
            { name: 'Server', value: server.server_name || `#${server.id}`, inline: true },
            { name: 'Owner', value: user?.username || 'Unknown', inline: true },
            { name: 'Status', value: status.toUpperCase(), inline: true }
        ];

        if (details.cpu) fields.push({ name: 'CPU Usage', value: `${details.cpu.toFixed(1)}%`, inline: true });
        if (details.ram) fields.push({ name: 'RAM Usage', value: `${details.ram.toFixed(1)}%`, inline: true });
        if (details.disk) fields.push({ name: 'Disk Usage', value: `${details.disk.toFixed(1)}%`, inline: true });
        if (details.suspicious_files?.length > 0) {
            fields.push({ name: 'Suspicious Files', value: details.suspicious_files.join(', ').substring(0, 200), inline: false });
        }

        await sendWebhook(buildEmbed(
            `${icon} Radar Alert: ${status.toUpperCase()}`,
            `Suspicious activity detected on server **${server.server_name}**`,
            color,
            fields
        ));
    }
};
