import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { simpleParser } from 'mailparser';
import { syncEmails } from './sync-imap.js';
import { syncEmailsSSH } from './sync-ssh.js';
import { execSync } from 'child_process';

dotenv.config({ override: true });

const ACCOUNTS_PATH = 'public/config/accounts.json';
const SEARCH_INDEX_PATH = 'public/search-index.json';

const SYNC_ACCOUNT = process.env.SYNC_ACCOUNT;
const SYNC_DAYS = parseInt(process.env.SYNC_DAYS) || 10950;
const WHITELIST_PATH = 'public/config/whitelist.json';

function writeEmailJsonSafe(targetFile, emailObj) {
    let jsonString = JSON.stringify(emailObj, null, 2);
    if (Buffer.byteLength(jsonString, 'utf8') > 20 * 1024 * 1024) {
        console.warn(`  ⚠️ Email JSON exceeds 20MB! Truncating to fit Cloudflare limits...`);
        emailObj.bodyHtml = '<p><b>[Email body too large. Truncated to fit within Cloudflare Pages limits.]</b></p>';
        emailObj.body = '[Email body too large. Truncated to fit within Cloudflare Pages limits.]';
        jsonString = JSON.stringify(emailObj, null, 2);
    }
    fs.writeFileSync(targetFile, jsonString);
}

function cleanupOversizedFiles() {
    const rootDir = path.join('public', 'emails');
    if (!fs.existsSync(rootDir)) return;
    const stack = [rootDir];
    while (stack.length > 0) {
        const currentPath = stack.pop();
        const items = fs.readdirSync(currentPath);
        for (const item of items) {
            const fullPath = path.join(currentPath, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                stack.push(fullPath);
            } else if (stat.isFile() && fullPath.endsWith('.json')) {
                if (stat.size > 20 * 1024 * 1024) {
                    console.log(`  🧹 Truncating oversized file: ${fullPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
                    try {
                        const email = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                        email.bodyHtml = '<p><b>[Email body too large. Truncated to fit within Cloudflare Pages limits.]</b></p>';
                        email.body = '[Email body too large. Truncated to fit within Cloudflare Pages limits.]';
                        fs.writeFileSync(fullPath, JSON.stringify(email, null, 2));
                    } catch (e) {
                        console.error(`  ❌ Failed to truncate ${fullPath}: ${e.message}`);
                    }
                }
            }
        }
    }
}

function getRootDomain(email) {
    if (!email) return '';
    const parts = email.split('@');
    if (parts.length < 2) return '';
    const domain = parts[1].toLowerCase();
    const domainParts = domain.split('.');
    if (domainParts.length > 2) {
        return domainParts.slice(-2).join('.');
    }
    return domain;
}

function isWhitelisted(email, whitelist) {
    if (!email || !whitelist) return false;
    let emailAddr = typeof email === 'string' ? email : (email.email || email.address || '');
    if (!emailAddr) return false;
    if (emailAddr.includes('<')) {
        const match = emailAddr.match(/<([^>]+)>/);
        if (match) emailAddr = match[1];
    }
    const lowerEmail = emailAddr.toLowerCase().trim();
    if (whitelist.emails.some(e => e.toLowerCase().trim() === lowerEmail)) return true;
    const domain = lowerEmail.split('@')[1];
    if (!domain) return false;
    if (whitelist.domains.some(d => {
        const wlD = d.toLowerCase().trim();
        return domain === wlD || domain.endsWith('.' + wlD);
    })) return true;
    return false;
}

function loadWhitelist() {
    if (!fs.existsSync(WHITELIST_PATH)) return { emails: [], domains: [] };
    try {
        let content = fs.readFileSync(WHITELIST_PATH, 'utf8');
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        return JSON.parse(content);
    } catch (e) {
        console.error('â Œ Error loading whitelist:', e.message);
        return { emails: [], domains: [] };
    }
}

function loadBlacklist() {
    const BLACKLIST_PATH = 'public/config/blacklist.json';
    if (!fs.existsSync(BLACKLIST_PATH)) return { emails: [], domains: [] };
    try {
        let content = fs.readFileSync(BLACKLIST_PATH, 'utf8');
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        return JSON.parse(content);
    } catch (e) {
        console.error('â Œ Error loading blacklist:', e.message);
        return { emails: [], domains: [] };
    }
}

function isBlacklisted(email, blacklist) {
    if (!email || !blacklist) return false;
    let emailAddr = typeof email === 'string' ? email : (email.email || email.address || '');
    if (!emailAddr) return false;
    if (emailAddr.includes('<')) {
        const match = emailAddr.match(/<([^>]+)>/);
        if (match) emailAddr = match[1];
    }
    const lowerEmail = emailAddr.toLowerCase().trim();
    const domain = lowerEmail.split('@')[1];
    if (blacklist.emails.some(e => e.toLowerCase().trim() === lowerEmail)) return true;
    if (!domain) return false;
    if (blacklist.domains.some(d => {
        const blD = d.toLowerCase().trim();
        if (domain === blD) return true;
        if (blD.startsWith('*.')) {
            const wildcardDomain = blD.substring(2);
            return domain === wildcardDomain || domain.endsWith('.' + wildcardDomain);
        }
        return domain.endsWith('.' + blD);
    })) return true;
    return false;
}

async function pushToCalendar(email) {
    const domain = getRootDomain(typeof email.from === 'string' ? email.from : email.from.email);
    const dateStr = email.date;
    const fromStr = typeof email.from === 'string' ? email.from : (email.from.name ? `${email.from.name} <${email.from.email}>` : email.from.email);
    const summary = `${fromStr}: ${email.subject}`;
    const description = `From: ${fromStr}\nSubject: ${email.subject}\n\n${email.preview || email.body || ''}`;
    try {
        const port = process.env.REPLY_PORT || 8046;
        const res = await fetch(`http://localhost:${port}/api/google/calendar/add-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                summary, description, dateStr, messageId: email.messageId, domain: domain, attachments: email.attachments || []
            })
        });
        const result = await res.json();
        if (result.success) {
            if (result.duplicate) console.log(`  â ­ï¸   Skipped (Already in domain event): ${email.subject}`);
            else if (result.updated) console.log(`  ðŸ”„ Updated domain event (${domain}): ${email.subject}`);
            else console.log(`  ðŸ“… Created new domain event (${domain}): ${email.subject}`);
        } else {
            console.warn(`  ðŸ›‘ Failed to push to calendar: ${result.error}`);
        }
    } catch (e) {
        if (e.message.includes('fetch failed')) {
            console.error(`  â Œ Error pushing to calendar: Calendar server (localhost:8046) is likely offline.`);
        } else {
            console.error(`  â Œ Error pushing to calendar: ${e.message}`);
        }
    }
}

