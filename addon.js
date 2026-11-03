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

async function getStreamList(type, id, config, host) {
    console.log(`\n--- Stream List Request for ${type} ---`);
    const imdbId = id.split(':')[0]; 
    console.log(`IMDb ID: ${imdbId}`);
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

        const torrents = apiRes.data;

        if (!Array.isArray(torrents) || torrents.length === 0) {
            console.log(`No torrents found on Filelist API for IMDb ID ${imdbId}.`);
            return { streams: [] };
        }

        const topTorrents = torrents.slice(0, 10);
        console.log(`Found ${torrents.length} releases on Filelist. Fetching torrent headers to extract infohashes...`);

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
        form.append("file", buffer, { filename: `${torrentId}.torrent`, contentType: "application/x-bittorrent" });
        form.append("seed", "2");

        const torboxAddRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", form, {
            headers: { ...form.getHeaders(), "Authorization": `Bearer ${config.torbox_key}` }
        });

        if (torboxAddRes.data && torboxAddRes.data.success) {
            const torboxTorrentId = torboxAddRes.data.data.torrent_id;

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

        res.status(500).send("TorBox failed to process the torrent.");
    } catch (err) {
        console.error("Resolve Error:", err?.response?.data || err.message);
        res.status(500).send("Error resolving stream.");
    }
});

const builder = new addonBuilder({
    id: "org.nuvio.filelist.torbox",
    version: "2.7.1",
    name: "Filelist + TorBox",
    description: "Stream from Filelist safely routed through TorBox",
    catalogs: [],
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
});

builder.defineStreamHandler((args) => getStreamList(args.type, args.id, args.config, "127.0.0.1:7000"));

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

app.listen(PORT, () => console.log(`Web UI and Addon active on http://127.0.0.1:${PORT}`));