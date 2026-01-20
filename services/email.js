const nodemailer = require('nodemailer');
const db = require('../config/database');
const ejs = require('ejs');
const path = require('path');

// Cache settings briefly or fetch every time? Fetching every time ensures updates apply immediately.
// Since sending email is rare/async, DB hit is negligible.

async function getTransporter() {
    let settings = {};
    try {
        const conn = await db.getConnection();
        const rows = await conn.query("SELECT * FROM settings WHERE setting_key LIKE 'smtp_%'");
        conn.release();
        rows.forEach(row => {
            settings[row.setting_key] = row.setting_value;
        });
    } catch (err) {
        console.error("Failed to fetch SMTP settings from DB:", err);
    }

    // Fallback to Env if DB is missing (optional, but good for transition)
    const host = settings.smtp_host || process.env.EMAIL_HOST;
    const port = settings.smtp_port || process.env.EMAIL_PORT || 587;
    const user = settings.smtp_user || process.env.EMAIL_USER;
    const pass = settings.smtp_pass || process.env.EMAIL_PASS;
    const secure = settings.smtp_secure === 'true' || false;
    const from = settings.smtp_from || process.env.EMAIL_FROM || 'no-reply@afernactyl.com';

    if (!host || !user || !pass) {
        console.warn("SMTP settings missing in DB and Env.");
        return null; // Or throw error
    }

    return {
        transporter: nodemailer.createTransport({
            host: host,
            port: parseInt(port),
            secure: secure,
            auth: { user, pass }
        }),
        from: from
    };
}