async function syncAll() {
    console.log(`🚀 Starting ${SYNC_ACCOUNT ? `Targeted Sync (${SYNC_ACCOUNT})` : 'Unified Sync'}...`);
    console.log(`📅 Syncing last ${SYNC_DAYS} days.`);
    
    if (!fs.existsSync(ACCOUNTS_PATH)) {
        console.error('❌ accounts.json not found.');
        return;
    }
    
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    const whitelist = loadWhitelist();
    const blacklist = loadBlacklist();
    const processedMessageIds = new Set();
    const emailsToPush = [];
    
    // ✅ CRITICAL: Sync configs FIRST before any account processing
    await syncConfigs();
    console.log(`🔑 KV Credentials loaded:`, {
        user: kvCredentials.user || 'none',
        hasPass: !!kvCredentials.pass,
        host: kvCredentials.host || 'none',
        port: kvCredentials.port || 'none'
    });
    
    // Now load search index to populate processedMessageIds...
    let totalLoadedEmails = 0;
    try {
        const manifestPath = 'public/manifest.json';
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.repos && Array.isArray(manifest.repos)) {
                for (const repo of manifest.repos) {
                    const repoPath = path.join('public', repo.file);
                    if (fs.existsSync(repoPath)) {
                        const existing = JSON.parse(fs.readFileSync(repoPath, 'utf8'));
                        if (Array.isArray(existing)) {
                            existing.forEach(e => {
                                if (e.id) processedMessageIds.add(e.id);
                                if (e.messageId) processedMessageIds.add(e.messageId);
                                totalLoadedEmails++;
                            });
                        }
                    }
                }
            }
            console.log(`  ðŸ“‚ Loaded ${totalLoadedEmails} emails from manifest repos.`);
        }
    } catch(e) {
        console.warn('  âš ï¸  Could not load existing manifest.json, processing from search-index.json fallback.');
    }
    
    let searchIndex = { emails: [], version: new Date().toISOString() };
    if (totalLoadedEmails === 0 && fs.existsSync(SEARCH_INDEX_PATH)) {
        try {
            const existing = JSON.parse(fs.readFileSync(SEARCH_INDEX_PATH, 'utf8'));
            if (existing && Array.isArray(existing.emails)) {
                const uniqueEmails = new Map();
                existing.emails.forEach(e => {
                    if (!uniqueEmails.has(e.id)) uniqueEmails.set(e.id, e);
                });
                searchIndex.emails = Array.from(uniqueEmails.values());
                console.log(`  ðŸ“‚ Loaded ${searchIndex.emails.length} unique emails from legacy index.`);
                searchIndex.emails.forEach(e => {
                    if (e.id) processedMessageIds.add(e.id);
                    if (e.messageId) processedMessageIds.add(e.messageId);
                    totalLoadedEmails++;
                });
            }
        } catch (e) {
            console.warn('  âš ï¸   Could not load existing search-index.json, starting fresh.');
        }
    }
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (SYNC_DAYS + 1));
    
    // Auto-Rollover Trigger
    if (totalLoadedEmails > 19000) {
        console.log(`\n======================================================`);
        console.log(`File count exceeds 19000 limit. Initiating automated repository rollover...`);
        console.log(`======================================================`);
        try {
            execSync('node rollover.js', { stdio: 'inherit' });
            console.log(`Rollover complete. Sync will restart next cycle on fresh repository.`);
            process.exit(0);
        } catch(e) {
             console.error('Rollover failed:', e.message);
             process.exit(1);
        }
    }

    if (process.env.MIN_SYNC_DATE) {
        const minDate = new Date(process.env.MIN_SYNC_DATE);
        if (cutoffDate < minDate) {
            cutoffDate.setTime(minDate.getTime());
            console.log(`  🕒 Restricted sync cutoff to MIN_SYNC_DATE: ${process.env.MIN_SYNC_DATE}`);
        }
    }
    const DISABLE_SYNC = process.env.DISABLE_SYNC === 'true';
    if (DISABLE_SYNC) {
        console.log('  âš ï¸  Sync is DISABLED via DISABLE_SYNC variable. Skipping fetch.');
    } else {
        for (const account of accounts) {
            if (SYNC_ACCOUNT && account.id !== SYNC_ACCOUNT) continue;
            console.log(`\nðŸ“¬ Syncing account: ${account.name} (${account.type})...`);
            if (account.type === 'kv') {
                await syncKV(account, searchIndex, processedMessageIds, emailsToPush, cutoffDate, blacklist);
            } else if (account.type === 'imap') {
                // --- SSH-first with IMAP failover ---
                // Auto-derive maildir from email address if not explicitly set in accounts.json
                // e.g. test@xotours.net -> /home/xotours/mail/xotours.net/test
                const sshMaildir = account.ssh?.maildir || (() => {
                    const emailUser = account.imap?.user || '';
                    const [localPart, domain] = emailUser.split('@');
                    const homeParts = domain ? domain.split('.') : [];
                    const homeUser = homeParts.length > 0 ? homeParts[0] : 'mail';
                    return domain ? `/home/${homeUser}/mail/${domain}/${localPart}` : '';
                })();

                let fetchedCount = 0;
                const processEmailCallback = async (email) => {
                    if (processedMessageIds.has(email.id) || (email.messageId && processedMessageIds.has(email.messageId))) return;
                    if (new Date(email.date) < cutoffDate) return;
                    processedMessageIds.add(email.id);
                    if (email.messageId) processedMessageIds.add(email.messageId);
                    const date = new Date(email.date);
                    const year = date.getFullYear();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const targetDir = path.join('public', 'emails', String(year), month);
                    const targetFile = path.join(targetDir, `${email.id}.json`);
                    fs.mkdirSync(targetDir, { recursive: true });
                    writeEmailJsonSafe(targetFile, email);
                    let fromEmailObj = email.from;
                    let fromEmail = '';
                    if (typeof fromEmailObj === 'string') {
                        fromEmail = fromEmailObj;
                    } else if (fromEmailObj) {
                        fromEmail = fromEmailObj.email || '';
                    }
                    if (isWhitelisted(fromEmail, whitelist)) {
                        emailsToPush.push(email);
                    } else if (isBlacklisted(fromEmail, blacklist)) {
                        email.folder = 'junk';
                        if (!email.labels) email.labels = [];
                        if (!email.labels.includes('junk')) email.labels.push('junk');
                    }
                    writeEmailJsonSafe(targetFile, email);
                    searchIndex.emails.push({
                        id: email.id,
                        from: fromEmail,
                        fromName: email.from?.name || (fromEmail && typeof fromEmail === 'string' ? fromEmail.split('@')[0] : 'Unknown'),
                        to: email.to,
                        subject: email.subject,
                        preview: email.preview,
                        date: email.date,
                        folder: email.folder || 'inbox',
                        labels: email.labels,
                        account: account.id,
                        path: `/emails/${year}/${month}/${email.id}.json`
                    });
                    fetchedCount++;
                };

                const sshConfig = {
                    ...account,
                    onEmail: processEmailCallback,
                    ssh: {
                        user: process.env.SSH_USER || 'root',
                        host: process.env.SSH_HOST || 'mail.xotours.net',
                        port: parseInt(process.env.SSH_PORT) || 22,
                        maildir: sshMaildir,
                        ...(account.ssh || {})
                    },
                    outputDir: 'public',
                    maxEmails: parseInt(process.env.MAX_EMAILS) || 500,
                    syncDays: SYNC_DAYS
                };

                let syncSuccess = false;

                // 1️⃣ Try SSH first
                if ((process.env.SSH_PRIVATE_KEY || process.env.SSH_KEY_PATH) && sshMaildir) {
                    try {
                        console.log(`  🔐 Trying SSH sync first (maildir: ${sshMaildir})...`);
                        await syncEmailsSSH(sshConfig);
                        console.log(`  ✓ Fetched ${fetchedCount} emails via SSH.`);
                        syncSuccess = true;
                    } catch (sshErr) {
                        console.warn(`  ⚠️  SSH failed: ${sshErr.message}`);
                        console.warn(`  ↩️  Falling back to IMAP...`);
                    }
                }

                // 2️⃣ Fallback to IMAP if SSH was skipped or failed
                if (!syncSuccess) {
                    try {
                        let imapConfig = { ...account.imap };
                        imapConfig.password = await getPasswordByAccount(account.id, account.imap.user);
                        if (kvCredentials.user && (kvCredentials.user === account.id || kvCredentials.user === account.imap.user)) {
                            if (kvCredentials.host) imapConfig.host = kvCredentials.host;
                            if (kvCredentials.port) imapConfig.port = parseInt(kvCredentials.port);
                        }
                        const imapCfg = { ...account, imap: imapConfig, onEmail: processEmailCallback, outputDir: 'public', maxEmails: parseInt(process.env.MAX_EMAILS) || 500, syncDays: SYNC_DAYS };
                        await syncEmails(imapCfg);
                        console.log(`  ✓ Fetched ${fetchedCount} emails via IMAP (fallback).`);
                    } catch (imapErr) {
                        console.error(`  ❌ IMAP Sync Error for ${account.name}: ${imapErr.message}`);
                    }
                }

                // Processed in callbacks
            }
        }
    }
    console.log(`\nðŸ“Š Processed ${searchIndex.emails.length} new emails in this sync.`);
    if (emailsToPush.length > 0) {
        console.log(`\nðŸ“… Pushing ${emailsToPush.length} whitelisted emails to calendar...`);
        for (const email of emailsToPush) await pushToCalendar(email);
    }
    cleanupOversizedFiles();
    try {
        console.log('\n🔄 Rebuilding unified search index...');
        execSync('node rebuild-index.js', { stdio: 'inherit' });
    } catch(e) {
        console.error('â Œ Error rebuilding index:', e.message);
    }
    console.log('\nâœ… Unified sync complete!');
}

