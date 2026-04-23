import fs from 'fs';
import path from 'path';

const EMAILS_DIR = 'public/emails';
const OUTPUT_DIR = 'public';

// Limits for Roundcube Elastic stability and Cloudflare Pages (25MB)
const MAX_FILES_PER_REPO = 2000;
const MAX_JSON_BYTES = 18 * 1024 * 1024; // 18 MB safe margin

function exactJsonBytes(emails) {
    if (emails.length === 0) return 0;
    return Buffer.byteLength(JSON.stringify(emails), 'utf8');
}

function groupEmailsByYearMonth(emails) {
    const byYearMonth = new Map();
    for (const email of emails) {
        const d = new Date(email.date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!byYearMonth.has(key)) byYearMonth.set(key, []);
        byYearMonth.get(key).push(email);
    }
    return byYearMonth;
}

function buildRepoChunks(byYearMonth) {
    const sortedKeys = [...byYearMonth.keys()].sort();
    const intermediateChunks = [];
    
    let currentGroup = { emails: [], keys: [] };
    let currentGroupBytes = 0;

    for (const key of sortedKeys) {
        const keyEmails = byYearMonth.get(key);
        const keyBytes = exactJsonBytes(keyEmails);

        // If a single month is over the limit, it MUST be split internally
        if (keyBytes > MAX_JSON_BYTES) {
            // Push any pending group first
            if (currentGroup.emails.length > 0) {
                intermediateChunks.push(currentGroup);
                currentGroup = { emails: [], keys: [] };
                currentGroupBytes = 0;
            }

            // Split this oversized month into numbered sub-chunks
            let subIdx = 1;
            let subEmails = [];
            let subBytes = 2; // Account for [] in JSON

            for (const email of keyEmails) {
                const emailBytes = Buffer.byteLength(JSON.stringify(email), 'utf8') + 1; // approx with comma
                if (subEmails.length > 0 && (subEmails.length + 1 > MAX_FILES_PER_REPO || subBytes + emailBytes > MAX_JSON_BYTES)) {
                    intermediateChunks.push({
                        customName: `emails-archive-${key}-${subIdx}`,
                        emails: subEmails,
                        keys: [key]
                    });
                    subEmails = [];
                    subBytes = 2;
                    subIdx++;
                }
                subEmails.push(email);
                subBytes += emailBytes;
            }
            if (subEmails.length > 0) {
                intermediateChunks.push({
                    customName: `emails-archive-${key}-${subIdx}`,
                    emails: subEmails,
                    keys: [key]
                });
            }
            continue;
        }

        // Standard grouping for months that fit within limits
        const potentialEmails = currentGroup.emails.length + keyEmails.length;
        const potentialBytes = currentGroupBytes + keyBytes;

        if (currentGroup.emails.length > 0 && (potentialEmails > MAX_FILES_PER_REPO || potentialBytes > MAX_JSON_BYTES)) {
            intermediateChunks.push(currentGroup);
            currentGroup = { emails: [...keyEmails], keys: [key] };
            currentGroupBytes = keyBytes;
        } else {
            currentGroup.emails.push(...keyEmails);
            currentGroup.keys.push(key);
            currentGroupBytes += keyBytes;
        }
    }

    if (currentGroup.emails.length > 0) {
        intermediateChunks.push(currentGroup);
    }

    // Final mapping to the expected structure
    return intermediateChunks.map((chunk, idx) => {
        const firstKey = chunk.keys[0];
        const lastKey = chunk.keys[chunk.keys.length - 1];
        const [yearStart, monthStart] = firstKey.split('-').map(Number);
        const [yearEnd, monthEnd] = lastKey.split('-').map(Number);
        
        let name = chunk.customName;
        if (!name) {
            const label = firstKey === lastKey ? firstKey : `${firstKey}_${lastKey}`;
            name = idx === 0 ? 'main' : `emails-archive-${label}`;
        }

        return {
            name,
            emails: chunk.emails,
            yearStart, monthStart, yearEnd, monthEnd
        };
    });
}

function rebuildIndex() {
    console.log('🚀 Rebuilding search index and generating manifest...');
    const allEmails = [];

    function walkDir(dir) {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                walkDir(fullPath);
            } else if (file.endsWith('.json')) {
                try {
                    const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                    if (content.id && content.date) {
                        const relativePath = '/' + fullPath.replace(/\\/g, '/').replace('public/', '');
                        allEmails.push({
                            id: content.id,
                            from: (content.from && content.from.email) ? content.from.email : typeof content.from === 'string' ? content.from : '',
                            fromName: (content.from && content.from.name) ? content.from.name : (content.fromName || ''),
                            to: content.to,
                            subject: content.subject,
                            preview: content.preview ? content.preview.substring(0, 200) : '',
                            date: content.date,
                            folder: content.folder || 'inbox',
                            labels: content.labels || ['inbox'],
                            account: content.account || 'unknown',
                            path: relativePath
                        });
                    }
                } catch (e) {}
            }
        }
    }

    walkDir(EMAILS_DIR);

    console.log(`📊 Found ${allEmails.length} emails. Sorting...`);
    allEmails.sort((a, b) => new Date(b.date) - new Date(a.date));

    const totalFiles = allEmails.length;
    const totalBytes = exactJsonBytes(allEmails);
    const needsSplit = totalFiles > MAX_FILES_PER_REPO || totalBytes > MAX_JSON_BYTES;

    // Clean old files
    try {
        const oldFiles = fs.readdirSync(OUTPUT_DIR);
        for (const file of oldFiles) {
            if (file === 'emails.json' || (file.startsWith('emails-archive-') && file.endsWith('.json'))) {
                fs.unlinkSync(path.join(OUTPUT_DIR, file));
            }
        }
    } catch (e) {}

    if (!needsSplit) {
        console.log('✅ Under limits - writing single emails.json');
        fs.writeFileSync(path.join(OUTPUT_DIR, 'emails.json'), JSON.stringify(allEmails));
        const manifest = {
            generatedAt: new Date().toISOString(),
            totalEmails: allEmails.length,
            repos: [{
                name: 'main',
                file: 'emails.json',
                emailCount: allEmails.length,
                yearStart: allEmails.length ? new Date(allEmails[allEmails.length-1].date).getFullYear() : null,
                yearEnd: allEmails.length ? new Date(allEmails[0].date).getFullYear() : null,
            }]
        };
        fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    } else {
        console.log('📦 Over limits - splitting into repositories...');
        const byYearMonth = groupEmailsByYearMonth(allEmails);
        const chunks = buildRepoChunks(byYearMonth);
        const manifest = {
            generatedAt: new Date().toISOString(),
            totalEmails: allEmails.length,
            repos: []
        };

        for (const chunk of chunks) {
            const filename = chunk.name === 'main' ? 'emails.json' : `${chunk.name}.json`;
            fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(chunk.emails));
            manifest.repos.push({
                name: chunk.name,
                file: filename,
                emailCount: chunk.emails.length,
                yearStart: chunk.yearStart,
                yearEnd: chunk.yearEnd,
                monthStart: chunk.monthStart,
                monthEnd: chunk.monthEnd,
            });
        }
        fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
        console.log(`✅ Success! Created ${chunks.length} repositories.`);
    }

    // Still write legacy search-index.json for safety/compatibility
    const legacyIndex = {
        emails: allEmails.slice(0, 5000), // Only include recent for legacy
        version: new Date().toISOString(),
        totalEmails: allEmails.length,
        isTruncated: allEmails.length > 5000
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'search-index.json'), JSON.stringify(legacyIndex, null, 2));
}

rebuildIndex();