module.exports = {
    /**
 * Send an email using a template
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} templateName - Name of the template in views/emails/ (e.g. 'verify', 'reset')
 * @param {object} data - Data to pass to the template
 * @param {string} rawHtml - Optional raw HTML to send instead of template
 */
    sendEmail: async (to, subject, templateName, data, rawHtml = null) => {
        try {
            const config = await getTransporter();
            if (!config) {
                console.error("Cannot send email: SMTP not configured.");
                return;
            }

            let fullHtml;

            if (rawHtml) {
                // Use raw HTML directly (for broadcast emails)
                fullHtml = rawHtml;
            } else {
                // Fetch site_name for branding
                let site_name = 'Dashboard';
                try {
                    const conn = await db.getConnection();
                    const rows = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'site_name'");
                    conn.release();
                    if (rows.length > 0 && rows[0].setting_value) {
                        site_name = rows[0].setting_value;
                    }
                } catch (err) {
                    console.error("Failed to fetch site_name:", err);
                }

                // Render the specific template body
                const bodyPath = path.join(__dirname, '../views/emails', `${templateName}.ejs`);
                const bodyHtml = await ejs.renderFile(bodyPath, { ...data, site_name });

                // Render the layout with the body
                const layoutPath = path.join(__dirname, '../views/emails/layout.ejs');
                fullHtml = await ejs.renderFile(layoutPath, { body: bodyHtml, subject: subject, site_name });
            }

            // Send
            const info = await config.transporter.sendMail({
                from: config.from,
                to: to,
                subject: subject,
                html: fullHtml
            });
            console.log("Message sent: %s", info.messageId);
            return info;
        } catch (error) {
            console.error("Error sending email:", error);
        }
    },

    /**
     * Send invoice created notification email
     * @param {object} user - User object with email and username
     * @param {object} invoice - Invoice data
     */
    sendInvoiceCreatedEmail: async (user, invoice) => {
        try {
            const config = await getTransporter();
            if (!config) {
                console.error("Cannot send email: SMTP not configured.");
                return;
            }

            // Fetch site_name for branding
            let site_name = 'Dashboard';
            let site_url = process.env.SITE_URL || 'http://localhost:3000';
            try {
                const conn = await db.getConnection();
                const rows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('site_name', 'site_url')");
                conn.release();
                rows.forEach(row => {
                    if (row.setting_key === 'site_name' && row.setting_value) site_name = row.setting_value;
                    if (row.setting_key === 'site_url' && row.setting_value) site_url = row.setting_value;
                });
            } catch (err) {
                console.error("Failed to fetch site settings:", err);
            }

            // Render the invoice_created template
            const bodyPath = path.join(__dirname, '../views/emails', 'invoice_created.ejs');
            const bodyHtml = await ejs.renderFile(bodyPath, {
                user,
                invoice,
                site_name,
                site_url,
                pay_url: `${site_url}/dashboard/invoices/${invoice.id}/pay`
            });

            // Render the layout with the body
            const layoutPath = path.join(__dirname, '../views/emails/layout.ejs');
            const fullHtml = await ejs.renderFile(layoutPath, {
                body: bodyHtml,
                subject: `Invoice #${invoice.id} Created`,
                site_name
            });

            // Send
            const info = await config.transporter.sendMail({
                from: config.from,
                to: user.email,
                subject: `[${site_name}] Invoice #${invoice.id} - Payment Required`,
                html: fullHtml
            });
            console.log("Invoice email sent: %s", info.messageId);
            return info;
        } catch (error) {
            console.error("Error sending invoice email:", error);
        }
    },

    /**
     * Send server cancelled notification email
     * @param {object} user - User object with email and username
     * @param {object} server - Server data (server_name)
     * @param {string} reason - Optional cancellation reason
     */
    sendServerCancelledEmail: async (user, server, reason = null) => {
        try {
            const config = await getTransporter();
            if (!config) {
                console.error("Cannot send email: SMTP not configured.");
                return;
            }

            let site_name = 'Dashboard';
            let site_url = process.env.SITE_URL || 'http://localhost:3000';
            try {
                const conn = await db.getConnection();
                const rows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('site_name', 'site_url')");
                conn.release();
                rows.forEach(row => {
                    if (row.setting_key === 'site_name' && row.setting_value) site_name = row.setting_value;
                    if (row.setting_key === 'site_url' && row.setting_value) site_url = row.setting_value;
                });
            } catch (err) {
                console.error("Failed to fetch site settings:", err);
            }

            const bodyPath = path.join(__dirname, '../views/emails', 'server_cancelled.ejs');
            const bodyHtml = await ejs.renderFile(bodyPath, { user, server, reason, site_name, site_url });

            const layoutPath = path.join(__dirname, '../views/emails/layout.ejs');
            const fullHtml = await ejs.renderFile(layoutPath, {
                body: bodyHtml,
                subject: `Server Cancelled - ${server.server_name}`,
                site_name
            });

            const info = await config.transporter.sendMail({
                from: config.from,
                to: user.email,
                subject: `[${site_name}] Server Cancelled - ${server.server_name}`,
                html: fullHtml
            });
            console.log("Server cancelled email sent: %s", info.messageId);
            return info;
        } catch (error) {
            console.error("Error sending server cancelled email:", error);
        }
    },

    /**
     * Send ticket reply notification email
     * @param {object} user - User object with email and username
     * @param {object} ticket - Ticket data (id, subject)
     * @param {string} replyContent - The reply message content
     * @param {boolean} isAdmin - Whether the reply is from admin
     */
    sendTicketReplyEmail: async (user, ticket, replyContent, isAdmin = false) => {
        try {
            const config = await getTransporter();
            if (!config) {
                console.error("Cannot send email: SMTP not configured.");
                return;
            }

            let site_name = 'Dashboard';
            let site_url = process.env.SITE_URL || 'http://localhost:3000';
            try {
                const conn = await db.getConnection();
                const rows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('site_name', 'site_url')");
                conn.release();
                rows.forEach(row => {
                    if (row.setting_key === 'site_name' && row.setting_value) site_name = row.setting_value;
                    if (row.setting_key === 'site_url' && row.setting_value) site_url = row.setting_value;
                });
            } catch (err) {
                console.error("Failed to fetch site settings:", err);
            }

            const bodyPath = path.join(__dirname, '../views/emails', 'ticket_reply.ejs');
            const bodyHtml = await ejs.renderFile(bodyPath, { user, ticket, replyContent, isAdmin, site_name, site_url });

            const layoutPath = path.join(__dirname, '../views/emails/layout.ejs');
            const fullHtml = await ejs.renderFile(layoutPath, {
                body: bodyHtml,
                subject: `New Reply on Ticket #${ticket.id}`,
                site_name
            });

            const info = await config.transporter.sendMail({
                from: config.from,
                to: user.email,
                subject: `[${site_name}] New Reply on Ticket #${ticket.id} - ${ticket.subject}`,
                html: fullHtml
            });
            console.log("Ticket reply email sent: %s", info.messageId);
            return info;
        } catch (error) {
            console.error("Error sending ticket reply email:", error);
        }
    }
};