let kvCredentials = {};

async function getPasswordByAccount(id, accountUser) {
    // First check KV credentials
    if (kvCredentials.user && (kvCredentials.user === id || kvCredentials.user === accountUser)) {
        if (kvCredentials.pass) {
            console.log(`  🔑 Using KV password for: ${accountUser}`);
            return kvCredentials.pass;
        }
    }
    
    // Fallback to environment variables
    const email = accountUser.toLowerCase();
    
    if (email.includes('xotours')) {
        console.log(`  🔑 Using XOTOURS_IMAP_PASS for: ${accountUser}`);
        return process.env.XOTOURS_IMAP_PASS || process.env.EMAIL_PASS;
    }
    
    if (email.includes('gmail')) {
        console.log(`  🔑 Using GMAIL_IMAP_PASS for: ${accountUser}`);
        return process.env.GMAIL_IMAP_PASS;
    }
    
    if (email.includes('hotmail')) {
        console.log(`  🔑 Using HOTMAIL_IMAP_PASS for: ${accountUser}`);
        return process.env.HOTMAIL_IMAP_PASS;
    }
    
    if (email.includes('superesolutions')) {
        console.log(`  🔑 Using SUPERESOLUTIONS_IMAP_PASS for: ${accountUser}`);
        return process.env.SUPERESOLUTIONS_IMAP_PASS;
    }
    
    console.log(`  🔑 Using EMAIL_PASS (default) for: ${accountUser}`);
    return process.env.EMAIL_PASS;
}

