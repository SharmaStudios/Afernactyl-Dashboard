const axios = require('axios');
require('dotenv').config();

async function test() {
    const client = axios.create({
        baseURL: 'https://panel.leoxstudios.com/api/application',
        headers: {
            'Authorization': 'Bearer ptla_W1FcU6ci6bYGVbgjSjhw6mCGAgh9Lyy49yiqyNXpLfb',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    // Try different nests with egg 45 with include=variables
    for (let nestId = 1; nestId <= 10; nestId++) {
        try {
            const egg = await client.get(`/nests/${nestId}/eggs/45?include=variables`);
            console.log(`\n=== FOUND EGG 45 IN NEST ${nestId} ===`);
            console.log('Keys in data:', Object.keys(egg.data));
            console.log('Has relationships?', !!egg.data.relationships);
            if (egg.data.relationships) {
                console.log('Relationships keys:', Object.keys(egg.data.relationships));
                if (egg.data.relationships.variables) {
                    console.log('Variables count:', egg.data.relationships.variables.data.length);
                    console.log('First 2 variables:', JSON.stringify(egg.data.relationships.variables.data.slice(0, 2), null, 2));
                }
            }
            console.log('\n=== ATTRIBUTES ===');
            console.log('startup:', egg.data.attributes.startup);
            console.log('docker_images:', JSON.stringify(egg.data.attributes.docker_images));
            break;
        } catch (e) {
            // Not found in this nest, continue
        }
    }
}

test().catch(e => console.error('Error:', e.message));

module.exports = test;
