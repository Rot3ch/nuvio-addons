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
            ? `https://ncore.pro/torrents.php?action=download&id=${torrentId}&key=${passkey}`
            : `https://ncore.pro/torrents.php?action=download&id=${torrentId}`;

        rows.push({
            id: torrentId,
            name: title,
            sizeStr: sizeStr,
            seeders: seeders,
            downloadUrl: downloadUrl,
            passkey: passkey
        });
    });

    return rows;
}

async function getMediaTitleFromCinemeta(type, imdbId) {
    try {
        const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        const res = await axios.get(metaUrl, { timeout: 3000 });
        return res.data?.meta?.name || null;
    } catch (e) {
        return null;
    }
}

function isEpisodeMatch(title, season, episode) {
    if (!season || !episode) return true;

    const s = season;
    const e = episode;

    const epPatterns = [
        new RegExp(`S0*${s}E0*${e}\\b`, 'i'),          
        new RegExp(`\\b${s}x0*${e}\\b`, 'i'),          
        new RegExp(`\\bE(P)?0*${e}\\b.*S0*${s}`, 'i') 
    ];

    const seasonPackPatterns = [
        new RegExp(`S0*${s}\\b`, 'i'),            
        new RegExp(`\\b0*${s}\\.\\s*évad\\b`, 'i'),      
        new RegExp(`\\b0*${s}\\.\\s*evad\\b`, 'i'),      
        new RegExp(`\\bevad\\.\\s*0*${s}\\b`, 'i')       
    ];

    return epPatterns.some(p => p.test(title)) || seasonPackPatterns.some(p => p.test(title));
}

function isTitleMatch(torrentName, targetTitle) {
    if (!targetTitle) return true;
    const cleanTarget = sanitizeSearchQuery(targetTitle).toLowerCase();
    const cleanTorrent = sanitizeSearchQuery(torrentName).toLowerCase();
    const words = cleanTarget.split(' ').filter(w => w.length > 2);
    if (words.length <= 1) return true;
    const matches = words.filter(w => cleanTorrent.includes(w));
    return matches.length >= Math.min(2, words.length);
}

