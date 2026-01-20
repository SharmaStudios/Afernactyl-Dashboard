const radar = require('../services/radar');

async function run() {
    try {
        await radar.scanAll();
    } catch (err) {
        console.error('[Task] Radar scan failed:', err);
    }
}

module.exports = run;
