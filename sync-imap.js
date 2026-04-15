#!/usr/bin/env node

/**
 * CloudMail IMAP Sync Script (Modular Version)
 * Syncs emails from Roundcube/any IMAP server to static JSON files
 */

import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Default config
const DEFAULT_CONFIG = {
  imap: {
    user: process.env.EMAIL_USER || '',
    password: process.env.EMAIL_PASS || '',
    host: process.env.EMAIL_HOST || '',
    port: parseInt(process.env.EMAIL_PORT) || 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 10000,
    authTimeout: 5000
  },
  outputDir: process.env.OUTPUT_DIR || 'public',
  maxAttachmentSize: parseInt(process.env.MAX_ATTACHMENT_SIZE) || 500 * 1024,
  syncDays: parseInt(process.env.SYNC_DAYS) || 10950,
  folders: (process.env.SYNC_FOLDERS || 'INBOX,Sent,Drafts')
    .split(',')
    .map(f => f.trim().replace(/^["']|["']$/g, '')),
  maxEmails: parseInt(process.env.MAX_EMAILS) || 30000
};

/**
 * Generate unique email ID from headers
 */
function generateEmailId(messageId, date) {
  const hash = crypto.createHash('md5')
    .update(messageId + String(date))
    .digest('hex')
    .substring(0, 12);
  return `email-${hash}`;
}

/**
 * Sanitize filename
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-z0-9.-]/gi, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 100);
}

/**
 * Normalize folder name
 */
function normalizeFolder(folder) {
  const f = folder.toLowerCase();
  if (f.includes('sent')) return 'sent';
  if (f.includes('drafts')) return 'drafts';
  if (f.includes('trash') || f.includes('bin')) return 'trash';
  if (f.includes('junk') || f.includes('spam')) return 'junk';
  return 'inbox';
}

/**
 * Save attachment
 */
async function saveAttachment(attachment, emailId, config) {
  const attachDir = path.join(config.outputDir, 'attachments');
  await fs.mkdir(attachDir, { recursive: true });

  const safeFilename = sanitizeFilename(attachment.filename || 'attachment');
  const filename = `${emailId}-${safeFilename}`;
  const filepath = path.join(attachDir, filename);

  await fs.writeFile(filepath, attachment.content);

  return {
    filename: attachment.filename,
    size: attachment.size,
    type: attachment.contentType,
    url: `/attachments/${filename}`
  };
}

/**
 * Convert email to JSON
 */
async function convertEmail(buffer, folder, config) {
  const parsed = await simpleParser(buffer);
  const emailDate = parsed.date || new Date();
  const emailId = generateEmailId(parsed.messageId || String(Date.now()), emailDate);

  const attachments = [];
  if (parsed.attachments) {
    for (const att of parsed.attachments) {
      if (att.size <= config.maxAttachmentSize) {
        const saved = await saveAttachment(att, emailId, config);
        attachments.push(saved);
      } else {
        attachments.push({
          filename: att.filename, size: att.size, type: att.contentType, url: null, tooLarge: true
        });
      }
    }
  }

  let preview = '';
  if (parsed.text) {
    preview = parsed.text.replace(/\s+/g, ' ').trim().substring(0, 200);
  }

  return {
    id: emailId,
    messageId: parsed.messageId,
    from: {
      name: parsed.from?.value[0]?.name || '',
      email: parsed.from?.value[0]?.address || ''
    },
    to: (parsed.to?.value || []).map(t => ({
      name: (t.name || '').trim(),
      email: (t.address || '').trim()
    })).filter(t => t.email),
    subject: (parsed.subject || '(No Subject)').trim(),
    date: emailDate.toISOString(),
    preview,
    body: parsed.text || '',
    bodyHtml: parsed.html || parsed.textAsHtml || '',
    attachments,
    folder: normalizeFolder(folder),
    labels: [normalizeFolder(folder)],
    read: true,
    starred: false,
    hasAttachments: attachments.length > 0,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references
  };
}

/**
 * Fetch from IMAP
 */
function fetchFromFolder(imap, folderName, limit, config) {
  return new Promise((resolve) => {
    imap.openBox(folderName, true, (err, box) => {
      if (err) {
        console.error(`  âŒ Error opening ${folderName}:`, err.message);
        resolve([]);
        return;
      }

      if (box.messages.total === 0) {
        resolve([]);
        return;
      }

      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - (config.syncDays || 30));
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const imapDay = String(sinceDate.getDate()).padStart(2, '0');
      const imapDate = `${imapDay}-${months[sinceDate.getMonth()]}-${sinceDate.getFullYear()}`;
      console.log(`  ðŸ” Searching IMAP folders since: ${imapDate} (Sync Days: ${config.syncDays})`);

      imap.search([['SINCE', imapDate]], (err, results) => {
        if (err || results.length === 0) {
          resolve([]);
          return;
        }

        const fetchResults = limit < Infinity ? results.slice(-limit) : results;
        const fetch = imap.fetch(fetchResults, { bodies: '' });
        const emails = [];
        let pending = 0;
        let ended = false;

        const checkDone = () => { if (ended && pending === 0) resolve(emails); };

        fetch.on('message', (msg, seqno) => {
          pending++;
          let buffer = Buffer.alloc(0);
          msg.on('body', (stream) => {
            stream.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); });
          });
          msg.once('end', async () => {
            try {
              const email = await convertEmail(buffer, folderName, config);
              emails.push(email);
            } catch (e) { console.error(`  Parse error [${seqno}]:`, e.message); }
            pending--;
            checkDone();
          });
        });

        fetch.once('end', () => { ended = true; checkDone(); });
      });
    });
  });
}

/**
 * Exported Sync
 */
async function syncEmails(customConfig) {
  const config = { ...DEFAULT_CONFIG, ...customConfig };

  // MERGE IMAP options to ensure tlsOptions is passed to node-imap
  const imapOptions = {
    ...DEFAULT_CONFIG.imap,
    ...config.imap,
    tlsOptions: {
      ...(DEFAULT_CONFIG.imap.tlsOptions || {}),
      ...(config.imap?.tlsOptions || {})
    }
  };

  return new Promise((resolve, reject) => {
    const imap = new Imap(imapOptions);
    imap.once('ready', async () => {
      try {
        const emailMap = new Map();
        const folders = config.folders || DEFAULT_CONFIG.folders;
        for (const folder of folders) {
          const remaining = (config.maxEmails || 100) - emailMap.size;
          if (remaining <= 0) break;
          const folderEmails = await fetchFromFolder(imap, folder.trim(), remaining, config);
          for (const email of folderEmails) {
            if (!emailMap.has(email.id)) emailMap.set(email.id, email);
          }
        }
        imap.end();
        resolve(Array.from(emailMap.values()));
      } catch (e) { imap.end(); reject(e); }
    });
    imap.once('error', (err) => {
      console.error(`  âŒ IMAP Error for ${imapOptions.user}:`, err);
      imap.end();
      reject(err);
    });
    imap.connect();
  });
}

export { syncEmails };