async function getStreamList(type, id, config, host) {
    console.log(`\n--- nCore Stream List Request for ${type} ---`);
    
    const parts = id.split(':');
    const imdbId = parts[0]; 
    const season = parts[1] ? parseInt(parts[1], 10) : null;
    const episode = parts[2] ? parseInt(parts[2], 10) : null;

    console.log(`IMDb ID: ${imdbId} ${season ? `| Season ${season} Episode ${episode}` : ''}`);

    if (!config || !config.ncore_user || !config.ncore_pass || !config.torbox_key) {
        console.log("❌ Error: Missing configuration variables.");
        return { streams: [] };
    }

    try {
        console.log(`Logging in to nCore as ${config.ncore_user}...`);
        const sessionCookie = await getNcoreSession(config.ncore_user, config.ncore_pass);

        let mediaTitle = null;
        console.log(`[Tier 1A] Querying nCore search for IMDb ID (${imdbId})...`);
        let scrapedRows = await scrapeNcore(imdbId, "imdb", sessionCookie);

        if (scrapedRows.length === 0 && imdbId.startsWith("tt")) {
            const numericId = imdbId.replace("tt", "");
            console.log(`[Tier 1B] Retrying numeric IMDb ID (${numericId})...`);
            scrapedRows = await scrapeNcore(numericId, "imdb", sessionCookie);
        }

        if (scrapedRows.length === 0) {
            console.log(`0 results by IMDb ID. Querying Cinemeta for title...`);
            mediaTitle = await getMediaTitleFromCinemeta(type, imdbId);
            
            if (mediaTitle) {
                console.log(`[Tier 2A] Title found: "${mediaTitle}". Searching nCore...`);
                scrapedRows = await scrapeNcore(mediaTitle, "name", sessionCookie);

                if (scrapedRows.length === 0 && mediaTitle.includes(":")) {
                    const subtitlePart = mediaTitle.split(":")[1].trim();
                    console.log(`[Tier 2B] Retrying with subtitle phrase: "${subtitlePart}"...`);
                    scrapedRows = await scrapeNcore(subtitlePart, "name", sessionCookie);
                }

                if (scrapedRows.length === 0 && mediaTitle.includes(":")) {
                    const mainPart = mediaTitle.split(":")[0].trim();
                    console.log(`[Tier 2C] Retrying with main title phrase: "${mainPart}"...`);
                    scrapedRows = await scrapeNcore(mainPart, "name", sessionCookie);
                }

                if (scrapedRows.length === 0) {
                    const cleanTitle = sanitizeSearchQuery(mediaTitle);
                    if (cleanTitle !== mediaTitle) {
                        console.log(`[Tier 3] Retrying with sanitized query: "${cleanTitle}"...`);
                        scrapedRows = await scrapeNcore(cleanTitle, "name", sessionCookie);
                    }
                }
            }
        }

        console.log(`Total raw torrents found on nCore: ${scrapedRows.length}`);

        const matchingRows = scrapedRows.filter(t => {
            if (type === "series" && season !== null && episode !== null) {
                return isEpisodeMatch(t.name, season, episode);
            }
            if (type === "movie" && mediaTitle) {
                return isTitleMatch(t.name, mediaTitle);
            }
            return true;
        });

        console.log(`Filtered down to ${matchingRows.length} matching release(s).`);

        const topTorrents = matchingRows.slice(0, 10);

        const torrentsWithHashes = await Promise.all(
            topTorrents.map(async (t) => {
                try {
                    const res = await axios.get(t.downloadUrl, { 
                        responseType: 'arraybuffer',
                        timeout: 4000,
                        headers: { 
                            "Cookie": sessionCookie,
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" 
                        }
                    });
                    const calculatedHash = extractInfoHash(Buffer.from(res.data));
                    if (!calculatedHash) console.log(`⚠️ Warning: Failed to extract infohash from ${t.name}`);
                    return { ...t, computedHash: calculatedHash };
                } catch (e) {
                    console.log(`⚠️ HTTP Error downloading .torrent for ${t.name}`);
                    return { ...t, computedHash: null };
                }
            })
        );

        const hashList = torrentsWithHashes
            .map(t => t.computedHash)
            .filter(Boolean);

        let cachedHashes = new Set();

        if (hashList.length > 0) {
            try {
                const cacheUrl = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashList.join(",")}&format=object`;
                const cacheRes = await axios.get(cacheUrl, {
                    headers: { "Authorization": `Bearer ${config.torbox_key}` }
                });

                if (cacheRes.data && cacheRes.data.data) {
                    const cacheData = cacheRes.data.data;
                    if (typeof cacheData === 'object' && !Array.isArray(cacheData)) {
                        Object.keys(cacheData).forEach(h => {
                            const val = cacheData[h];
                            if (val === true || (val && typeof val === 'object')) {
                                cachedHashes.add(h.toLowerCase());
                            }
                        });
                    } else if (Array.isArray(cacheData)) {
                        cacheData.forEach(item => {
                            if (typeof item === 'string') cachedHashes.add(item.toLowerCase());
                            else if (item && item.hash) cachedHashes.add(item.hash.toLowerCase());
                        });
                    }
                }
                console.log(`🔍 Cache Summary: ${cachedHashes.size} out of ${hashList.length} releases are cached on TorBox.`);
            } catch (cacheErr) {
                console.log(`⚠️ Cache check error:`, cacheErr?.response?.data || cacheErr.message);
            }
        }

        const configEncoded = encodeURIComponent(JSON.stringify(config));
        const cachedStreams = [];
        const uncachedStreams = [];

        for (const torrent of torrentsWithHashes) {
            const currentHash = torrent.computedHash ? torrent.computedHash.toLowerCase() : "";
            const isCached = currentHash && cachedHashes.has(currentHash);
            
            const statusTag = isCached ? "⚡ [CACHED]" : "⏳ [UNCACHED]";
            const providerName = isCached ? "nCore + TorBox ⚡" : "nCore + TorBox";

            const streamObj = {
                name: providerName,
                title: `${statusTag} ${torrent.name}\n💾 ${torrent.sizeStr} | 👤 ${torrent.seeders} seeds`,
                url: `http://${host}/resolve-ncore/${configEncoded}/${torrent.id}/${torrent.passkey || "none"}`
            };

            if (isCached) {
                cachedStreams.push(streamObj);
            } else {
                uncachedStreams.push(streamObj);
            }
        }

        const sortedStreams = [...cachedStreams, ...uncachedStreams];
        console.log(`Returned ${sortedStreams.length} stream options to Nuvio.\n`);
        return { streams: sortedStreams };

    } catch (error) {
        console.error("nCore API Error:", error?.response?.data || error.message);
        return { streams: [] };
    }
}

