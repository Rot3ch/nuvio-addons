const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const FormData = require("form-data");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 7001;

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function sanitizeSearchQuery(query) {
    if (!query) return "";
    return query
        .replace(/['"’`:\-\._]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Detect language from nCore release titles
function detectLanguage(title) {
    if (!title) return "🇬🇧 [ENG]";
    const t = title.toUpperCase();

    if (/\b(DUAL|HUN\.ENG|ENG\.HUN)\b/i.test(t) || (/\bHUN\b/i.test(t) && /\bENG\b/i.test(t))) {
        return "🇭🇺+🇬🇧 [DUAL]";
    }
    if (/\bMULTI\b/i.test(t)) {
        return "🌐 [MULTi]";
    }
    if (/\b(HUN|HUNGARIAN|MAGYAR|HU)\b/i.test(t)) {
        return "🇭🇺 [HUN]";
    }
    if (/\b(ENG|ENGLISH|EN)\b/i.test(t)) {
        return "🇬🇧 [ENG]";
    }

    return "🇬🇧 [ENG]"; // Default fallback for untagged standard releases
}

function extractInfoHash(torrentBuffer) {
    try {
        const str = torrentBuffer.toString('binary');
        const infoIdx = str.indexOf('4:infod');
        if (infoIdx === -1) return null;
        
        const start = infoIdx + 6;
        let level = 0;
        let i = start;
        
        while (i < str.length) {
            const char = str[i];
            if (char === 'd' || char === 'l') {
                level++;
                i++;
            } else if (char === 'e') {
                if (level === 1) {
                    const infoDictBinary = str.substring(start, i + 1);
                    return crypto.createHash('sha1').update(Buffer.from(infoDictBinary, 'binary')).digest('hex').toLowerCase();
                }
                level--;
                i++;
            } else if (char === 'i') {
                i = str.indexOf('e', i) + 1;
            } else if (char >= '0' && char <= '9') {
                const colonIdx = str.indexOf(':', i);
                const len = parseInt(str.substring(i, colonIdx), 10);
                i = colonIdx + 1 + len;
            } else {
                i++;
            }
        }
    } catch (e) {
        return null;
    }
    return null;
}

async function getNcoreSession(username, password) {
    const loginUrl = "https://ncore.pro/login.php";
    const params = new URLSearchParams();
    params.append("nev", username);
    params.append("pass", password);
    params.append("ne_leptessen_ki", "1");
    params.append("submitted", "1");

    const res = await axios.post(loginUrl, params.toString(), {
        headers: { 
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
    });

    const setCookieHeaders = res.headers["set-cookie"];
    if (!setCookieHeaders) throw new Error("nCore login failed: Check credentials.");

    return setCookieHeaders.map(c => c.split(';')[0]).join('; ');
}

async function scrapeNcore(searchQuery, searchType, sessionCookie) {
    const mode = searchType === "imdb" ? "imdb" : "name";
    const searchUrl = `https://ncore.pro/torrents.php?miben=${mode}&mire=${encodeURIComponent(searchQuery)}&kivalasztott_tipus=osszes_fit`;
    
    const searchRes = await axios.get(searchUrl, {
        headers: { 
            "Cookie": sessionCookie,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
    });

    const $ = cheerio.load(searchRes.data);
    const rows = [];
    const seenIds = new Set();

    let passkey = "";
    const keyMatch = searchRes.data.match(/key=([a-zA-Z0-9]+)/i);
    if (keyMatch) passkey = keyMatch[1];

    $(".box_torrent, .box_torrent2").each((_, row) => {
        const $row = $(row);
        
        const titleEl = $row.find('.torrent_txt a, .torrent_txt2 a, a[href*="action=details"]').first();
        let title = titleEl.attr('title') || titleEl.text().trim();
        if (!title) return;
        title = title.replace(/\[imdb:\s*[\d\.]+\]/gi, "").trim();

        const href = titleEl.attr('href') || $row.find('a[href*="action=download"]').attr('href') || "";
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) return;
        const torrentId = idMatch[1];

        if (seenIds.has(torrentId)) return;
        seenIds.add(torrentId);

        let sizeStr = "N/A";
        const sizeText = $row.find('.s_link_meret, div[class*="box_meret"]').text().trim();
        if (sizeText) {
            sizeStr = sizeText;
        } else {
            const st = $row.text().match(/\d+(\.\d+)?\s*(B|KB|MB|GB|TB|GiB|MiB)/i);
            if (st) sizeStr = st[0];
        }

        let seeders = 0;
        const seedText = $row.find('.s_link_seed, div[class*="box_s"]').text().trim();
        if (seedText) {
            seeders = parseInt(seedText, 10) || 0;
        } else {
             const sMatch = $row.find('a[href*="peers_s"]').text();
             if (sMatch) seeders = parseInt(sMatch, 10) || 0;
        }

        const downloadUrl = passkey 
            ? `
