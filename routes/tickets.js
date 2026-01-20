const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const db = require('../config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure Multer
const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'attachment-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
}).single('attachment');

function checkFileType(file, cb) {
    // Allowed extensions
    const filetypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|zip|rar|webp/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    // Allowed MIME types
    const allowedMimes = [
        'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'application/zip', 'application/x-rar-compressed', 'application/x-zip-compressed'
    ];
    const validMime = allowedMimes.includes(file.mimetype);

    if (validMime && extname) {
        return cb(null, true);
    } else {
        cb('Error: Only images, PDFs, documents, and ZIP files are allowed!');
    }
}

router.use(ensureAuthenticated);

// List Tickets
router.get('/', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const tickets = await conn.query("SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC", [req.session.user.id]);
        conn.release();
        res.render('dashboard/tickets/index', { tickets });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
    }
});

// Create Page
router.get('/create', (req, res) => {
    res.render('dashboard/tickets/create');
});

// Process Create
router.post('/create', async (req, res) => {
    const { subject, message } = req.body;
    try {
        const conn = await db.getConnection();
        const result = await conn.query("INSERT INTO tickets (user_id, subject) VALUES (?, ?)", [req.session.user.id, subject]);
        const ticketId = Number(result.insertId);

        await conn.query("INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)",
            [ticketId, req.session.user.id, message]);

        conn.release();

        // Discord notification
        try {
            const discord = require('../services/discord');
            await discord.newTicket({ id: ticketId, subject }, { username: req.session.user.username });
        } catch (e) { console.error('[Discord]', e.message); }

        res.redirect('/dashboard/tickets');
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard/tickets/create');
    }
});

// View Ticket
router.get('/:id', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const ticketId = req.params.id;
        const userId = req.session.user.id;
        const isAdmin = !!req.session.user.is_admin;

        // Fetch ticket by ID only first
        const ticket = await conn.query("SELECT * FROM tickets WHERE id = ?", [ticketId]);

        if (ticket.length === 0) {
            req.flash('error_msg', 'Ticket not found.');
            return res.redirect('/dashboard/tickets');
        }

        // Permission Check
        if (!isAdmin && ticket[0].user_id !== userId) {
            req.flash('error_msg', 'Unauthorized access to this ticket.');
            return res.redirect('/dashboard/tickets');
        }

        // Fetch Messages
        const messagesRaw = await conn.query(`
            SELECT tm.*, u.username, u.email, u.is_admin 
            FROM ticket_messages tm 
            JOIN users u ON tm.user_id = u.id 
            WHERE tm.ticket_id = ? 
            ORDER BY tm.created_at ASC`, [ticketId]);

        const crypto = require('crypto');
        const messages = messagesRaw.map(msg => ({
            ...msg,
            gravatar: 'https://www.gravatar.com/avatar/' + crypto.createHash('md5').update(msg.email.trim().toLowerCase()).digest('hex')
        }));

        // Fetch Canned Responses (if Admin)
        let canned = [];
        if (isAdmin) {
            canned = await conn.query("SELECT * FROM canned_responses");
            console.log(`[TicketView] Admin detected. Fetched ${canned.length} canned responses.`);
        } else {
            console.log(`[TicketView] Not Admin. Skiping canned responses.`);
        }

        res.render('dashboard/tickets/view', {
            ticket: ticket[0],
            messages,
            canned
        });

    } catch (err) {
        console.error("[TicketView Error]", err);
        req.flash('error_msg', 'Server error loading ticket.');
        res.redirect('/dashboard/tickets');
    } finally {
        if (conn) conn.release();
    }
});

// Reply with Attachment
router.post('/:id/reply', async (req, res) => {
    upload(req, res, async (err) => {
        const ticketId = req.params.id;
        if (err) {
            req.flash('error_msg', err);
            return res.redirect('/dashboard/tickets/' + ticketId);
        }

        const message = req.body.message;
        const attachment = req.file ? '/uploads/' + req.file.filename : null;

        if (!message && !attachment) {
            req.flash('error_msg', 'Message or attachment required.');
            return res.redirect('/dashboard/tickets/' + ticketId);
        }

        let conn;
        try {
            conn = await db.getConnection();

            // Re-verify existence & perm (safer)
            const ticket = await conn.query("SELECT t.*, u.email, u.username FROM tickets t JOIN users u ON t.user_id = u.id WHERE t.id = ?", [ticketId]);
            const isAdmin = !!req.session.user.is_admin;

            if (ticket.length > 0) {
                if (isAdmin || ticket[0].user_id === req.session.user.id) {
                    await conn.query("INSERT INTO ticket_messages (ticket_id, user_id, message, attachment) VALUES (?, ?, ?, ?)",
                        [ticketId, req.session.user.id, message || '', attachment]);

                    // Update ticket status based on who replied
                    if (isAdmin) {
                        // Admin replied -> awaiting customer response
                        await conn.query("UPDATE tickets SET status = 'awaiting_customer' WHERE id = ?", [ticketId]);

                        // Send email to ticket owner
                        try {
                            const emailService = require('../services/email');
                            await emailService.sendTicketReplyEmail(
                                { email: ticket[0].email, username: ticket[0].username },
                                { id: ticketId, subject: ticket[0].subject },
                                message || 'New attachment added',
                                true
                            );
                            console.log('[Ticket Reply] Email sent to user:', ticket[0].email);
                        } catch (emailErr) {
                            console.error('[Ticket Reply] Failed to send email:', emailErr.message);
                        }

                        // Discord notification
                        try {
                            const discord = require('../services/discord');
                            await discord.ticketReply({ id: ticketId, subject: ticket[0].subject }, { username: req.session.user.username }, true);
                        } catch (e) { console.error('[Discord]', e.message); }
                    } else {
                        // User replied -> awaiting admin reply
                        await conn.query("UPDATE tickets SET status = 'awaiting_reply' WHERE id = ?", [ticketId]);

                        // Discord notification
                        try {
                            const discord = require('../services/discord');
                            await discord.ticketReply({ id: ticketId, subject: ticket[0].subject }, { username: req.session.user.username }, false);
                        } catch (e) { console.error('[Discord]', e.message); }
                    }
                }
            }
            res.redirect('/dashboard/tickets/' + ticketId);
        } catch (err) {
            console.error(err);
            res.redirect('/dashboard/tickets');
        } finally {
            if (conn) conn.release();
        }
    });
});

// Update Status (Close/Open)
router.post('/:id/status', async (req, res) => {
    const { status } = req.body;
    let conn;
    try {
        conn = await db.getConnection();
        const isAdmin = !!req.session.user.is_admin;
        const ticket = await conn.query("SELECT * FROM tickets WHERE id = ?", [req.params.id]);

        if (ticket.length > 0) {
            // Permission check
            if (!isAdmin && ticket[0].user_id !== req.session.user.id) {
                return res.redirect('/dashboard/tickets/' + req.params.id);
            }
            // User can't reopen
            if (status === 'open' && !isAdmin) {
                return res.redirect('/dashboard/tickets/' + req.params.id);
            }

            await conn.query("UPDATE tickets SET status = ? WHERE id = ?", [status, req.params.id]);

            const actionMsg = status === 'closed' ? 'Closed the ticket.' : 'Reopened the ticket.';
            await conn.query("INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)",
                [req.params.id, req.session.user.id, `[System]: ${actionMsg}`]);
        }
        res.redirect('/dashboard/tickets/' + req.params.id);
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard/tickets');
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;