app.get("/resolve-ncore/:config/:torrentId/:passkey", async (req, res) => {
    try {
        let config = JSON.parse(decodeURIComponent(req.params.config));
        const torrentId = req.params.torrentId;
        const passkeyParam = req.params.passkey && req.params.passkey !== "none" ? `&key=${req.params.passkey}` : "";

        console.log(`\n▶️ Stream selected! Processing nCore Torrent ID: ${torrentId}`);

        const sessionCookie = await getNcoreSession(config.ncore_user, config.ncore_pass);
        const downloadUrl = `https://ncore.pro/torrents.php?action=download&id=${torrentId}${passkeyParam}`;
        
        console.log(`Downloading .torrent file from nCore (Secure)...`);
        const torrentBufferRes = await axios.get(downloadUrl, { 
            responseType: 'arraybuffer',
            headers: { 
                "Cookie": sessionCookie,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" 
            }
        });

        const buffer = Buffer.from(torrentBufferRes.data);

        console.log(`Uploading to TorBox (${(buffer.length / 1024).toFixed(1)} KB)...`);
        const form = new FormData();
        form.append("file", buffer, { filename: `ncore_${torrentId}.torrent`, contentType: "application/x-bittorrent" });
        form.append("seed", "2");

        const torboxAddRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", form, {
            headers: { ...form.getHeaders(), "Authorization": `Bearer ${config.torbox_key}` }
        });

        if (torboxAddRes.data && torboxAddRes.data.success) {
            const torboxTorrentId = torboxAddRes.data.data.torrent_id;

            console.log(`Querying TorBox torrent files for torrent ID: ${torboxTorrentId}...`);
            const mylistRes = await axios.get(`https://api.torbox.app/v1/api/torrents/mylist?id=${torboxTorrentId}`, {
                headers: { "Authorization": `Bearer ${config.torbox_key}` }
            });

            let targetFileId = 1;
            const torrentData = mylistRes.data?.data;
            const torrentObj = Array.isArray(torrentData) 
                ? torrentData.find(t => t.id === torboxTorrentId) || torrentData[0] 
                : torrentData;

            if (torrentObj && Array.isArray(torrentObj.files) && torrentObj.files.length > 0) {
                const videoFiles = torrentObj.files.filter(f => 
                    /\.(mkv|mp4|avi|mov|m2ts|ts|flv|webm)$/i.test(f.name)
                );
                
                const candidateList = videoFiles.length > 0 ? videoFiles : torrentObj.files;
                candidateList.sort((a, b) => b.size - a.size);
                
                targetFileId = candidateList[0].id;
                console.log(`🎯 Identified main video file: "${candidateList[0].name}" (ID: ${targetFileId}, Size: ${formatBytes(candidateList[0].size)})`);
            }

            const torboxDlRes = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=${torboxTorrentId}&file_id=${targetFileId}&token=${config.torbox_key}`, {
                headers: { "Authorization": `Bearer ${config.torbox_key}` }
            });

            if (torboxDlRes.data && torboxDlRes.data.success && torboxDlRes.data.data) {
                console.log(`✅ Direct stream link generated. Redirecting player...\n`);
                return res.redirect(302, torboxDlRes.data.data);
            }
        }

        res.status(500).send("TorBox failed to process the nCore torrent.");
    } catch (err) {
        console.error("nCore Resolve Error:", err?.response?.data || err.message);
        res.status(500).send("Error resolving nCore stream.");
    }
});

app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>nCore + TorBox Setup</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style> body { background-color: #0f172a; } </style>
    </head>
    <body class="text-gray-200 min-h-screen flex items-center justify-center p-4">
        <div class="max-w-md w-full bg-slate-800 rounded-xl shadow-2xl p-6 sm:p-8 border border-slate-700">
            <h1 class="text-2xl font-bold text-white mb-2">nCore <span class="text-blue-500">+</span> TorBox</h1>
            <p class="text-slate-400 text-sm mb-6">Configure credentials to generate your personal nCore Nuvio addon link.</p>

            <form id="configForm" class="space-y-4">
                <div>
                    <label class="block text-sm font-medium text-slate-300 mb-1">nCore Username</label>
                    <input type="text" id="ncore_user" required class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white">
                </div>
                <div>
                    <label class="block text-sm font-medium text-slate-300 mb-1">nCore Password</label>
                    <input type="password" id="ncore_pass" required class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white">
                </div>
                <div>
                    <label class="block text-sm font-medium text-slate-300 mb-1">TorBox API Key</label>
                    <input type="password" id="torbox_key" required class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white">
                </div>
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2 rounded-lg transition mt-4">
                    Generate Install Link
                </button>
            </form>

            <div id="installSection" class="hidden mt-6 pt-6 border-t border-slate-700">
                <input type="text" id="manifestUrl" readonly class="w-full text-xs p-2 bg-slate-900 border border-slate-700 text-slate-300 rounded mb-3">
                <a id="installBtn" href="#" class="block w-full bg-green-600 text-white text-center font-bold py-3 rounded-lg">
                    Install to Stremio / Nuvio
                </a>
            </div>
        </div>

        <script>
            document.getElementById('configForm').addEventListener('submit', (e) => {
                e.preventDefault();
                const config = {
                    ncore_user: document.getElementById('ncore_user').value.trim(),
                    ncore_pass: document.getElementById('ncore_pass').value.trim(),
                    torbox_key: document.getElementById('torbox_key').value.trim()
                };
                const configString = encodeURIComponent(JSON.stringify(config));
                const host = window.location.host;
                const httpUrl = "http://" + host + "/" + configString + "/manifest.json";
                const stremioUrl = "stremio://" + host + "/" + configString + "/manifest.json";

                document.getElementById('manifestUrl').value = httpUrl;
                document.getElementById('installBtn').href = stremioUrl;
                document.getElementById('installSection').classList.remove('hidden');
            });
        </script>
    </body>
    </html>
    `);
});

const builder = new addonBuilder({
    id: "org.nuvio.ncore.torbox",
    version: "2.3.0",
    name: "nCore + TorBox",
    description: "Stream from nCore safely routed through TorBox with cache detection",
    catalogs: [],
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
});

builder.defineStreamHandler((args) => getStreamList(args.type, args.id, args.config, "127.0.0.1:7001"));

const addonInterface = builder.getInterface();

app.get("/manifest.json", (req, res) => res.json(addonInterface.manifest));
app.get("/:config/manifest.json", (req, res) => res.json(addonInterface.manifest));

app.get("/:config/stream/:type/:id", async (req, res) => {
    try {
        let parsedConfig;
        try { parsedConfig = JSON.parse(req.params.config); } 
        catch (e) { parsedConfig = JSON.parse(decodeURIComponent(req.params.config)); }
        
        const cleanId = req.params.id.replace(".json", "");
        const response = await getStreamList(req.params.type, cleanId, parsedConfig, req.headers.host);
        res.json(response);
    } catch (error) {
        console.error("Router error:", error.message);
        res.json({ streams: [] });
    }
});

app.listen(PORT, () => console.log(`nCore Addon active on http://127.0.0.1:${PORT}`));