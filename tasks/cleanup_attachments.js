/**
 * Task: Cleanup Old Ticket Attachments
 * Deletes attachment files older than 7 days
 */

const fs = require('fs').promises;
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '../public/uploads');
const MAX_AGE_DAYS = 7;

async function cleanupOldAttachments() {
    console.log('[Cleanup Attachments] Starting cleanup of old attachments...');

    try {
        const files = await fs.readdir(UPLOADS_DIR);
        const now = Date.now();
        const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

        let deletedCount = 0;
        let errorCount = 0;

        for (const file of files) {
            // Only process attachment files
            if (!file.startsWith('attachment-')) continue;

            const filePath = path.join(UPLOADS_DIR, file);

            try {
                const stats = await fs.stat(filePath);
                const fileAge = now - stats.mtimeMs;

                if (fileAge > maxAgeMs) {
                    await fs.unlink(filePath);
                    deletedCount++;
                    console.log(`[Cleanup Attachments] Deleted: ${file} (${Math.floor(fileAge / (24 * 60 * 60 * 1000))} days old)`);
                }
            } catch (fileErr) {
                errorCount++;
                console.error(`[Cleanup Attachments] Error processing ${file}:`, fileErr.message);
            }
        }

        console.log(`[Cleanup Attachments] Cleanup complete. Deleted: ${deletedCount} files, Errors: ${errorCount}`);
        return { deleted: deletedCount, errors: errorCount };

    } catch (err) {
        console.error('[Cleanup Attachments] Error reading uploads directory:', err.message);
        return { deleted: 0, errors: 1 };
    }
}

module.exports = cleanupOldAttachments;
