const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 7000;

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.static(path.join(__dirname, "public")));

function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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

// New helper function to match exact episodes or season packs
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

async function getStreamList(type, id, config, host) {
    console.log(`\n--- Stream List Request for ${type} ---`);
    
    // Extract Season and Episode from the request ID
    const parts = id.split(':');
    const imdbId = parts[0]; 
    const season = parts[1] ? parseInt(parts[1], 10) : null;
    const episode = parts[2] ? parseInt(parts[2], 10) : null;
    
    console.log(`IMDb ID: ${imdbId} ${season ? `| Season ${season} Episode${episode}` : ''}`);
    const streams = [];

    if (!config || !config.fl_username || !config.fl_passkey || !config.torbox_key) {
        console.log("Error: Missing configuration variables.");
        return { streams: [] };
    }

    try {
        const apiUrl = `https://filelist.io/api.php?username=${encodeURIComponent(config.fl_username)}&passkey=${encodeURIComponent(config.fl_passkey)}&action=search-torrents&type=imdb&query=${imdbId}`;
        
        const apiRes = await axios.get(apiUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });

        let torrents = apiRes.data;

        if (!Array.isArray(torrents) || torrents.length === 0) {
            console.log(`No torrents found on Filelist API for IMDb ID ${imdbId}.`);
            return { streams: [] };
        }

        // Apply our filter to remove wrong episodes
        if (type === "series" && season !== null && episode !== null) {
            torrents = torrents.filter(t => isEpisodeMatch(t.name, season, episode));
            console.log(`Filtered down to ${torrents.length} matching episode/season releases.`);
        }

        const topTorrents = torrents.slice(0, 10);
        console.log(`Fetching torrent headers to extract infohashes for top results...`);

        const torrentsWithHashes = await Promise.all(
            topTorrents.map(async (t) => {
                try {
                    const dlUrl = `https://filelist.io/download.php?id=${t.id}&passkey=${config.fl_passkey}`;
                    const res = await axios.get(dlUrl, { 
                        responseType: 'arraybuffer',
                        timeout: 3000,
                        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
                    });
                    const calculatedHash = extractInfoHash(Buffer.from(res.data));
                    return { ...t, computedHash: calculatedHash };
                } catch (e) {
                    return { ...t, computedHash: null };
                }
            })
        );

        const hashList = torrentsWithHashes
            .map(t => t.computedHash)
            .filter(Boolean);

        console.log(`Extracted ${hashList.length} infohashes. Querying TorBox cache API...`);

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
            const sizeStr = formatBytes(torrent.size);
            const seeders = torrent.seeders || 0;
            const currentHash = torrent.computedHash ? torrent.computedHash.toLowerCase() : "";
            const isCached = currentHash && cachedHashes.has(currentHash);
            
            const statusTag = isCached ? "⚡ [CACHED]" : "⏳ [UNCACHED]";
            const providerName = isCached ? "FL + TorBox ⚡" : "FL + TorBox";

            const streamObj = {
                name: providerName,
                title: `${statusTag} ${torrent.name}\n💾 ${sizeStr} | 👤 ${seeders} seeds`,
                url: `http://${host}/resolve/${configEncoded}/${torrent.id}`
            };

            if (isCached) {
                cachedStreams.push(streamObj);
            } else {
                uncachedStreams.push(streamObj);
            }
        }

        streams.push(...cachedStreams, ...uncachedStreams);

    } catch (error) {
        console.error("Filelist API Error:", error?.response?.data || error.message);
    }

    console.log(`Returned ${streams.length} stream options to Nuvio.\n`);
    return { streams };
}

app.get("/resolve/:config/:torrentId", async (req, res) => {
    try {
        let config = JSON.parse(decodeURIComponent(req.params.config));
        const torrentId = req.params.torrentId;

        console.log(`\n▶️ Stream selected! Processing Filelist Torrent ID: ${torrentId}`);

        const filelistTorrentUrl = `https://filelist.io/download.php?id=${torrentId}&passkey=${config.fl_passkey}`;
        
        const torrentBufferRes = await axios.get(filelistTorrentUrl, { 
            responseType: 'arraybuffer',
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });

        const buffer = Buffer.from(torrentBufferRes.data);

        const form = new FormData();
        form.append("file", buffer, { filename: `${torrentId}.torrent`, contentType: "application/x-bittorrent