async function syncKV(account, searchIndex, processedMessageIds, emailsToPush, cutoffDate, blacklist) {
    const CF_API_TOKEN = process.env.GLOUDFLARE_API || process.env.CF_API_TOKEN;
    const CF_ACCOUNT_ID = process.env.CF_ID || "d4336e2049af94b65acdacd750014877";
    const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID || "778c95fd92e4450f8e3c19a564971733";
    console.log(`  ðŸ”  Targeting KV: Account=${CF_ACCOUNT_ID}, Namespace=${KV_NAMESPACE_ID}`);
    const whitelist = loadWhitelist();
    const headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };
    try {
        const prefixes = ['queue:', 'sent:'];
        for (const prefix of prefixes) {
            const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?prefix=${prefix}`;
            const listRes = await fetch(url, { headers });
            const listData = await listRes.json();
            if (!listData.success) {
                console.error(`  â Œ Failed to list KV keys: ${JSON.stringify(listData.errors)}`);
                continue;
            }
            const keys = listData.result;
            if (keys.length > 0) console.log(`  âœ“ Found ${keys.length} ${prefix} emails in KV.`);
            for (const key of keys) {
                const valRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key.name}`, { headers });
                const rawKV = await valRes.text();
                let data;
                try { data = JSON.parse(rawKV); } catch (e) { continue; }
                if (processedMessageIds.has(data.id) || (data.messageId && processedMessageIds.has(data.messageId))) {
                    await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key.name}`, { method: 'DELETE', headers });
                    continue;
                }
                if (new Date(data.date) < cutoffDate) {
                    await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key.name}`, { method: 'DELETE', headers });
                    continue;
                }
                processedMessageIds.add(data.id);
                if (data.messageId) processedMessageIds.add(data.messageId);
                let finalEmail = data;
                if (data.raw) {
                    const parsed = await simpleParser(data.raw);
                    finalEmail = {
                        ...data,
                        subject: parsed.subject || data.subject,
                        from: parsed.from?.value[0]?.address || data.from,
                        fromName: parsed.from?.value[0]?.name || data.from.split('@')[0],
                        to: (parsed.to?.value || []).map(t => ({ name: t.name || "", email: t.address })),
                        bodyHtml: parsed.html || parsed.textAsHtml || data.html,
                        body: parsed.text || ""
                    };
                } else {
                    finalEmail.bodyHtml = data.bodyHtml || data.html;
                    if (typeof finalEmail.to === 'string') finalEmail.to = [{ name: "", email: finalEmail.to }];
                }
                if (prefix === 'sent:') {
                    finalEmail.folder = 'sent';
                    if (!finalEmail.labels) finalEmail.labels = [];
                    if (!finalEmail.labels.includes('sent')) finalEmail.labels.push('sent');
                }
                const date = new Date(finalEmail.date);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const targetDir = path.join('public', 'emails', String(year), month);
                const targetFile = path.join(targetDir, `${finalEmail.id}.json`);
                fs.mkdirSync(targetDir, { recursive: true });
                writeEmailJsonSafe(targetFile, finalEmail);
                if (isWhitelisted(finalEmail.from, whitelist)) emailsToPush.push(finalEmail);
                else if (isBlacklisted(finalEmail.from, blacklist)) {
                    finalEmail.folder = 'junk';
                    if (!finalEmail.labels) finalEmail.labels = [];
                    if (!finalEmail.labels.includes('junk')) finalEmail.labels.push('junk');
                }
                writeEmailJsonSafe(targetFile, finalEmail);
                searchIndex.emails.push({
                    id: finalEmail.id,
                    from: finalEmail.from,
                    fromName: finalEmail.fromName || (typeof finalEmail.from === 'string' ? finalEmail.from.split('@')[0] : 'Unknown'),
                    to: finalEmail.to,
                    subject: finalEmail.subject,
                    preview: (finalEmail.body || finalEmail.bodyHtml || "").replace(/<[^>]+>/g, ' ').substring(0, 200).trim(),
                    date: finalEmail.date,
                    folder: finalEmail.folder || "inbox",
                    labels: finalEmail.labels || ["inbox", "kv"],
                    account: account.id,
                    path: `/emails/${year}/${month}/${finalEmail.id}.json`
                });
                await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key.name}`, { method: 'DELETE', headers });
            }
        }
    } catch (e) {
        console.error(`  â Œ KV Sync Error: ${e.message}`);
    }
}

async function syncConfigs() {
    const CF_API_TOKEN = process.env.GLOUDFLARE_API || process.env.CF_API_TOKEN;
    const CF_ACCOUNT_ID = process.env.CF_ID || "d4336e2049af94b65acdacd750014877";        // ← ADD
    const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID || "778c95fd92e4450f8e3c19a564971733"; // ← ADD
    
    console.log(`  🔑 CF_API_TOKEN present: ${!!CF_API_TOKEN}, length: ${CF_API_TOKEN?.length || 0}`);
    
    if (!CF_API_TOKEN) {
        console.log('  ⚠️  Skipping config sync: CF_API_TOKEN not set.');
        return;
    }
    const configs = [
        { key: 'contacts', path: 'public/config/contacts.json', default: [] },
        { key: 'whitelist', path: 'public/config/whitelist.json', default: { emails: [], domains: [] } },
        { key: 'blacklist', path: 'public/config/blacklist.json', default: { emails: [], domains: [] } },
        { key: 'settings:EMAIL_USER', isCredential: true },
        { key: 'settings:EMAIL_PASS', isCredential: true },
        { key: 'settings:EMAIL_HOST', isCredential: true },
        { key: 'settings:EMAIL_PORT', isCredential: true }
    ];
    const headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };
    console.log('\nâš™ï¸  Syncing configurations from KV...');
    for (const config of configs) {
        try {
            const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${config.key}`, { headers });
            let data = null;
            if (res.ok) {
                data = await res.text();
                if (data && data.charCodeAt(0) === 0xFEFF) {
                    data = data.slice(1);
                }
            } else if (res.status === 404) {
                data = config.default ? JSON.stringify(config.default, null, 2) : null;
            }
            if (data !== null) {
                if (config.isCredential) {
                    if (config.key === 'settings:EMAIL_USER') kvCredentials.user = data;
                    if (config.key === 'settings:EMAIL_PASS') kvCredentials.pass = data;
                    if (config.key === 'settings:EMAIL_HOST') kvCredentials.host = data;
                    if (config.key === 'settings:EMAIL_PORT') kvCredentials.port = data;
                } else {
                    try { JSON.parse(data); } catch (pe) { continue; }
                    fs.mkdirSync(path.dirname(config.path), { recursive: true });
                    fs.writeFileSync(config.path, data);
                    console.log(`  âœ“ Synced ${config.path}`);
                }
            }
        } catch (e) {
            console.error(`  â Œ Error syncing ${config.key}: ${e.message}`);
        }
    }
}

syncAll();
